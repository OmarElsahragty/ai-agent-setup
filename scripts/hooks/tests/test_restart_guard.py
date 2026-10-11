"""restart-guard PreToolUse hook tests (deny raw cloudcli restarts/kills; allow safe-restart.sh).

WO-5 M3: signals to protected processes (claude.exe sessions, the CloudCLI server) are denied:
literal PIDs, process groups, $VAR set in the same command, $(...)/`...` lookups, xargs kill,
pkill/pgrep/pidof/killall/killall5/fuser, nested shells. Negative controls: kill -0 probes,
$!/%1/0/$$, unrelated PIDs, patterns that reach nothing protected. Fail-open on errors.
2026-10-10 audit H + review B: GAP-5 denies sends into the live install: any :3011 request that is
not a plain GET/HEAD (curl/wget/HTTPie/websocat/wscat/nc, inline or heredoc python/node, /dev/tcp),
with no override; `claude --resume/-r/--session-id <live sid>`; with claude as the command a bare
`--resume`, `--from-pr` and `-c/--continue` where a live holder runs (--fork-session exempts all but
a live --session-id). The QA-rig exemption (leading CLOUDCLI_QA_SCRATCH=1 + HOME under the scratch
root) covers the session forms only. GAP-7 attributes every ALLOWED `systemctl ... cloudcli`
command to a session id, only once the whole command is allowed; tests write a tmp log only.
"""
import json
import os

import pytest

from conftest import load_hook, run_hook

rg = load_hook("restart-guard.py")


@pytest.fixture(autouse=True)
def _private_state(tmp_path, monkeypatch):
    """Tests never touch the real cloudcli-ops.log or live session state: in-process calls use the
    patched module globals, run_hook subprocesses read the env overrides at import."""
    log = tmp_path / "cloudcli-ops.log"
    monkeypatch.setenv("RESTART_GUARD_ATTR_LOG", str(log))
    monkeypatch.setenv("CLOUDCLI_RUNTIME_STATE", str(tmp_path / "no-runtime-state.json"))
    monkeypatch.setattr(rg, "ATTR_LOG", str(log))
    monkeypatch.setattr(rg, "STATE_FILE", str(tmp_path / "no-runtime-state.json"))
    monkeypatch.setattr(rg, "SESSIONS_DIR", str(tmp_path / "no-sessions"))
    return log


def _bash(command):
    return {"tool_name": "Bash", "tool_input": {"command": command}}


# ── process view used by the kill tests (tests never touch the real /proc) ──
def make_table():
    Proc = rg.Proc
    procs = {
        # the CloudCLI server: MainPID, node running the live install
        100: Proc(100, "MainThread",
                  ("/usr/bin/node", "${AI_SETUP_ROOT}/cloudcli/node_modules/@cloudcli-ai/cloudcli/dist-server/index.js"),
                  1, 100, 100, 0, "/usr/bin/node"),
        # two claude.exe session processes in the server's group
        200: Proc(200, "claude.exe", ("/root/.local/share/claude/claude.exe", "--resume", "sess-a"),
                  100, 100, 100, 0, "/root/.local/share/claude/claude.exe"),
        300: Proc(300, "claude.exe", ("/root/.local/share/claude/claude.exe", "run.sh"), 100, 100, 100, 0, ""),
        # the Bash tool shell: its own group leader
        400: Proc(400, "bash", ("/bin/bash", "-c", "true"), 200, 400, 400, 0, "/usr/bin/bash"),
        # an unrelated node build job: NOT protected
        500: Proc(500, "node", ("/usr/bin/node", "/tmp/build/tool.js"), 1, 500, 500, 0, "/usr/bin/node"),
    }
    return rg.ProcTable(table=procs, main_pid=100)


def decision(command, procs=None, cwd=None):
    return rg.check(command, procs=procs if procs is not None else make_table(), cwd=cwd)


DENIED = [
    # literal PIDs and signal spellings
    "kill 200", "kill -9 200", "kill -TERM 300", "kill -s SIGKILL 200", "kill -s 15 200",
    "kill -n 9 200", "kill -9 200 300", "sudo kill 200", "timeout 5 kill 200",
    "kill -9 100", "kill 100",                       # the server (MainPID / live-install marker)
    # process groups and every-process forms
    "kill -- -100", "PGID=100; kill -- -${PGID}", "kill -9 -1", "kill -HUP -1",
    # variables assigned in the same command
    "P=200; kill $P", "P=200; kill \"$P\"", "for p in 200 300; do kill $p; done",
    # command substitutions
    "kill $(pgrep -f claude)", "kill `pidof claude.exe`", "kill -9 $(pgrep claude)",
    # xargs kill
    "pgrep -f claude.exe | xargs kill -9", "echo 200 | xargs kill", "cat run.pid | xargs kill",
    # pkill / killall / killall5 / fuser
    "pkill claude", "pkill -f claude.exe", "pkill -P 100",
    "killall claude.exe", "killall node", "killall5", "fuser -k 3011/tcp",
    # the shell's own parent is the Claude process
    "kill $PPID",
    # nested shells / eval / substitutions
    "bash -c 'kill -9 200'", "sh -c 'kill 200'", "su -c 'kill 200' root", "eval 'kill 200'",
    "echo $(kill 200)",
    # pipeline feeding a read loop
    "ps aux | awk '/claude/{print $2}' | while read p; do kill $p; done",
    # 2026-10-10: subshells and xargs reading a file / here-string / process substitution
    "(kill 200)", "{ (kill -9 300); }", "(pkill -f sess-a)",
    "xargs kill < run.pid", "xargs kill <run.pid", "xargs kill 0<run.pid", "xargs -a run.pid kill",
    "xargs --arg-file=run.pid kill -9", "xargs -ra run.pid kill", "xargs kill <<< '200 300'",
    "xargs kill < <(pgrep -f claude)", "xargs -a <(pgrep claude) kill",
]


@pytest.mark.parametrize("command", DENIED)
def test_kill_of_protected_process_denied(command, tmp_path):
    (tmp_path / "run.pid").write_text("200\n")
    verdict = decision(command, cwd=str(tmp_path))
    assert verdict is not None, command
    kind, reason = verdict
    assert kind == "deny", (command, reason)
    assert "safe-restart.sh" in reason, reason


def test_kill_pidfile_target_denied(tmp_path):
    (tmp_path / "run.pid").write_text("200\n")
    verdict = decision("kill $(cat run.pid)", cwd=str(tmp_path))
    assert verdict and verdict[0] == "deny"


ALLOWED = [
    "kill -0 200",            # liveness probe: allowed by design
    "kill 500",               # unrelated node job
    "kill 99999",             # no such process
    "kill -- -500",           # a process group with nothing protected in it
    "kill $!", "kill %1", "kill 0", "kill $$",
    "kill -l", "kill -l TERM", "kill -1",  # no PID: a shell usage error, sends nothing
    "killall firefox", "pkill -f unrelated-build-tool", "fuser -k 8080/tcp",
    "echo | xargs kill",
    "kill $(cat missing.pid)",
    "systemctl restart nginx", "ps aux | grep node",
    # 2026-10-10 negative controls: same xargs/subshell forms with unprotected input; signal-0 probes
    "xargs kill < run.pid", "xargs -a run.pid kill", "xargs kill <<< '500'", "xargs kill < missing.pid",
    "(kill 500)", "xargs -a run.pid echo",
    "kill -0 $(pgrep claude)", "pkill -0 claude", "killall -0 claude.exe", "kill -0 -9 200",
]


@pytest.mark.parametrize("command", ALLOWED)
def test_kill_unrelated_or_probe_allowed(command, tmp_path):
    (tmp_path / "run.pid").write_text("500\n")  # same name, unprotected content
    assert decision(command, cwd=str(tmp_path)) is None, command


def test_server_pid_protected_even_without_marker():
    # main_pid alone protects the server even when its argv does not carry the install path
    Proc = rg.Proc
    table = rg.ProcTable(table={600: Proc(600, "MainThread", ("/usr/bin/node", "server.js"), 1, 600, 600, 0,
                                       "/usr/bin/node")}, main_pid=600)
    assert decision("kill 600", procs=table)[0] == "deny"


def test_fail_open_when_proc_view_raises(monkeypatch):
    def boom(pid):
        raise RuntimeError("proc view unavailable")
    monkeypatch.setattr(rg, "_read_proc", boom)
    assert rg.check("kill 1", procs=rg.ProcTable()) is None  # analysis error must never block


# ── pre-existing coverage (unchanged behaviour) ──
@pytest.mark.parametrize("command", [
    "systemctl restart cloudcli",
    "sudo systemctl restart cloudcli.service",
    "systemctl --no-block stop cloudcli",
    "systemctl kill cloudcli",
    "systemctl try-restart cloudcli voice-gateway",
    "systemctl restart voice-gateway cloudcli && sleep 2",
    "systemctl disable --now cloudcli",
    "pkill -f claude.exe",
    "killall cloudcli",
    "kill -9 $(pgrep -f claude)",
    "kill $(pidof claude.exe)",
    "kill `pgrep -f claude.exe`",
    "service cloudcli restart",
    "systemctl restart \\\ncloudcli",
    "systemctl restart cloudcli # prefer safe-restart.sh later",
    "grep safe-restart.sh /var/log/x; systemctl restart cloudcli",
    "${AI_SETUP_ROOT}/scripts/safe-restart.sh cloudcli && systemctl stop cloudcli",
])
def test_raw_restart_or_kill_denied(command):
    code, out, _ = run_hook("restart-guard.py", _bash(command))
    assert code == 0
    spec = json.loads(out)["hookSpecificOutput"]
    assert spec["permissionDecision"] == "deny"
    assert "safe-restart.sh" in spec["permissionDecisionReason"]


@pytest.mark.parametrize("command", [
    "${AI_SETUP_ROOT}/scripts/safe-restart.sh cloudcli",
    "sudo ${AI_SETUP_ROOT}/scripts/safe-restart.sh cloudcli",
    "bash ${AI_SETUP_ROOT}/scripts/safe-restart.sh cloudcli --max-wait 30",
    "systemctl status cloudcli",
    "systemctl show cloudcli -p MemoryHigh",
    "journalctl -u cloudcli -n 50",
    "systemctl restart claude-router",
    "systemctl restart voice-gateway; systemctl status cloudcli",
    "pgrep -f claude.exe",
    "grep restart cloudcli.log",
    "pkill -f claude-router",
    "killall claude-router",
    "systemctl restart cloudcli-foo",
    "systemctl status safe-restart-cloudcli-1791405109",
    "systemctl stop safe-restart-cloudcli-1791405109",
    "kill -0 $(pgrep -f claude.exe)",  # signal-0 liveness probes pass the legacy patterns too
    "pkill -0 -f claude.exe",
])
def test_negative_control_safe_or_unrelated_allowed(command):
    code, out, _ = run_hook("restart-guard.py", _bash(command))
    assert code == 0
    assert out.strip() == ""


@pytest.mark.parametrize("command", [
    "${AI_SETUP_ROOT}/scripts/safe-restart.sh cloudcli --now",
    "sudo safe-restart.sh cloudcli --max-wait 5 --now",
])
def test_safe_restart_now_asks_owner(command):
    code, out, _ = run_hook("restart-guard.py", _bash(command))
    assert code == 0
    spec = json.loads(out)["hookSpecificOutput"]
    assert spec["permissionDecision"] == "ask"
    assert "owner" in spec["permissionDecisionReason"]


@pytest.mark.parametrize("payload", ["not a dict", [1, 2], {"tool_name": "Bash", "tool_input": "x"},
                                     {"tool_name": "Write", "tool_input": {"command": "systemctl restart cloudcli"}}])
def test_malformed_or_other_tool_fails_open(payload):
    code, out, _ = run_hook("restart-guard.py", payload)
    assert code == 0
    assert out.strip() == ""


# ── 2026-10-10: device-node metadata (the `cp -p x /dev/null` incident) ──
@pytest.mark.parametrize("command", [
    "cp -p $W/superseded-dataset-format-v1.md-preFIXFINAL-20261008 /dev/null 2>/dev/null",  # the incident
    "cp -a a.txt /dev/null",
    "cp --preserve=mode a /dev/null",
    "sudo cp -pf a /dev/null",
    "cp -p -t /dev/null a",
    "chmod 644 /dev/null",
    "chown nobody /dev/null",
    "rm -f /dev/null",
    "mv x /dev/null",
    "ln -sf /tmp/x /dev/null",
    "install -m 600 a /dev/null",
    "rsync -a a /dev/null",
    "true; setfacl -m u:x:r /dev/zero",
    "chmod 600 /dev//null",
])
def test_devnode_metadata_change_denied(command):
    code, out, _ = run_hook("restart-guard.py", _bash(command))
    assert code == 0
    spec = json.loads(out)["hookSpecificOutput"]
    assert spec["permissionDecision"] == "deny", command
    assert "device node" in spec["permissionDecisionReason"]


@pytest.mark.parametrize("command", [
    "ls >/dev/null 2>&1",
    "cp a b 2>/dev/null",
    "cp a /dev/null",                        # plain cp writes bytes only
    "cp -p /dev/null empty.txt",             # device as the source
    "cp -p a b > /dev/null",
    "chmod 644 file.txt 2>/dev/null",
    "rm -f /tmp/x >/dev/null",
    "install -m 0600 -o root -g root /dev/null /etc/voice-gateway/key",  # device as source
    "echo chmod 644 /dev/null",
    "grep -r 'chmod /dev/null' docs",
])
def test_devnode_negative_control_allowed(command):
    assert rg.check(command, procs=make_table()) is None, command


# ── 2026-10-10, audit H GAP-5: sends into the LIVE install / live session ids ──
LIVE_SID = "0f191a1733b0926e312d7ef029ad19abb384b4e942cdbf9ac41240ceeb9ab931"


@pytest.fixture
def live_sessions(tmp_path, monkeypatch):
    """A runtime state file holding one live entry + a sessions/<pid>.json pointing at a live pid
    (this pytest process), so the live-id table is realistic without touching real state."""
    state = tmp_path / "runtime-state.json"
    state.write_text(json.dumps([{"appSessionId": "app-1", "providerSessionId": LIVE_SID,
                                  "pid": os.getpid(), "state": "in-turn", "since": "x"}]))
    sdir = tmp_path / "sessions"
    sdir.mkdir()
    (sdir / (str(os.getpid()) + ".json")).write_text(
        json.dumps({"sessionId": LIVE_SID, "pid": os.getpid()}))
    monkeypatch.setattr(rg, "STATE_FILE", str(state))
    monkeypatch.setattr(rg, "SESSIONS_DIR", str(sdir))
    return str(state), str(sdir)


@pytest.mark.parametrize("command", [
    'claude -p --resume %s "x"' % LIVE_SID,
    "claude --resume %s" % LIVE_SID,
    "claude -r %s" % LIVE_SID,
    "claude --resume=%s" % LIVE_SID,
])
def test_live_resume_denied(command, live_sessions):
    # rg.check: the live-id table is injected via the fixture (a run_hook subprocess could not see it)
    v = rg.check(command, procs=make_table())
    assert v and v[0] == "deny", command
    assert "LIVE CloudCLI" in v[1]


@pytest.mark.parametrize("command", [
    'node -e "new WebSocket(\'ws://127.0.0.1:3011/ws\')"',
    "curl -X POST http://127.0.0.1:3011/api/sessions/send -d {}",
    "curl --request POST http://localhost:3011/api/messages -d @payload.json",
])
def test_live_port_write_denied(command):
    code, out, _ = run_hook("restart-guard.py", _bash(command))
    assert code == 0
    spec = json.loads(out)["hookSpecificOutput"]
    assert spec["permissionDecision"] == "deny", command
    assert "LIVE CloudCLI" in spec["permissionDecisionReason"]


@pytest.mark.parametrize("command", [
    "claude -p 'Reply OK'",                              # no resume: a fresh probe session
    "claude --resume 11111111-2222-3333-4444-555555555555",  # not a live id
    "curl -s http://127.0.0.1:3011/api/auth/status",     # read-only GET on the live port
    "curl -sf http://127.0.0.1:3099/api/x -d {}",        # the scratch rig port: not the live install
    'node -e "new WebSocket(\'ws://127.0.0.1:3099/ws\')"',
    "grep 3011 notes.txt; cat log | grep 3011",          # the port as data, no write
])
def test_live_send_negative_control_allowed(command, live_sessions):
    code, out, _ = run_hook("restart-guard.py", _bash(command))
    assert code == 0, command
    assert out.strip() == "", command


# ── security fix-pass: every :3011 write shape is denied, reads stay allowed ──
U = "http://127.0.0.1:3011/api/sessions/send"
PORT_WRITES = [
    # curl body / form / upload / config options
    "curl -d '{}' " + U, "curl --data '{}' " + U, "curl --data-raw '{\"a\":1}' " + U,
    "curl --data-binary @body.json " + U, "curl --data-urlencode q=x " + U, "curl --json '{}' " + U,
    "curl -F file=@x " + U, "curl --form file=@x " + U, "curl -T x.bin " + U, "curl --upload-file x.bin " + U,
    "curl -sSd '{}' " + U, "curl -K req.cfg " + U, "curl --expand-data '{{x}}' " + U, "curl -G -d q=1 " + U,
    # methods, any case
    "curl -XPOST " + U, "curl -X post " + U, "curl -X put " + U, "curl --request delete " + U,
    "curl -H 'Content-Type: application/json' -X PATCH " + U,
    # evasion forms: quoted &, padded port, variables, split quotes, `#` inside quotes, ANSI-C, nesting
    "curl \"http://127.0.0.1:3011/api/send?a=1&b=2\" -X POST",
    "curl -X POST http://127.0.0.1:03011/api/send",
    "P=3011; curl -X POST http://127.0.0.1:$P/api/send",
    "U=http://127.0.0.1:3011; curl -d x $U/api/send",
    "curl -X POST http://127.0.0.1:30\"\"11/api/send",
    "curl -d ' #' http://127.0.0.1:3011/api/send",
    "curl $'-d' x http://127.0.0.1:3011/api/send",
    "curl -X$'\\x50OST' http://127.0.0.1:3011/api/send",
    "bash -c \"curl -X POST http://127.0.0.1:3011/api/send\"",
    "sudo -u root curl -XPUT http://localhost:3011/api/x",
    # wget
    "wget --post-data='a=1' " + U, "wget --post-file=body.json " + U, "wget --method=PUT " + U,
    "wget --method DELETE " + U, "wget -e post_data=x " + U, "wget -qO- --body-data=x --method=POST " + U,
    # WebSocket / raw socket clients, HTTPie
    "websocat ws://127.0.0.1:3011/ws", "echo '{\"type\":\"x\"}' | websocat ws://127.0.0.1:3011/ws",
    "wscat -c ws://localhost:3011/ws", "npx wscat -c wss://localhost:3011/ws",
    "nc 127.0.0.1 3011 < req.txt", "printf 'POST / HTTP/1.1\\r\\n\\r\\n' | nc localhost 3011",
    "socat - TCP:127.0.0.1:3011", "exec 3<>/dev/tcp/127.0.0.1/3011",
    "http POST :3011/api/send a=1", "xh :3011/api/send text=hi",
    # inline interpreters
    "python3 -c \"import requests; requests.post('" + U + "', json={})\"",
    "python3 -c \"import requests; requests.put('http://127.0.0.1:3011/api/x')\"",
    "python3 -c \"import requests; requests.patch('http://127.0.0.1:3011/api/x')\"",
    "python3 -c \"import requests; requests.delete('http://127.0.0.1:3011/api/x')\"",
    "python3 -c \"import urllib.request as u; u.urlopen(u.Request('" + U + "', b'{}'))\"",
    "node -e \"fetch('" + U + "', {method: 'POST', body: '{}'})\"",
    "node -e \"fetch('" + U + "', {method: 'post'})\"",
    "node -e \"new WebSocket('ws://127.0.0.1:3011/ws')\"",
    "echo \"import requests; requests.post('" + U + "')\" | python3",
    # heredoc / stdin programs
    "python3 - <<'EOF'\nimport urllib.request as u\nreq = u.Request('" + U + "', data=b'{}', method='POST')\n"
    "u.urlopen(req)\nEOF",
    "python3 <<'EOF'\nimport socket\ns = socket.create_connection(('127.0.0.1', 3011))\n"
    "s.sendall(b'GET / HTTP/1.0\\r\\n\\r\\n')\nEOF",
    "node <<'EOF'\nfetch('" + U + "', {\n  method: 'POST',\n  body: '{}'\n})\nEOF",
    # a heredoc apostrophe must not hide a later write
    "cat > notes.md <<'EOF'\ndon't\nEOF\ncurl -X POST " + U,
    # write-then-run script, redirection into a socket, gawk networking
    "cat > /tmp/p.py <<'EOF'\nimport requests\nrequests.post('" + U + "')\nEOF\npython3 /tmp/p.py",
    "echo 'POST / HTTP/1.1' > /dev/tcp/127.0.0.1/3011",
    "gawk 'BEGIN { s = \"/inet/tcp/0/127.0.0.1/3011\"; print \"POST / HTTP/1.0\" |& s }'",
]


@pytest.mark.parametrize("command", PORT_WRITES)
def test_live_port_write_shapes_denied(command):
    v = rg.check(command, procs=make_table())
    assert v and v[0] == "deny", command
    assert "LIVE CloudCLI" in v[1] and ":3099" in v[1], v[1]


PORT_READS = [
    "curl -s http://127.0.0.1:3011/api/auth/status", "curl -X GET http://127.0.0.1:3011/health",
    "curl -XHEAD http://127.0.0.1:3011/health", "curl -I http://127.0.0.1:3011/",
    "curl --head http://127.0.0.1:3011/", "curl -X get http://127.0.0.1:3011/health",
    "curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3011/health",
    "curl -s \"http://127.0.0.1:3011/api/x?a=1&b=2\"", "wget -qO- http://127.0.0.1:3011/health",
    "http GET :3011/health", "nc -z 127.0.0.1 3011", "nc -zv localhost 3011",
    "python3 -c \"import urllib.request as u; print(u.urlopen('http://127.0.0.1:3011/health', timeout=3).status)\"",
    "node -e \"fetch('http://127.0.0.1:3011/health').then(r => console.log(r.status))\"",
    "node -e \"fetch('http://127.0.0.1:3011/api/x', {method: 'GET'})\"",
    "python3 - <<'EOF'\nimport urllib.request as u\nprint(u.urlopen('http://127.0.0.1:3011/health', timeout=3).status)\nEOF",
    "ss -tlnp | grep node | grep 3011", "lsof -i :3011", "grep -rn 3011 /etc/cloudflared/config.yml",
    "curl -s http://127.0.0.1:3011/api/health | python3 -c \"import json,sys; print(json.load(sys.stdin))\"",
    "curl -X POST http://127.0.0.1:3099/api/send -d '{}'",          # the scratch rig
    "CLOUDCLI_QA_SCRATCH=1 HOME=/var/tmp/claude/cc-scratch/qa1 curl -X POST http://127.0.0.1:3099/api/send -d '{}'",
    "websocat ws://127.0.0.1:3099/ws", "curl -X POST http://127.0.0.1:30110/x -d 1",
    # the port and a verb as plain data (search patterns, log filters, messages)
    "journalctl -u cloudcli -n 200 | grep -E 'POST|3011'", "git log --grep 'POST.*3011'",
    "echo \"POST /api on :3011 is denied\"", "rg -n 'app.post' src | grep 3011",
]


@pytest.mark.parametrize("command", PORT_READS)
def test_live_port_reads_and_scratch_rig_allowed(command):
    assert rg.check(command, procs=make_table()) is None, command


def test_port_write_negative_control(monkeypatch):
    """The deny above comes from the curl parser: with it neutralised the same POST passes, and a
    GET/POST pair on the same URL splits on the method alone."""
    post = "curl -X POST -d '{}' " + U
    assert rg.check("curl " + U, procs=make_table()) is None
    assert rg.check(post, procs=make_table())[0] == "deny"
    monkeypatch.setattr(rg, "_curl_writes", lambda args: False)
    assert rg.check(post, procs=make_table()) is None


def test_qa_scratch_never_exempts_live_port_write(live_sessions):
    """Owner ruling Q4: no override for :3011 writes; the deny reason names no exemption recipe."""
    cmd = "env CLOUDCLI_QA_SCRATCH=1 HOME=/var/tmp/claude/cc-scratch/qa1 curl -X POST http://127.0.0.1:3011/api/send -d {}"
    v = rg.check(cmd, procs=make_table())
    assert v and v[0] == "deny"
    assert "CLOUDCLI_QA_SCRATCH" not in v[1] and "cc-scratch" not in v[1]
    assert "scratch rig on :3099" in v[1]


def test_qa_scratch_flag_alone_is_not_a_bypass(live_sessions):
    cmd = "env CLOUDCLI_QA_SCRATCH=1 curl -X POST http://127.0.0.1:3011/api/send -d {}"
    v = rg.check(cmd, procs=make_table())
    assert v and v[0] == "deny"


def test_fail_open_on_state_read_error(monkeypatch):
    def boom(*a, **k):
        raise OSError("no state")
    monkeypatch.setattr(rg, "_live_session_ids", boom)
    assert rg.check("claude --resume %s" % LIVE_SID, procs=make_table()) is None


# ── GAP-7: attribution of allowed systemctl-mentions of cloudcli ──
def test_allowed_systemctl_mention_is_attributed(monkeypatch, tmp_path):
    log = tmp_path / "ops.log"
    monkeypatch.setattr(rg, "ATTR_LOG", str(log))
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "sess-attr")
    assert rg.check("systemctl status cloudcli.service", procs=make_table()) is None
    lines = log.read_text().splitlines()
    assert len(lines) == 1
    entry = json.loads(lines[0])
    assert entry["session"] == "sess-attr" and "cloudcli" in entry["cmd"]


def test_attribution_not_written_for_unrelated_or_denied(monkeypatch, tmp_path):
    log = tmp_path / "ops.log"
    monkeypatch.setattr(rg, "ATTR_LOG", str(log))
    assert rg.check("systemctl status nginx", procs=make_table()) is None
    v = rg.check("systemctl restart cloudcli", procs=make_table())
    assert v and v[0] == "deny"
    assert not log.exists()


def test_attribution_never_raises(monkeypatch):
    monkeypatch.setattr(rg, "ATTR_LOG", "/proc/definitely/not/writable")
    assert rg.check("systemctl is-active cloudcli", procs=make_table()) is None


@pytest.mark.parametrize("command, kind", [
    ("systemctl status cloudcli; kill 200", "deny"),                       # a later kill check denies
    ("systemctl status cloudcli && chmod 644 /dev/null", "deny"),          # a later device-node check
    ("systemctl status cloudcli; curl -X POST http://127.0.0.1:3011/x", "deny"),  # GAP-5
    ("systemctl status cloudcli; ${AI_SETUP_ROOT}/scripts/safe-restart.sh cloudcli --now", "ask"),
])
def test_attribution_only_after_final_allow(command, kind, _private_state):
    v = rg.check(command, procs=make_table())
    assert v and v[0] == kind, (command, v)
    assert not _private_state.exists(), command


def test_attribution_subprocess_honours_env_override(_private_state):
    code, out, _ = run_hook("restart-guard.py", _bash("systemctl status cloudcli"))
    assert code == 0 and out.strip() == ""
    lines = _private_state.read_text().splitlines()
    assert len(lines) == 1 and "cloudcli" in json.loads(lines[0])["cmd"]


def test_attr_log_env_override_read_at_import(monkeypatch, tmp_path):
    monkeypatch.setenv("RESTART_GUARD_ATTR_LOG", str(tmp_path / "x.log"))
    assert load_hook("restart-guard.py", unique_name="rg_attr_probe_set").ATTR_LOG == str(tmp_path / "x.log")
    monkeypatch.delenv("RESTART_GUARD_ATTR_LOG")
    assert load_hook("restart-guard.py", unique_name="rg_attr_probe_unset").ATTR_LOG == "/var/tmp/claude/cloudcli-ops.log"


# ── review B: -c/--continue, bare --resume, --from-pr, --session-id ──
@pytest.fixture
def held(tmp_path, monkeypatch):
    """A live holder (this pytest pid) with an explicit cwd in the runtime state; empty sessions dir."""
    hdir, fdir = tmp_path / "held", tmp_path / "free"
    hdir.mkdir()
    fdir.mkdir()
    state = tmp_path / "runtime-state.json"
    state.write_text(json.dumps([{"appSessionId": "app-1", "providerSessionId": LIVE_SID, "pid": os.getpid(),
                                  "state": "in-turn", "since": "x", "cwd": str(hdir)}]))
    (tmp_path / "sessions").mkdir()
    monkeypatch.setattr(rg, "STATE_FILE", str(state))
    monkeypatch.setattr(rg, "SESSIONS_DIR", str(tmp_path / "sessions"))
    monkeypatch.delenv("RG_TEST_UNSET_DIR", raising=False)
    return str(hdir), str(fdir)


def _dead_pid():
    for pid in range(4194303, 4194000, -1):
        if not os.path.exists("/proc/%d" % pid):
            return pid
    pytest.skip("no free pid")


@pytest.mark.parametrize("command", [
    "claude -p -c hi", "claude --continue -p hi", "claude -pc hi", "claude -cp hi",
    "bash -c \"claude -p -c hi\"", "timeout 60 claude -p -c hi", "sudo claude -c",
    "npx @anthropic-ai/claude-code -p -c hi", "npx -y @anthropic-ai/claude-code@latest -c",
    "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js -c", "eval \"claude -p -c hi\"",
    "echo hi | xargs claude -p -c", "C=claude; $C -p -c hi",
])
def test_continue_in_held_cwd_denied(command, held):
    v = rg.check(command, procs=make_table(), cwd=held[0])
    assert v and v[0] == "deny", command
    assert "--continue" in v[1]


@pytest.mark.parametrize("command, where, denied", [
    ("cd {held} && claude -p -c hi", "free", True),
    ("cd {held}/sub/.. && claude -c", "free", True),
    ("cd .. && claude -c", "held/sub", True),
    ("cd \"$RG_TEST_UNSET_DIR\" && claude -c", "free", True),      # unknown cwd + a live holder
    ("cd - && claude -c", "free", True),
    ("(cd {held}; true); claude -p -c hi", "free", False),          # the subshell's cd ends at `)`
    ("cd {held} && cd {free} && claude -c", "free", False),
    ("cd {free} && claude -c", "held", False),
    ("bash -c \"cd {held} && claude -c\"", "free", True),
    ("claude -p -c --fork-session hi", "held", False),
    ("claude -p -c hi", "free", False),
    ("git commit -m \"claude -c later\"", "held", False),           # data, not a claude invocation
    ("echo claude -c", "held", False),
    ("cat > notes.md <<'EOF'\nclaude -c\nEOF", "held", False),      # heredoc text for cat is data
    ("bash <<'EOF'\nclaude -p -c hi\nEOF", "held", True),            # a heredoc fed to a shell runs
    ("cat > n.md <<'EOF'\ndon't\nEOF\nclaude -p -c hi", "held", True),
])
def test_continue_cwd_tracking(command, where, denied, held):
    hdir, fdir = held
    cwd = {"held": hdir, "free": fdir, "held/sub": os.path.join(hdir, "sub")}[where]
    v = rg.check(command.format(held=hdir, free=fdir), procs=make_table(), cwd=cwd)
    assert bool(v and v[0] == "deny") is denied, (command, v)


@pytest.mark.parametrize("command, denied", [
    ("claude --resume", True), ("claude -p --resume", True), ("claude --resume -p hi", True),
    ("claude -r", True), ("claude --resume=", True), ("claude --resume --fork-session", False),
    ("claude --from-pr 12", True), ("claude --from-pr 12 --fork-session", False),
    ("claude --session-id %s -p hi" % LIVE_SID, True), ("claude --session-id=%s -p hi" % LIVE_SID, True),
    ("claude --session-id %s --fork-session --resume %s -p hi" % (LIVE_SID, LIVE_SID), True),
    ("claude --session-id 2b1f6c3e-0000-4000-8000-000000000000 -p hi", False),
    ("claude --resume %s --fork-session -p hi" % LIVE_SID, False),
    ("claude -pr %s hi" % LIVE_SID, True), ("claude -r%s" % LIVE_SID, True),
    ("ssh host claude --resume %s" % LIVE_SID, True),                # an explicit live id anywhere
    ("echo claude --resume", False),                                 # bare resume only as the command
])
def test_resume_session_id_from_pr(command, denied, held):
    v = rg.check(command, procs=make_table(), cwd=held[1])
    assert bool(v and v[0] == "deny") is denied, (command, v)


def test_continue_holder_cwd_from_proc(tmp_path, monkeypatch):
    """Runtime-state entries carry no cwd: the holder's /proc/<pid>/cwd is used."""
    state = tmp_path / "rs.json"
    state.write_text(json.dumps([{"providerSessionId": "p1", "pid": os.getpid(), "state": "idle-held"}]))
    monkeypatch.setattr(rg, "STATE_FILE", str(state))
    assert rg.check("claude -p -c hi", procs=make_table(), cwd=os.getcwd())[0] == "deny"
    assert rg.check("claude -p -c hi", procs=make_table(), cwd=str(tmp_path)) is None


def test_continue_dead_holder_ignored(tmp_path, monkeypatch):
    state = tmp_path / "rs.json"
    state.write_text(json.dumps([{"providerSessionId": "p1", "pid": _dead_pid(), "cwd": str(tmp_path)}]))
    monkeypatch.setattr(rg, "STATE_FILE", str(state))
    assert rg.check("claude -p -c hi", procs=make_table(), cwd=str(tmp_path)) is None


def test_sessions_dir_holder_counts(tmp_path, monkeypatch):
    """~/.claude/sessions/<live pid>.json alone marks a holder (the .json filter now matches)."""
    sdir = tmp_path / "sessions"
    sdir.mkdir()
    (sdir / ("%d.json" % os.getpid())).write_text(json.dumps(
        {"sessionId": "sess-term", "pid": os.getpid(), "cwd": str(tmp_path), "kind": "interactive"}))
    (sdir / "notes.txt").write_text("{}")
    monkeypatch.setattr(rg, "SESSIONS_DIR", str(sdir))
    assert rg.check("claude -p -c hi", procs=make_table(), cwd=str(tmp_path))[0] == "deny"
    assert rg.check("claude -p --resume sess-term hi", procs=make_table(), cwd="/")[0] == "deny"
    assert rg.check("claude -p --resume sess-other hi", procs=make_table(), cwd="/") is None


def test_continue_fail_open_on_holder_error(held, monkeypatch):
    def boom(*a, **k):
        raise OSError("no state")
    monkeypatch.setattr(rg, "_live_holder_cwds", boom)
    assert rg.check("claude -p -c hi", procs=make_table(), cwd=held[0]) is None


# ── QA-rig exemption: session forms only, leading assignments of the same segment only ──
QA = "CLOUDCLI_QA_SCRATCH=1 HOME=/var/tmp/claude/cc-scratch/qa1 "


@pytest.mark.parametrize("command", [
    QA + "claude -p --resume %s x" % LIVE_SID,
    "env CLOUDCLI_QA_SCRATCH=1 HOME=/var/tmp/claude/cc-scratch/ claude -p --resume %s x" % LIVE_SID,
    "HOME=/var/tmp/claude/cc-scratch/q CLOUDCLI_QA_SCRATCH=1 claude -p -c x",
    "cd /tmp && " + QA + "claude -p --resume %s x" % LIVE_SID,
])
def test_qa_scratch_session_forms_exempt(command, live_sessions):
    assert rg.check(command, procs=make_table(), cwd="/tmp") is None, command


@pytest.mark.parametrize("command", [
    "CLOUDCLI_QA_SCRATCH=1 HOME=/var/tmp/claude/cc-scratchX claude -p --resume %s x" % LIVE_SID,
    "CLOUDCLI_QA_SCRATCH=1 HOME=/var/tmp/claude/cc-scratch/../../../../root claude -p --resume %s x" % LIVE_SID,
    "claude -p --resume %s x # CLOUDCLI_QA_SCRATCH=1 HOME=/var/tmp/claude/cc-scratch/q" % LIVE_SID,
    "claude -p --resume %s \"CLOUDCLI_QA_SCRATCH=1 HOME=/var/tmp/claude/cc-scratch/q\"" % LIVE_SID,
    "\"CLOUDCLI_QA_SCRATCH=1\" HOME=/var/tmp/claude/cc-scratch/q claude -p --resume %s x" % LIVE_SID,
    "export CLOUDCLI_QA_SCRATCH=1 HOME=/var/tmp/claude/cc-scratch/q; claude -p --resume %s x" % LIVE_SID,
    "CLOUDCLI_QA_SCRATCH=0 HOME=/var/tmp/claude/cc-scratch/q claude -p --resume %s x" % LIVE_SID,
    "CLOUDCLI_QA_SCRATCH=1 HOME=$SCR claude -p --resume %s x" % LIVE_SID,
    "CLOUDCLI_QA_SCRATCH=1 claude -p --resume %s x" % LIVE_SID,     # tool cwd under scratch, no HOME
    QA + "bash -c \"claude -p --resume %s x\"" % LIVE_SID,          # does not reach nested shells
])
def test_qa_scratch_exemption_not_spoofable(command, live_sessions):
    v = rg.check(command, procs=make_table(), cwd="/var/tmp/claude/cc-scratch/qa1")
    assert v and v[0] == "deny", command


# ── D1 2026-10-11: the launch guard's former documented limits, aimed at a LIVE session id ──
def _b64(text):
    return __import__("base64").b64encode(text.encode()).decode()


_SVC_RESTART = "systemctl " + "re" + "start " + "cloud" + "cli"
_SVC_STATUS = "systemctl status " + "cloud" + "cli"


@pytest.mark.parametrize("command", [
    "X=claude; $X --resume %s" % LIVE_SID,
    "npx @anthropic-ai/claude-code --resume %s" % LIVE_SID,
    "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume %s" % LIVE_SID,
    "echo 'claude -p --resume %s x' | at now" % LIVE_SID,
    "coproc claude --resume %s" % LIVE_SID,
    "ln -sf /usr/local/bin/claude /tmp/cc; /tmp/cc --resume %s" % LIVE_SID,
    "ln -s \"$(which claude)\" cc && ./cc --session-id %s" % LIVE_SID,
    "ssh localhost 'claude --resume %s'" % LIVE_SID,
    "echo %s | base64 -d | bash" % _b64("claude --resume " + LIVE_SID),
    "eval \"$(echo %s | base64 -d)\"" % _b64("claude -r " + LIVE_SID),
    "echo %s | base64 --decode | sh" % _b64(_SVC_RESTART),
])
def test_d1_shapes_with_live_sid_denied(command, live_sessions):
    v = rg.check(command, procs=make_table())
    assert v and v[0] == "deny", command


@pytest.mark.parametrize("command", [
    "ln -sf /usr/local/bin/claude /tmp/cc; /tmp/cc --resume not-a-live-id",
    "ln -s /etc/hosts /tmp/cc; /tmp/cc --resume %s" % LIVE_SID,
    "ln -sf /usr/local/bin/claude /tmp/cc; ls -la /tmp/cc",
    "echo %s | base64 -d | bash" % _b64("claude --resume not-a-live-id"),
    "echo %s | base64 -d > notes.txt" % _b64(_SVC_RESTART),
    "echo %s | base64 -d | bash" % _b64("ls -la"),
])
def test_d1_neighbours_allowed(command, live_sessions):
    assert rg.check(command, procs=make_table()) is None, command


def test_d1_decoded_payload_writes_no_nested_attribution(live_sessions, _private_state):
    cmd = "echo %s | base64 -d | bash" % _b64(_SVC_STATUS)
    assert rg.check(cmd, procs=make_table()) is None
    text = _private_state.read_text() if _private_state.exists() else ""
    assert _SVC_STATUS not in text


# ── gate-wave2 F3 (2026-10-11): safe-restart's env test hooks are test-only ──
# Negative controls: the pre-fix hook allows each of these (the --now one only asks).
SR = "${AI_SETUP_ROOT}/scripts/safe-restart.sh"
SAFE_TEST_ENV_DENIED = [
    "SAFE_RESTART_TEST=1 %s cloudcli --reason x" % SR,
    "SAFE_RESTART_PROC_ROOT=/var/tmp/claude/p %s cloudcli" % SR,
    "env CLOUDCLI_RUNTIME_STATE=/var/tmp/claude/s.json %s cloudcli" % SR,
    "sudo env SAFE_RESTART_CGROUP_ROOT=/var/tmp/claude/cg safe-restart.sh cloudcli",
    "export SAFE_RESTART_TEST=1; %s cloudcli" % SR,
    "export CLOUDCLI_RUNTIME_STATE=/tmp/s && bash %s cloudcli --max-wait 30" % SR,
    "SAFE_RESTART_PROC_ROOT=/tmp/p; export SAFE_RESTART_PROC_ROOT; safe-restart.sh cloudcli",
    "SAFE_RESTART_TEST=1; %s cloudcli" % SR,
    "bash -c 'SAFE_RESTART_TEST=1 %s cloudcli'" % SR,
    "env -S 'SAFE_RESTART_TEST=1 %s cloudcli'" % SR,
    "SAFE_RESTART_TEST=1 safe-restart cloudcli",
    "SAFE_RESTART_TEST=1 %s cloudcli --now" % SR,  # deny beats the --now ask
    "echo %s | base64 -d | bash" % _b64("SAFE_RESTART_TEST=1 %s cloudcli" % SR),
]


@pytest.mark.parametrize("command", SAFE_TEST_ENV_DENIED)
def test_safe_restart_test_env_denied(command):
    v = decision(command)
    assert v and v[0] == "deny" and "safe-restart test hooks are test-only" in v[1], command


@pytest.mark.parametrize("command,expected", [
    ("%s cloudcli --reason x" % SR, None),  # unchanged: allowed
    ("%s cloudcli --now" % SR, "ask"),  # unchanged: asks the owner
    ("%s cloudcli; SAFE_RESTART_TEST=1 python3 -m pytest -q tests/test_safe_restart.py" % SR, None),
    ("SAFE_RESTART_TEST=1 python3 -m pytest -q ${AI_SETUP_ROOT}/scripts/tests/test_safe_restart.py", None),
    ("SAFE_RESTART_TEST=1; grep -n SAFE_RESTART_TEST %s" % SR, None),
    ("SAFE_RESTART_TEST=1 systemctl status safe-restart-cloudcli-1791405109", None),
    ("echo $SAFE_RESTART_TEST; %s cloudcli" % SR, None),
])
def test_safe_restart_without_test_env_keeps_verdict(command, expected):
    v = decision(command)
    assert (v[0] if v else None) == expected, command


def test_safe_restart_test_env_end_to_end():
    code, out, _ = run_hook("restart-guard.py", _bash("SAFE_RESTART_TEST=1 %s cloudcli --reason x" % SR))
    assert code == 0
    spec = json.loads(out)["hookSpecificOutput"]
    assert spec["permissionDecision"] == "deny"
    assert "safe-restart test hooks are test-only" in spec["permissionDecisionReason"]
    assert "safe-restart.sh cloudcli" in spec["permissionDecisionReason"]


def test_safe_restart_test_env_check_fails_open(monkeypatch):
    def boom(_text):
        raise RuntimeError("boom")
    monkeypatch.setattr(rg, "_safe_restart_test_env", boom)
    assert decision("SAFE_RESTART_TEST=1 %s cloudcli --reason x" % SR) is None
