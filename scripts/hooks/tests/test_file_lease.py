"""file-lease.py tests: G-02/G-03/G-04/G-05/G-10 replays, main-session takeover,
lease expiry, dead pid, SubagentStop/SessionEnd release, exemptions (incl.
pure-append ledgers), kill switch, fail-open on a corrupt db, SessionStart
report-once, the size:mtime fingerprint for big files, the owner-only kill
switch + lease store (tamper denies, kill-switch use logged), parent -> child
lease hand-over, the 60 s unconfirmed-lease expiry, quote-aware Bash targets,
and the negative-control seam: FILE_LEASE_NEGATIVE_CONTROL=1 flips the guard off
for the whole suite so every deny/warn assertion below fails (suite must exit
non-zero). The switch file only ever lives in a pytest tmp dir (FILE_LEASE_SWITCH
seam), never in the real hooks directory."""
import importlib.util
import json
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from conftest import HOOKS_DIR, run_hook  # noqa: E402

HOOK = "file-lease.py"
REAL_SWITCH = os.path.join(HOOKS_DIR, "FILE_LEASE_DISABLED")


@pytest.fixture(scope="session", autouse=True)
def switch_path(tmp_path_factory):
    """The kill-switch path for the whole suite: a tmp file, never the real hooks dir."""
    path = str(tmp_path_factory.mktemp("lease-switch") / "FILE_LEASE_DISABLED")
    old = os.environ.get("FILE_LEASE_SWITCH")
    os.environ["FILE_LEASE_SWITCH"] = path
    if os.environ.get("FILE_LEASE_NEGATIVE_CONTROL") == "1":
        open(path, "w").close()
    try:
        yield path
    finally:
        if os.path.exists(path):
            os.unlink(path)
        if old is None:
            os.environ.pop("FILE_LEASE_SWITCH", None)
        else:
            os.environ["FILE_LEASE_SWITCH"] = old


@pytest.fixture()
def env(tmp_path, monkeypatch):
    os.makedirs(str(tmp_path / "store"), exist_ok=True)
    monkeypatch.setenv("FILE_LEASE_DB", str(tmp_path / "store" / "leases.db"))
    monkeypatch.setenv("FILE_LEASE_LOG", str(tmp_path / "file-lease.log"))
    # pytest tmp dirs live under TMPDIR=/var/tmp/claude (an exempt prefix):
    # drop /tmp + /var/tmp so the files under test count as live paths.
    monkeypatch.setenv("FILE_LEASE_EXEMPT", os.pathsep.join(
        ("/run", "/dev", "/proc", "~/.claude/projects")))
    monkeypatch.delenv("FILE_LEASE", raising=False)

    class Env:
        db = str(tmp_path / "store" / "leases.db")
        cwd = str(tmp_path)

        def payload(self, event, tool, tool_input, sid="S1", agent=None):
            p = {"hook_event_name": event, "session_id": sid, "tool_name": tool,
                 "tool_input": tool_input, "cwd": self.cwd}
            if agent:
                p["agent_id"] = agent
            return p

        def pre(self, tool, tool_input, sid="S1", agent=None):
            return run_hook(HOOK, self.payload("PreToolUse", tool, tool_input, sid, agent))

        def post(self, tool, tool_input, sid="S1", agent=None):
            return run_hook(HOOK, self.payload("PostToolUse", tool, tool_input, sid, agent))

        def event(self, name, sid="S1", agent=None):
            return run_hook(HOOK, self.payload(name, "", {}, sid, agent))

        def edit(self, path, sid="S1", agent=None):
            return self.pre("Edit", {"file_path": str(path), "old_string": "a",
                                     "new_string": "b"}, sid, agent)

        def write_cycle(self, path, content, sid="S1", agent=None):
            """One full write: file content on disk, then pre + post hooks."""
            with open(path, "w") as fh:
                fh.write(content)
            rc, out, err = self.pre("Edit", {"file_path": str(path)}, sid=sid, agent=agent)
            assert rc == 0 and out == "" and err == "", (out, err)
            rc, out, err = self.post("Edit", {"file_path": str(path)}, sid=sid, agent=agent)
            assert rc == 0 and out == "" and err == "", (out, err)

        def con(self):
            return sqlite3.connect(self.db)

        def lease(self, path):
            with contextlib_closing(self.con()) as con:
                row = con.execute(
                    "SELECT holder_session, holder_agent, holder_pid, holder_ts, "
                    "writer_session, writer_agent FROM lease WHERE path=?", (str(path),)).fetchone()
            return dict(zip(("holder_session", "holder_agent", "holder_pid", "holder_ts",
                             "writer_session", "writer_agent"), row)) if row else None

        def age_holder(self, path, seconds=9999):
            with contextlib_closing(self.con()) as con, con:
                con.execute("UPDATE lease SET holder_ts = holder_ts - ? WHERE path=?",
                            (seconds, str(path)))

        def age_seen(self, sid, agent, seconds=9999):
            with contextlib_closing(self.con()) as con, con:
                con.execute("UPDATE seen SET at = at - ? WHERE session_id=? AND agent_id=?",
                            (seconds, sid, agent))

        def kill_holder(self, path, pid=999999999):
            with contextlib_closing(self.con()) as con, con:
                con.execute("UPDATE lease SET holder_pid=?, holder_pid_start=NULL WHERE path=?",
                            (pid, str(path)))

    return Env()


class contextlib_closing:
    def __init__(self, obj):
        self.obj = obj

    def __enter__(self):
        return self.obj

    def __exit__(self, *exc):
        self.obj.close()


def decision(out):
    assert out.strip(), "hook printed nothing"
    return json.loads(out)["hookSpecificOutput"]


def denied(out):
    hso = decision(out)
    assert hso["permissionDecision"] == "deny"
    return hso["permissionDecisionReason"]


# ------------------------------------------------ lease: another live actor (a)
def test_sibling_denied_while_lease_held(env, tmp_path):  # G-03
    f = tmp_path / "build.py"
    env.write_cycle(f, "v1", sid="S1", agent="agentA")
    rc, out, err = env.edit(f, sid="S1", agent="agentB")
    assert rc == 0, err
    reason = denied(out)
    assert "holds its lease" in reason and "S1" in reason and "agentA" in reason
    assert "Read the file again" in reason


def test_twin_sessions_denied(env, tmp_path):  # G-05
    f = tmp_path / "audit.md"
    env.write_cycle(f, "s1 work", sid="SA")
    rc, out, err = env.edit(f, sid="SB")
    assert rc == 0, err
    assert "SA" in denied(out) and "main" in denied(out)


def test_cross_session_bash_sed_i_denied(env, tmp_path):
    f = tmp_path / "config.py"
    env.write_cycle(f, "x = 1", sid="S1")
    cmd = "sed -i 's/x = 1/x = 2/' %s" % f
    rc, out, err = env.pre("Bash", {"command": cmd}, sid="S2")
    assert rc == 0, err
    assert "S1" in denied(out)


def test_bash_redirect_takes_lease(env, tmp_path):
    f = tmp_path / "out.txt"
    f.write_text("hello")
    rc, out, err = env.pre("Bash", {"command": "echo new > %s" % f}, sid="S1")
    assert rc == 0 and out == "", (out, err)
    assert env.lease(f)["holder_agent"] == "main"


def test_multiple_targets_atomic(env, tmp_path):
    f1, f2 = tmp_path / "a.py", tmp_path / "b.py"
    env.write_cycle(f2, "held", sid="S1", agent="agentA")
    rc, out, err = env.pre("Bash", {"command": "cp %s %s" % (f1, f2)}, sid="S2")
    assert rc == 0, err
    denied(out)  # f2 conflict denies the whole command


# ----------------------------------------------- stale content: check (b)
def test_stale_content_denied_after_foreign_write(env, tmp_path):  # G-04
    f = tmp_path / "test_ind.py"
    f.write_text("base")
    env.post("Read", {"file_path": str(f)}, sid="S1", agent="agentB")
    env.write_cycle(f, "changed by A", sid="S1", agent="agentA")
    env.age_holder(f)  # isolate (b): the lease itself no longer blocks
    rc, out, err = env.edit(f, sid="S1", agent="agentB")
    assert rc == 0, err
    reason = denied(out)
    assert "changed since you last saw it" in reason and "agentA" in reason


def test_fresh_read_clears_stale(env, tmp_path):
    f = tmp_path / "test_ind2.py"
    env.write_cycle(f, "v1", sid="S1", agent="agentA")
    env.age_holder(f)
    env.post("Read", {"file_path": str(f)}, sid="S1", agent="agentB")
    rc, out, err = env.edit(f, sid="S1", agent="agentB")
    assert rc == 0 and out == "", (out, err)


def test_g10_stale_overwrite_after_foreign_append_denied(env, tmp_path):  # G-10 / G-11
    """Holder A wrote the ledger; sibling B and main append (allowed, recorded as
    last writer); A's full overwrite from its stale view must be denied even
    though A still holds the lease — the Bash path has no built-in stale check."""
    f = tmp_path / "progress-voice-gateway.md"
    env.write_cycle(f, "WO-H part 1\n", sid="S0C", agent="a44991a0")
    for who in ("a07438723f", None):  # sibling append, then main's OWNER RULING append
        cmd = "cat >> %s <<'EOF'\nappended\nEOF" % f
        rc, out, err = env.pre("Bash", {"command": cmd}, sid="S0C", agent=who)
        assert rc == 0 and out == "", (out, err)
        with open(f, "a") as fh:
            fh.write("appended by %s\n" % (who or "main"))
        rc, out, err = env.post("Bash", {"command": cmd}, sid="S0C", agent=who)
        assert rc == 0 and out == "", (out, err)
    rc, out, err = env.pre("Bash", {"command": "cat > %s <<'EOF'\nstale\nEOF" % f},
                           sid="S0C", agent="a44991a0")
    assert rc == 0, err
    reason = denied(out)
    assert "changed since you last saw it" in reason and "S0C" in reason and "main" in reason


def test_fingerprint_cap(tmp_path):
    import importlib.util
    spec = importlib.util.spec_from_file_location("fl_cap", os.path.join(HOOKS_DIR, HOOK))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    f = tmp_path / "big.bin"
    f.write_bytes(b"0" * 4096)
    mod.HASH_MAX_BYTES = 16  # force the fp: branch
    assert mod.fingerprint(str(f)).startswith("fp:")
    mod.HASH_MAX_BYTES = 1 << 20
    assert len(mod.fingerprint(str(f))) == 64  # real sha256


# ------------------------------------------------ takeover, expiry, release
def test_main_takes_over_subagent_lease_with_warning(env, tmp_path):
    f = tmp_path / "audit.py"
    env.write_cycle(f, "v1", sid="S1", agent="agentA")
    env.post("Read", {"file_path": str(f)}, sid="S1")  # main saw current content
    rc, out, err = env.edit(f, sid="S1")
    assert rc == 0, err
    hso = decision(out)
    assert "permissionDecision" not in hso  # warn only, never auto-approve
    assert "took over the lease" in hso["additionalContext"]
    assert env.lease(f)["holder_agent"] == "main"


def test_takeover_blocked_when_main_content_stale(env, tmp_path):
    f = tmp_path / "audit2.py"
    env.write_cycle(f, "v1", sid="S1", agent="agentA")
    env.post("Read", {"file_path": str(f)}, sid="S1")
    env.write_cycle(f, "v2 by sub", sid="S1", agent="agentA")
    rc, out, err = env.edit(f, sid="S1")
    assert rc == 0, err
    assert "changed since you last saw it" in denied(out)


def test_lease_expiry_allows_other_actor(env, tmp_path):
    f = tmp_path / "slow.py"
    env.write_cycle(f, "v1", sid="S1", agent="agentA")
    env.age_holder(f)  # lease expired; agentA still active elsewhere -> silent hand-over
    rc, out, err = env.edit(f, sid="S2")
    assert rc == 0 and out == "", (out, err)
    assert env.lease(f)["holder_session"] == "S2"


def test_subagent_stop_releases_lease(env, tmp_path):
    f = tmp_path / "done.py"
    env.write_cycle(f, "v1", sid="S1", agent="agentA")
    rc, out, err = env.event("SubagentStop", sid="S1", agent="agentA")
    assert rc == 0 and out == "", (out, err)
    assert env.lease(f)["holder_session"] is None
    rc, out, err = env.edit(f, sid="S2")
    assert rc == 0 and out == "", (out, err)


def test_session_end_releases_main_leases_only(env, tmp_path):
    f1, f2, f3 = tmp_path / "one.py", tmp_path / "two.py", tmp_path / "sub.py"
    env.write_cycle(f1, "1", sid="S1")
    env.write_cycle(f2, "2", sid="S1")
    env.write_cycle(f3, "3", sid="S1", agent="agentA")
    rc, out, err = env.event("SessionEnd", sid="S1")  # main thread: no agent_id
    assert rc == 0 and out == "", (out, err)
    assert env.lease(f1)["holder_session"] is None
    assert env.lease(f2)["holder_session"] is None
    assert env.lease(f3)["holder_agent"] == "agentA"  # a live subagent keeps its lease
    rc, out, err = env.edit(f1, sid="S2")
    assert rc == 0 and out == "", (out, err)


def test_dead_agent_takeover_warns_and_records(env, tmp_path):  # G-02
    f = tmp_path / "audit_trades.py"
    env.write_cycle(f, "partial edit", sid="S2C", agent="a8b1c01b")
    env.kill_holder(f)
    rc, out, err = env.edit(f, sid="S79C")
    assert rc == 0, err
    hso = decision(out)
    assert "permissionDecision" not in hso
    assert "half-applied" in hso["additionalContext"]
    with env.con() as con:
        rows = con.execute("SELECT session_id, agent_id, reported FROM half_applied").fetchall()
    assert ("S2C", "a8b1c01b", 0) in rows
    rc, out2, err2 = run_hook(HOOK, {"hook_event_name": "SessionStart", "source": "startup",
                                     "session_id": "S79C", "cwd": env.cwd})
    assert rc == 0, err2
    assert "possibly half-applied by S2C/a8b1c01b at" in json.loads(out2)["hookSpecificOutput"]["additionalContext"]


def test_session_start_reports_dead_holder_once(env, tmp_path):
    f = tmp_path / "fee_book.cpp"
    env.write_cycle(f, "half edit", sid="S66", agent="ab3f8d09")
    env.kill_holder(f)
    rc, out, err = run_hook(HOOK, {"hook_event_name": "SessionStart", "source": "startup",
                                   "session_id": "SNEW", "cwd": env.cwd})
    assert rc == 0, err
    ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
    assert "possibly half-applied by S66/ab3f8d09 at" in ctx and str(f) in ctx
    rc, out, err = run_hook(HOOK, {"hook_event_name": "SessionStart", "source": "startup",
                                   "session_id": "SNEW2", "cwd": env.cwd})
    assert rc == 0 and out == "", out  # reported once


def test_session_start_alive_main_never_reported(env, tmp_path):
    f = tmp_path / "live.cpp"
    env.write_cycle(f, "wip", sid="S1")
    env.age_holder(f)  # expired but the holder process (pytest) is alive
    rc, out, err = run_hook(HOOK, {"hook_event_name": "SessionStart", "source": "startup",
                                   "session_id": "SNEW", "cwd": env.cwd})
    assert rc == 0 and out == "", (out, err)


def test_session_start_expired_subagent_without_activity_reported(env, tmp_path):
    f = tmp_path / "gone.py"
    env.write_cycle(f, "v", sid="S1", agent="agentZ")
    env.age_holder(f)
    env.age_seen("S1", "agentZ")
    rc, out, err = run_hook(HOOK, {"hook_event_name": "SessionStart", "source": "startup",
                                   "session_id": "SNEW", "cwd": env.cwd})
    assert rc == 0, err
    assert "agentZ" in json.loads(out)["hookSpecificOutput"]["additionalContext"]


def test_session_start_caps_at_20_lines(env, tmp_path):
    for i in range(25):
        f = tmp_path / ("f%d.py" % i)
        env.write_cycle(f, "x", sid="S66", agent="a%d" % i)
        env.kill_holder(f)
    rc, out, err = run_hook(HOOK, {"hook_event_name": "SessionStart", "source": "startup",
                                   "session_id": "SNEW", "cwd": env.cwd})
    assert rc == 0, err
    ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
    assert ctx.count("possibly half-applied") == 20
    assert "and 5 more" in ctx


# --------------------------------------------------------------- G-10 appends
def test_pure_append_exempt_and_records_writer(env, tmp_path):
    f = tmp_path / "progress.md"
    env.write_cycle(f, "step 1", sid="S1", agent="agentA")
    rc, out, err = env.pre("Bash", {"command": "echo 'step 2' >> %s" % f}, sid="S1", agent="agentB")
    assert rc == 0 and out == "", (out, err)
    with open(f, "a") as fh:
        fh.write("step 3\n")
    rc, out, err = env.post("Bash", {"command": "echo 'step 3' >> %s" % f}, sid="S1", agent="agentB")
    assert rc == 0 and out == "", (out, err)
    lease = env.lease(f)
    assert lease["holder_agent"] == "agentA"  # untouched by the appends
    assert lease["writer_agent"] == "agentB"  # but recorded as last writer


def test_append_with_stderr_dup_still_pure(env, tmp_path):
    f = tmp_path / "LEDGER.md"
    env.write_cycle(f, "l1", sid="S1", agent="agentA")
    rc, out, err = env.pre("Bash", {"command": "echo 'l2' >> %s 2>&1" % f}, sid="S2")
    assert rc == 0 and out == "", (out, err)


def test_tee_a_pure_plain_tee_not(env, tmp_path):
    f = tmp_path / "log.jsonl"
    env.write_cycle(f, "{}", sid="S1", agent="agentA")
    rc, out, err = env.pre("Bash", {"command": "printf 'x' | tee -a %s" % f}, sid="S2")
    assert rc == 0 and out == "", (out, err)
    rc, out, err = env.pre("Bash", {"command": "printf 'x' | tee %s" % f}, sid="S2")
    assert rc == 0, err
    denied(out)


def test_overwrite_redirect_not_exempt(env, tmp_path):
    f = tmp_path / "notes.md"
    env.write_cycle(f, "keep", sid="S1", agent="agentA")
    rc, out, err = env.pre("Bash", {"command": "echo replace > %s" % f}, sid="S2")
    assert rc == 0, err
    assert "agentA" in denied(out)


def test_append_to_code_file_not_exempt(env, tmp_path):
    f = tmp_path / "app.py"
    env.write_cycle(f, "code", sid="S1", agent="agentA")
    rc, out, err = env.pre("Bash", {"command": "echo 'x' >> %s" % f}, sid="S2")
    assert rc == 0, err
    assert "agentA" in denied(out)


# ----------------------------------------------------------------- exemptions
def test_exempt_paths_never_leased(env, tmp_path, monkeypatch):
    monkeypatch.delenv("FILE_LEASE_EXEMPT")  # production defaults
    exempt = [
        "/tmp/scratch.txt",
        "/var/tmp/claude/probe.py",
        "/run/lock/x",
        "/dev/null",
        "/proc/sys/x",
        os.path.expanduser("~/.claude/projects/session.jsonl"),
        "${AI_SETUP_ROOT}/.claude/worktrees/ai-setup-fixes-20261010/agents/scripts/hooks/file-lease.py",
    ]  # the lease db itself is owner-only now: see test_tamper_bash_denied
    for p in exempt:
        rc, out, err = env.pre("Bash", {"command": "echo data > %s" % p}, sid="S1")
        assert rc == 0 and out == "", (p, out, err)
    # exempt-only calls never even open the store
    assert not os.path.exists(env.db)


def test_unresolvable_tokens_skipped(env, tmp_path):
    for cmd in ("echo hi > $DIR/out.txt", "echo hi > /tmp/d/*.txt",
                "cat f", "grep -n x /etc/hosts", "python3 -I -c 'print(1)'",
                "cd /etc && echo x > hosts"):
        rc, out, err = env.pre("Bash", {"command": cmd}, sid="S1")
        assert rc == 0 and out == "", (cmd, out, err)


def test_relative_path_resolved_from_cwd(env, tmp_path):
    f = tmp_path / "rel.txt"
    f.write_text("rel")
    rc, out, err = env.pre("Bash", {"command": "echo abs > rel.txt"}, sid="S1")
    assert rc == 0 and out == "", (out, err)
    assert env.lease(f) is not None


def test_directory_target_skipped(env, tmp_path):
    rc, out, err = env.pre("Bash", {"command": "echo x > %s" % tmp_path}, sid="S1")
    assert rc == 0 and out == "", (out, err)


# ---------------------------------------------------- kill switch / fail-open
def test_kill_switch_disables_guard(env, tmp_path, switch_path):
    f = tmp_path / "guarded.py"
    env.write_cycle(f, "v1", sid="S1", agent="agentA")
    created = not os.path.exists(switch_path)  # already present in negative-control mode
    open(switch_path, "w").close()
    try:
        rc, out, err = env.edit(f, sid="S2")
        assert rc == 0 and out == "", (out, err)
    finally:
        if created:
            os.unlink(switch_path)
    with open(tmp_path / "file-lease.log", encoding="utf-8") as fh:
        assert "KILL-SWITCH file event=PreToolUse tool=Edit session=S2" in fh.read()
    assert not os.path.exists(REAL_SWITCH)


def test_fail_open_on_corrupt_db(env, tmp_path):
    with open(env.db, "wb") as fh:
        fh.write(b"this is not a sqlite database at all")
    f = tmp_path / "x.py"
    rc, out, err = env.edit(f, sid="S1")
    assert rc == 0 and out == "" and err == "", (out, err)
    with open(tmp_path / "file-lease.log", encoding="utf-8") as fh:
        assert "FAIL-OPEN" in fh.read()


def test_non_json_input_fails_open(env):
    import subprocess
    proc = subprocess.run([sys.executable, os.path.join(HOOKS_DIR, HOOK)],
                          input=b"not json", capture_output=True, timeout=10)
    assert proc.returncode == 0 and proc.stdout == b"", proc.stdout


def test_kill_switch_via_env(env, tmp_path, monkeypatch):
    f = tmp_path / "guarded2.py"
    env.write_cycle(f, "v1", sid="S1", agent="agentA")
    monkeypatch.setenv("FILE_LEASE", "off")
    rc, out, err = env.edit(f, sid="S2")
    assert rc == 0 and out == "", (out, err)


def test_env_kill_switch_use_is_logged_without_command_text(env, tmp_path, monkeypatch):
    f = tmp_path / "guarded3.py"
    monkeypatch.setenv("FILE_LEASE", "off")
    assert env.edit(f, sid="S9", agent="agentQ")[1] == ""
    assert env.pre("Bash", {"command": "echo MARK%s > %s" % ("ER" * 2, f)}, sid="S9")[1] == ""
    with open(tmp_path / "file-lease.log", encoding="utf-8") as fh:
        log = fh.read()
    assert log.count("KILL-SWITCH env FILE_LEASE=off") == 2
    assert "agent=agentQ path=%s" % f in log and "tool=Bash session=S9 agent=main" in log
    assert "MARKER" not in log  # the Bash command text is never logged


def test_docstring_says_owner_only_and_names_no_switch():
    spec = importlib.util.spec_from_file_location("fl_doc", os.path.join(HOOKS_DIR, HOOK))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert "Owner-only kill switch" in mod.__doc__
    assert "FILE_LEASE_DISABLED" not in mod.__doc__ and "FILE_LEASE=off" not in mod.__doc__


# ------------------------------------- owner-only kill switch and lease store (tamper)
def _tamper_cmds(sw, db):
    d = os.path.dirname(db)
    return [
        "touch %s" % sw, ": > %s" % sw, "echo 1 > %s" % sw, "cp /dev/null %s" % sw,
        "ln -sf /dev/null %s" % sw, "mv /tmp/x %s" % sw, "install -m 600 /dev/null %s" % sw,
        "mkdir -p %s" % sw, "sudo -n touch %s" % sw, "bash -c 'touch %s'" % sw,
        "touch \"$HOOKS/FILE_LEASE_DISABLED\"", "cd %s && touch FILE_LEASE_DISABLED" % os.path.dirname(sw),
        "cp /tmp/FILE_LEASE_DISABLED %s/" % HOOKS_DIR, "echo \"$(touch %s)\"" % sw,
        "echo `touch %s`" % sw, "printf x | tee %s" % sw, "dd if=/dev/null of=%s" % sw,
        "touch %s" % REAL_SWITCH, "touch ${AI_SETUP_ROOT}/scripts/hooks/FILE_LEASE_DISABLED",
        "python3 -c \"open('%s', 'w').close()\"" % sw,
        "python3 -c \"import pathlib; pathlib.Path('%s').touch()\"" % sw,
        "node -e \"require('fs').writeFileSync('%s', '')\"" % sw,
        "rm -f %s" % db, "rm -f %s-wal" % db, "rm -rf %s" % d, "rm -rf %s" % os.path.dirname(d),
        "echo x > %s" % db, "cp /tmp/empty.db %s" % db, "truncate -s 0 %s" % db,
        "chmod 000 %s" % db, "mv %s /tmp/old.db" % db, "mv %s /tmp/old-store" % d,
        "find %s -delete" % d, "find %s -name '*.db' -exec rm {} +" % d,
        "ls %s/* | xargs rm -f" % d, "cd %s && rm leases.db" % d, "rm \"$STORE/leases.db\"",
        "rm %s/lease*" % d, "sqlite3 %s 'DELETE FROM lease'" % db,
        "sqlite3 %s \"UPDATE lease SET holder_session=NULL\"" % db, "sqlite3 %s" % db,
        "sqlite3 %s < /tmp/fix.sql" % db, "echo 'delete from lease;' | sqlite3 %s" % db,
        "sqlite3 -cmd 'delete from lease' %s 'select 1'" % db, "sqlite3 %s '.read /tmp/x.sql'" % db,
        "sqlite3 %s 'select 1; delete from seen'" % db,
        "python3 -c \"import sqlite3; sqlite3.connect('%s').execute('delete from lease')\"" % db,
        "python3 - <<'EOF'\nimport sqlite3\nsqlite3.connect('%s').execute('delete from lease')\nEOF" % db,
        "rm -f /var/tmp/claude/leases/leases.db",
    ]


TAMPER_IDS = [c.replace("\n", "\\n")[:48] for c in _tamper_cmds("/s/FILE_LEASE_DISABLED", "/d/leases.db")]


@pytest.mark.parametrize("idx", range(len(TAMPER_IDS)), ids=TAMPER_IDS)
def test_tamper_bash_denied(env, switch_path, idx):
    cmd = _tamper_cmds(switch_path, env.db)[idx]
    rc, out, err = env.pre("Bash", {"command": cmd}, sid="S1", agent="agentA")
    assert rc == 0, err
    reason = denied(out)
    assert "owner-only" in reason and switch_path not in reason and env.db not in reason
    assert not os.path.exists(switch_path) or os.environ.get("FILE_LEASE_NEGATIVE_CONTROL") == "1"


def _benign_cmds(sw, db, tmp):
    d = os.path.dirname(db)
    return [
        "ls -la %s" % d, "stat %s" % db, "cat %s" % os.path.join(tmp, "file-lease.log"),
        "sqlite3 %s 'SELECT COUNT(*) FROM lease'" % db, "sqlite3 -readonly %s 'select * from seen'" % db,
        "sqlite3 'file:%s?mode=ro' 'select 1'" % db, "sqlite3 %s .tables" % db,
        "sqlite3 %s 'PRAGMA user_version'" % db, "sqlite3 -header %s 'select path from lease; select 1'" % db,
        "python3 -c \"import sqlite3; c = sqlite3.connect('file:%s?mode=ro', uri=True); "
        "print(c.execute('select 1').fetchall())\"" % db,
        "cp %s %s" % (db, os.path.join(tmp, "backup.db")),
        "grep -n FILE_LEASE_DISABLED %s" % os.path.join(HOOKS_DIR, HOOK),
        "test -e %s && echo on" % sw, "touch %s" % os.path.join(tmp, "other.txt"),
        "rm -rf %s" % os.path.join(tmp, "scratch"), "mkdir -p %s" % os.path.join(tmp, "newdir"),
        "echo 'notes about FILE_LEASE_DISABLED' >> %s" % os.path.join(tmp, "notes.md"),
        "jq '.[] | select(.n >= 2)' data.json", "find %s -name '*.py' -newer x" % tmp,
        "python3 -m pytest -q tests/test_file_lease.py",
    ]


BENIGN_IDS = [c[:48] for c in _benign_cmds("/s/FILE_LEASE_DISABLED", "/d/leases.db", "/t")]


@pytest.mark.parametrize("idx", range(len(BENIGN_IDS)), ids=BENIGN_IDS)
def test_tamper_allow_controls(env, tmp_path, switch_path, idx):
    cmd = _benign_cmds(switch_path, env.db, str(tmp_path))[idx]
    rc, out, err = env.pre("Bash", {"command": cmd}, sid="S1", agent="agentA")
    assert rc == 0 and out == "", (cmd, out, err)


@pytest.mark.parametrize("tool", ["Edit", "Write", "MultiEdit", "NotebookEdit"])
def test_tamper_edit_tools_denied(env, switch_path, tool):
    key = "notebook_path" if tool == "NotebookEdit" else "file_path"
    for target in (switch_path, env.db, env.db + "-wal", REAL_SWITCH):
        rc, out, err = env.pre(tool, {key: target, "content": "x"})
        assert rc == 0, err
        assert "owner-only" in denied(out), target


def test_tamper_denied_even_with_env_kill_switch(env, tmp_path, switch_path, monkeypatch):
    # a nested `FILE_LEASE=off` process must not be able to flip the global switch or the store
    monkeypatch.setenv("FILE_LEASE", "off")
    assert "owner-only" in denied(env.pre("Bash", {"command": "touch %s" % switch_path})[1])
    assert "owner-only" in denied(env.pre("Bash", {"command": "sqlite3 %s 'delete from lease'" % env.db})[1])
    with open(tmp_path / "file-lease.log", encoding="utf-8") as fh:
        assert fh.read().count("TAMPER-DENY event=PreToolUse tool=Bash") == 2


# ------------- interpreter code that mentions the store: denied only when it can write it (D2)
def _interp_read_cmds(sw, db, tmp):
    d = os.path.dirname(db)
    return [
        "python3 -c \"import os; print(os.path.getsize('%s'))\"" % db,
        "python3 -c \"print(open('%s', 'rb').read(16))\"" % db,
        "python3 -c \"import sys; sys.stdout.write('%s\\n')\"" % db,
        "python3 -c \"p = '%s'; print(p.replace('.db', '.bak'))\"" % db,
        "python3 -c \"import sqlite3; c = sqlite3.connect('file:%s?mode=ro', uri=True); "
        "print(c.execute('select count(*) from lease').fetchone())\"" % db,
        "python3 -c \"import json; d = open('%s', 'rb').read(); open('%s', 'w').write(str(len(d)))\""
        % (db, os.path.join(tmp, "out.txt")),
        "node -e \"const fs = require('fs'); console.log(fs.readFileSync('%s').length)\"" % db,
        "node -e \"console.log(require('fs').statSync('%s').size)\"" % db,
        "python3 - <<'EOF'\nimport os\nfor n in os.listdir('%s'):\n    print(n, os.path.getsize(os.path.join('%s', n)))\nEOF"
        % (d, d),
        "python3 - <<'EOF'\nprint('the lease store lives at %s; do not remove it')\nEOF\nrm -f %s"
        % (db, os.path.join(tmp, "scratch.txt")),
        "cat %s/README 2>/dev/null; python3 -c \"import os; os.remove('%s')\"" % (d, os.path.join(tmp, "x.tmp")),
        "python3 -c \"import shutil; print(shutil.which('sqlite3'), '%s')\"" % db,
        "python3 -c \"import os; os.makedirs('%s', exist_ok=True); print('%s')\"" % (os.path.join(tmp, "out"), db),
        "perl -ne 'print if /lease/' %s/notes.txt" % d,
        "python3 -c \"from pathlib import Path; Path('%s').write_text(str(Path('%s').stat().st_size))\""
        % (os.path.join(tmp, "r.txt"), db),
        "python3 -c \"import os; fd = os.open('%s', os.O_RDONLY); print(os.read(fd, 16))\"" % db,
        "grep -c lease %s 2>/dev/null; python3 -c \"print(1 if 2 > 0 else 0)\"" % sw,
        "python3 -c \"import os; os.system('ls -la %s')\"" % d,
        "python3 -c \"import subprocess; print(subprocess.run(['sqlite3', '-readonly', '%s', 'select 1'], "
        "capture_output=True, text=True).stdout)\"" % db,
        "python3 -c \"import copy; x = copy.copy({'p': '%s'}); print(x)\"" % db,
        "node -e \"const fs = require('fs'); fs.writeFileSync('%s', String(fs.statSync('%s').size))\""
        % (os.path.join(tmp, "n.txt"), db),
        "python3 -c \"import os; os.remove('%s'); print(os.path.exists('%s'))\"" % (os.path.join(tmp, "x"), db),
        "ruby -e 'puts File.size(\"%s\")'" % db,
        "php -r 'echo filesize(\"%s\");'" % db,
    ]


INTERP_READ_IDS = [c.replace("\n", "\\n")[:48] for c in _interp_read_cmds("/s/FILE_LEASE_DISABLED", "/d/leases.db", "/t")]


@pytest.mark.parametrize("idx", range(len(INTERP_READ_IDS)), ids=INTERP_READ_IDS)
def test_interpreter_read_only_mention_allowed(env, tmp_path, switch_path, idx):
    cmd = _interp_read_cmds(switch_path, env.db, str(tmp_path))[idx]
    rc, out, err = env.pre("Bash", {"command": cmd}, sid="S1", agent="agentA")
    assert rc == 0 and out == "", (cmd, out, err)


def _interp_write_cmds(db):
    d = os.path.dirname(db)
    return [
        "python3 -c \"import os; os.remove('%s')\"" % db,
        "python3 -c \"import shutil; shutil.copy('/tmp/empty.db', '%s')\"" % db,
        "python3 -c \"open('%s', 'a').write('x')\"" % db,
        "python3 -c \"open('%s', mode='w')\"" % db,
        "python3 -c \"import os; os.system('rm -f %s')\"" % db,
        "python3 -c \"import subprocess; subprocess.run(['rm', '-f', '%s'])\"" % db,
        "python3 -c \"from pathlib import Path; Path('%s').unlink()\"" % db,
        "python3 -c \"import pathlib; pathlib.Path('%s').open('w')\"" % db,
        "python3 -c \"import os; os.replace('/tmp/x', '%s')\"" % db,
        "python3 -c \"import os; os.truncate('%s', 0)\"" % db,
        "python3 -c \"import os; os.chmod('%s', 0)\"" % db,
        "python3 -c \"import os; os.open('%s', os.O_WRONLY | os.O_TRUNC)\"" % db,
        "python3 -c \"import sqlite3; db = '%s'; sqlite3.connect(db).execute('delete from lease')\"" % db,
        "python3 -c \"import shutil; shutil.rmtree('%s')\"" % d,
        "python3 - <<'EOF'\nimport os\nos.remove('%s')\nEOF" % db,
        "python3 <<< \"import os; os.remove('%s')\"" % db,
        "node -e \"require('fs').rmSync('%s')\"" % db,
        "node -e \"require('fs').renameSync('%s', '/tmp/old.db')\"" % db,
        "node -e \"require('fs').writeFileSync('%s', '')\"" % db,
        "node -e \"const fs=require('fs'); fs.unlinkSync('%s')\"" % db,
        "node -e \"require('child_process').execSync('rm -f %s')\"" % db,
        "perl -e 'unlink \"%s\"'" % db,
        "perl -e 'open(my $f, \">\", \"%s\")'" % db,
        "perl -pi -e 's/a/b/' %s" % db,
        "ruby -e 'File.delete(\"%s\")'" % db,
        "python3 -c \"import os,sys; os.remove(sys.argv[1])\" %s" % db,
        "python3 -c \"exec(open('/tmp/x.py').read())\" %s" % db,
        "cat > /tmp/x.py <<'EOF'\nimport os\nos.remove('%s')\nEOF\npython3 /tmp/x.py" % db,
        "export P=%s; python3 - <<'EOF'\nimport os\nos.remove(os.environ['P'])\nEOF" % db,
        "awk 'BEGIN{print \"x\" > \"%s\"}'" % db,
        "bash -c \"python3 -c \\\"import os; os.remove('%s')\\\"\"" % db,
        "X=$(python3 - <<'EOF'\nimport os\nos.remove('%s')\nEOF\n)" % db,
        "python3 -c \"import os as o; p = '%s'; o.remove(p)\"" % db,
        "python3 -c \"import os as o; o.truncate('%s', 0)\"" % db,
        "python3 -c \"import shutil as sh; sh.rmtree('%s')\"" % d,
        "python3 -c \"from os import remove as rm_; rm_('%s')\"" % db,
        "python3 -c \"from os import remove; p = '%s'; remove(p)\"" % db,
        "python3 -c \"import os; f = os.remove; f('%s')\"" % db,
        "python3 -c \"import os; getattr(os, 'remove')('%s')\"" % db,
        "python3 -c \"__import__('os').remove('%s')\"" % db,
        "python3 -c \"import subprocess as sp; sp.run(['rm', '%s'])\"" % db,
        "python3 -c \"from subprocess import run as r; r(['rm', '%s'])\"" % db,
        "python3 -c \"import subprocess; c = 'rm'; subprocess.run([c, '%s'])\"" % db,
        "python3 -c \"import subprocess; subprocess.run(['rm', 'leases.db'], cwd='%s')\"" % d,
        "python3 -c \"import subprocess; subprocess.run(['sqlite3', '%s', 'select 1; delete from lease'])\"" % db,
        "python3 -c \"import os; os.system('bash -c \\'rm -f %s\\'')\"" % db,
        "node -e \"const f = require('fs'); f.truncateSync('%s', 0)\"" % db,
        "node -e \"const f = require('fs'); const p = '%s'; f.rmSync(p)\"" % db,
        "node -e \"require('fs').openSync('%s', 'w')\"" % db,
        "python3 -c \"import os; os.rename('%s', '/tmp/y')\"" % db,
        "python3 -c \"import os; os.symlink('/tmp/x', '%s')\"" % db,
        "python3 -c \"import os; os.remove('/tmp/x'); os.remove('%s')\"" % db,
        "python3 -c \"open('/tmp/x', 'w'); open('%s', 'r+')\"" % db,
        "ruby -e 'require \"fileutils\"; FileUtils.rm_f(\"%s\")'" % db,
        "php -r 'unlink(\"%s\");'" % db,
        "perl -e '`rm -f %s`'" % db,
        "python3 -c \"import os; os.remove('%s-wal')\"" % db,
    ]


INTERP_WRITE_IDS = [c.replace("\n", "\\n")[:48] for c in _interp_write_cmds("/d/leases.db")]


@pytest.mark.parametrize("idx", range(len(INTERP_WRITE_IDS)), ids=INTERP_WRITE_IDS)
def test_interpreter_store_write_denied(env, switch_path, idx):
    cmd = _interp_write_cmds(env.db)[idx]
    rc, out, err = env.pre("Bash", {"command": cmd}, sid="S1", agent="agentA")
    assert rc == 0, err
    assert "owner-only" in denied(out), cmd


# ---- gate-wave2 F2: the pre-D2 word backstop, alias/getattr/[] refs, rm(, eval/Function(, the
# ---- DB open's own read-only file: URI (uri=True) and connect(database=...)
def _f2_write_cmds(db):
    d = os.path.dirname(db)
    return [
        # (1) a write-API name reached by string, symbol, alias, destructuring or computed key
        "node -e \"const {unlinkSync: u} = require('fs'); u('%s')\"" % db,
        "node -e \"const fs = require('fs'); fs['unlinkSync']('%s')\"" % db,
        "node -e \"const m = 'unlinkSync'; require('fs')[m]('%s')\"" % db,
        "python3 -c \"import os; vars(os)['remove']('%s')\"" % db,
        "ruby -e 'File.send(:unlink, \"%s\")'" % db,
        "php -r 'call_user_func(\"unlink\", \"%s\");'" % db,
        "python3 -c \"f = open; f('%s', 'w')\"" % db,
        "node -e \"const {execSync: x} = require('child_process'); x('rm -f %s')\"" % db,
        "perl -e 'system \"rm -f %s\"'" % db,
        "ruby -e 'system \"rm -f %s\"'" % db,
        "ruby -e 'File.send(ARGV[0], \"%s\")' unlink" % db,
        "php -r '$f = \"unl\" . \"ink\"; $f(\"%s\");'" % db,
        # (2) a bare rm(
        "node -e \"const {rm} = require('fs'); rm('%s', () => {})\"" % db,
        # (3) mode=ro counts only in the connect's own file: URI opened with uri=True
        "python3 -c \"import sqlite3; u = 'mode=ro'; db = '%s'; sqlite3.connect(db).execute('delete from lease')\"" % db,
        "python3 -c \"import sqlite3; sqlite3.connect('file:%s?mode=ro').execute('delete from lease')\"" % db,
        "python3 -c \"import sqlite3; sqlite3.connect('file:%s?mode=ro&mode=rw', uri=True).execute('delete from lease')\""
        % db,
        "python3 -c \"import sqlite3; sqlite3.connect('file:%s?readonly=1', uri=True).execute('delete from lease')\"" % db,
        "sqlite3 'file:%s?mode=ro&mode=rw' 'delete from lease'" % db,
        # (4) a keyword-only connect(database=...) is judged like a positional one
        "python3 -c \"import sqlite3; db = '%s'; sqlite3.connect(database=db).execute('delete from lease')\"" % db,
        "python3 -c \"import sqlite3; sqlite3.connect(database='%s').execute('delete from lease')\"" % db,
        # (5) a mutator taken as a value: aliased modules, getattr / [] on a non-literal receiver
        "node -e \"const f = require('fs'); const g = f.unlinkSync; g('%s')\"" % db,
        "node -e \"const f = require('fs'); const g = f.rmSync; g('%s')\"" % db,
        "python3 -c \"import os as x; g = x.remove; g('%s')\"" % db,
        "python3 -c \"import shutil as x; g = x.unpack_archive; g('/tmp/a.zip', '%s')\"" % d,
        "python3 -c \"from os import remove as r; g = r; g('%s')\"" % db,
        "python3 - <<'EOF'\nfrom os import remove as r\nr('%s')\nEOF" % db,
        "python3 -c \"import os, sys; o = os; getattr(o, sys.argv[1])('%s')\" remove" % db,
        "python3 -c \"import os, sys; vars(os)[sys.argv[1]]('%s')\" remove" % db,
        "node -e \"const m = 'unl' + 'inkSync'; require('fs')[m]('%s')\"" % db,
        "python3 -c \"import sys, os; p = '%s'; sys.modules['os'].remove(p)\"" % db,
        "ruby -e 'File.write \"%s\", \"\"'" % db,
        "perl -e 'CORE::unlink(\"%s\")'" % db,
        # (6) eval / Function( of a non-literal
        "python3 -c \"import base64; eval(base64.b64decode('eA==').decode()); print('%s')\"" % db,
        "node -e \"eval(process.argv[1]); console.log('%s')\"" % db,
        "node -e \"Function(process.argv[1])(); console.log('%s')\"" % db,
    ]


F2_WRITE_IDS = [c.replace("\n", "\\n")[:56] for c in _f2_write_cmds("/d/leases.db")]


@pytest.mark.parametrize("idx", range(len(F2_WRITE_IDS)), ids=F2_WRITE_IDS)
def test_f2_store_write_paths_denied(env, switch_path, idx):
    cmd = _f2_write_cmds(env.db)[idx]
    rc, out, err = env.pre("Bash", {"command": cmd}, sid="S1", agent="agentA")
    assert rc == 0, err
    assert "owner-only" in denied(out), cmd


def _f2_read_cmds(db):
    return [
        # (7) D2's read-only false-positive fixes stay
        "cat %s" % db,
        "sqlite3 'file:%s?mode=ro' 'select 1'" % db,
        "python3 -c \"import sqlite3; c = sqlite3.connect('file:%s?mode=ro', uri=True); "
        "print(c.execute('select 1').fetchall())\"" % db,
        "python3 -c \"import sqlite3; c = sqlite3.connect(database='file:%s?mode=ro', uri=True); "
        "print(c.execute('select 1').fetchall())\"" % db,
        "ls $(dirname %s)" % db,
        "grep x %s" % db,
        # the new rules leave plain reads alone: literal keys/slices, prose, comments, --eval
        "python3 -c \"print(open('%s', 'rb').read()[:16])\"" % db,
        "python3 -c \"import sys; print(sys.argv[1])\" %s" % db,
        "python3 -c \"print(open('%s', 'rb').read().decode('utf-8', 'replace'))\"" % db,
        "python3 -c \"import os; d = {'path': '%s'}; print(os.path.getsize(d['path']))\"" % db,
        "python3 -c \"import sqlite3; c = sqlite3.connect('file:%s?mode=ro', uri=True); "
        "print([r[0] for r in c.execute('select writer_session from lease')])\"" % db,
        "python3 - <<'EOF'\nimport sqlite3\n# open the lease store read-only\n"
        "c = sqlite3.connect('file:%s?mode=ro', uri=True)\nprint(c.execute('select count(*) from lease').fetchone())\nEOF"
        % db,
        "node --eval \"console.log(require('fs').statSync('%s').size)\"" % db,
        "node -e \"const {readFileSync} = require('fs'); console.log(readFileSync('%s').length)\"" % db,
        "perl -e 'eval { print -s \"%s\" }'" % db,
    ]


F2_READ_IDS = [c.replace("\n", "\\n")[:56] for c in _f2_read_cmds("/d/leases.db")]


@pytest.mark.parametrize("idx", range(len(F2_READ_IDS)), ids=F2_READ_IDS)
def test_f2_read_only_mentions_allowed(env, switch_path, idx):
    cmd = _f2_read_cmds(env.db)[idx]
    rc, out, err = env.pre("Bash", {"command": cmd}, sid="S1", agent="agentA")
    assert rc == 0 and out == "", (cmd, out, err)


# ----------------------------------------------- parent -> child (orchestrator ruling)
def test_subagent_may_write_file_leased_by_its_own_main(env, tmp_path):
    f = tmp_path / "plan.py"
    env.write_cycle(f, "v1", sid="S1")  # the main thread holds the lease
    env.post("Read", {"file_path": str(f)}, sid="S1", agent="childA")
    rc, out, err = env.edit(f, sid="S1", agent="childA")
    assert rc == 0 and out == "", (out, err)  # silent hand-over
    assert env.lease(f)["holder_agent"] == "childA"


def test_negative_control_siblings_and_other_sessions_stay_serialized(env, tmp_path):
    f = tmp_path / "plan2.py"
    env.write_cycle(f, "v1", sid="S1")
    assert "S1" in denied(env.edit(f, sid="S2", agent="childX")[1])  # not this main's child
    env.write_cycle(f, "v2", sid="S1", agent="childA")  # the child takes it from its main
    assert "childA" in denied(env.edit(f, sid="S1", agent="childB")[1])  # sibling still blocked


def test_parent_child_hand_over_keeps_the_stale_check(env, tmp_path):
    f = tmp_path / "plan3.py"
    f.write_text("base")
    env.post("Read", {"file_path": str(f)}, sid="S1", agent="childA")
    env.write_cycle(f, "main v2", sid="S1")
    assert "changed since you last saw it" in denied(env.edit(f, sid="S1", agent="childA")[1])


# ------------------------------- unconfirmed lease (PreToolUse without PostToolUse): 60 s
def test_unconfirmed_lease_blocks_for_60_seconds_only(env, tmp_path):
    f = tmp_path / "pending.py"
    f.write_text("v0")
    assert env.edit(f, sid="S1", agent="agentA")[1] == ""  # the call itself never ran
    assert "agentA" in denied(env.edit(f, sid="S1", agent="agentB")[1])
    env.age_holder(f, 61)
    rc, out, err = env.edit(f, sid="S1", agent="agentB")
    assert rc == 0 and out == "", (out, err)
    assert env.lease(f)["holder_agent"] == "agentB"


def test_negative_control_confirmed_lease_keeps_the_full_ttl(env, tmp_path):
    f = tmp_path / "confirmed.py"
    env.write_cycle(f, "v1", sid="S1", agent="agentA")  # PreToolUse + PostToolUse
    env.age_holder(f, 61)
    assert "agentA" in denied(env.edit(f, sid="S1", agent="agentB")[1])


def test_unconfirmed_retry_after_own_write_keeps_the_write_ttl(env, tmp_path):
    f = tmp_path / "retry.py"
    env.write_cycle(f, "v1", sid="S1", agent="agentA")
    assert env.edit(f, sid="S1", agent="agentA")[1] == ""  # a second edit that never ran
    env.age_holder(f, 61)
    assert "agentA" in denied(env.edit(f, sid="S1", agent="agentB")[1])


# ------------------------- addendum (1): quoted comparisons / fd dups are never targets
@pytest.mark.parametrize("cmd", [
    "jq '.[] | select(.n >= 2)' data.json", "jq -r '.items[] | select(.size > 0) | .name' in.json",
    "awk '$1 > 0 {print}' data.txt", "python3 -c \"print(1 if 2 > 0 else 0)\"",
    "make 2>&1 | tail -5", "echo warn >&2", "sqlite3 app.db 'select * from t where n >= 2'"])
def test_two_actors_quoted_comparisons_take_no_lease(env, tmp_path, cmd):
    rc, out, err = env.pre("Bash", {"command": cmd}, sid="S1", agent="agentA")
    assert rc == 0 and out == "", (out, err)
    for name in ("=", "0", "1", "2"):
        rc, out, err = env.edit(tmp_path / name, sid="S1", agent="agentB")
        assert rc == 0 and out == "", (name, out, err)


def test_negative_control_real_redirect_after_quoted_code_still_leases(env, tmp_path):
    target = tmp_path / "out.json"
    cmd = "jq '.n >= 2' in.json > %s" % target
    assert env.pre("Bash", {"command": cmd}, sid="S1", agent="agentA")[1] == ""
    assert "agentA" in denied(env.edit(target, sid="S1", agent="agentB")[1])


# ------------------------------------------------- negative-control canary
def test_negative_control_canary(switch_path):
    """Passes in both modes; under FILE_LEASE_NEGATIVE_CONTROL=1 the switch
    exists and the deny/warn assertions above fail, which is the control. The
    switch lives in a tmp dir: the real hooks directory is never written."""
    assert os.environ.get("FILE_LEASE_SWITCH") == switch_path
    assert not os.path.exists(REAL_SWITCH)
    if os.environ.get("FILE_LEASE_NEGATIVE_CONTROL") == "1":
        assert os.path.exists(switch_path)
    else:
        assert not os.path.exists(switch_path)
