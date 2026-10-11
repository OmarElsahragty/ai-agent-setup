"""secret-write-guard PreToolUse hook tests (deny secret literals, allow .env + placeholders).

Fake credential material is ASSEMBLED at runtime from fragments so this test file itself
never contains a literal secret-shaped string on disk.
"""
import json
import os
import subprocess
import sys

import pytest

from conftest import HOOKS_DIR, load_hook, run_hook

_NEGCTL_SRC = "${AI_SETUP_ROOT}/scripts/hooks/secret-write-guard.py"
if os.environ.get("FILE_LEASE_NEGATIVE_CONTROL") == "1" and os.path.exists(_NEGCTL_SRC):
    # negative control: the ORIGINAL (live) guard — the new denies below must fail against it
    swg = load_hook(_NEGCTL_SRC, unique_name="swg_negctl")
else:
    swg = load_hook("secret-write-guard.py")


def _run_swg(payload):
    path = _NEGCTL_SRC if os.environ.get("FILE_LEASE_NEGATIVE_CONTROL") == "1" else \
        os.path.join(HOOKS_DIR, "secret-write-guard.py")
    proc = subprocess.run([sys.executable, path], input=json.dumps(payload).encode("utf-8"),
                          capture_output=True, timeout=10)
    return proc.returncode, proc.stdout.decode("utf-8", "replace"), proc.stderr.decode("utf-8", "replace")

FAKE_OPENAI = "sk-" + "THISISAFAKEKEY" + "1234567890" + "abcd"
FAKE_GHP = "ghp_" + "1" * 36
AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE2"
SLACK_TOKEN = "xoxb-" + "123456789012-" + "abcdef"
SERVICE_PW = "Sup3r" + "S3cret!"
DSN_PW = "hunter" + "2secret"
ENV_PW = "real-" + "secret-" + "value"
PEM_BEGIN = "-----BEGIN RSA " + "PRIVATE KEY-----"
PEM_END = "-----END RSA " + "PRIVATE KEY-----"


def _write(target, content):
    return {"tool_name": "Write", "tool_input": {"file_path": str(target), "content": content}}


def test_fake_key_in_py_denied(tmp_path):
    code, out, _ = run_hook("secret-write-guard.py",
                            _write(tmp_path / "app.py", f'OPENAI_API_KEY = "{FAKE_OPENAI}"\n'))
    assert code == 0
    spec = json.loads(out)["hookSpecificOutput"]
    assert spec["permissionDecision"] == "deny"
    assert "OPENAI_API_KEY" in spec["permissionDecisionReason"]
    assert FAKE_OPENAI not in out  # the value is never echoed


def test_negative_control_same_key_in_env_allowed(tmp_path):
    code, out, _ = run_hook("secret-write-guard.py",
                            _write(tmp_path / ".env", f"OPENAI_API_KEY={FAKE_OPENAI}\n"))
    assert code == 0
    assert out == ""


def test_env_like_targets_allowed(tmp_path):
    for name in (".env.production", "local.env"):
        code, out, _ = run_hook("secret-write-guard.py",
                                _write(tmp_path / name, f"DB_PASSWORD={ENV_PW}\n"))
        assert code == 0 and out == ""


def test_placeholder_values_allowed(tmp_path):
    content = ('OPENAI_API_KEY = "YOUR_KEY"\nSTRIPE_SECRET = "${KEY}"\n'
               'DB_PASSWORD: "{env:PW}"\nAWS_SECRET = "<secret>"\n'
               'GH_TOKEN = "changeme"\nOTHER = "xxx"\nMORE = "***"\n')
    code, out, _ = run_hook("secret-write-guard.py", _write(tmp_path / "cfg.py", content))
    assert code == 0 and out == ""


def test_non_literal_values_allowed(tmp_path):
    content = ('OPENAI_API_KEY = os.environ["OPENAI_API_KEY"]\n'
               'DB_PASSWORD = settings.db_password\n'
               'API_TOKEN = getenv("API_TOKEN")\n')
    code, out, _ = run_hook("secret-write-guard.py", _write(tmp_path / "cfg.py", content))
    assert code == 0 and out == ""


def test_edit_new_string_ghp_denied(tmp_path):
    payload = {"tool_name": "Edit", "tool_input": {
        "file_path": str(tmp_path / "c.py"), "old_string": "a",
        "new_string": f"GITHUB_TOKEN={FAKE_GHP}\n"}}
    code, out, _ = run_hook("secret-write-guard.py", payload)
    assert code == 0
    spec = json.loads(out)["hookSpecificOutput"]
    assert spec["permissionDecision"] == "deny"
    assert FAKE_GHP not in out


def test_multiedit_edits_scanned(tmp_path):
    payload = {"tool_name": "MultiEdit", "tool_input": {
        "file_path": str(tmp_path / "c.py"),
        "edits": [{"old_string": "a", "new_string": "x = 1\n"},
                  {"old_string": "b", "new_string": f"MY_SERVICE_PASSWORD={SERVICE_PW}\n"}]}}
    code, out, _ = run_hook("secret-write-guard.py", payload)
    assert code == 0
    reason = json.loads(out)["hookSpecificOutput"]["permissionDecisionReason"]
    assert "MY_SERVICE_PASSWORD" in reason
    assert SERVICE_PW not in out


def test_dsn_with_password_denied(tmp_path):
    url = "postgresql://" + "app:" + DSN_PW + "@db.local:5432/prod"
    code, out, _ = run_hook("secret-write-guard.py",
                            _write(tmp_path / "db.py", f'URL = "{url}"\n'))
    assert code == 0
    reason = json.loads(out)["hookSpecificOutput"]["permissionDecisionReason"]
    assert "DSN" in reason and DSN_PW not in out


def test_dsn_with_env_var_allowed(tmp_path):
    url = "postgresql://" + "app:" + "${DB_PASS}" + "@db.local:5432/prod"
    code, out, _ = run_hook("secret-write-guard.py",
                            _write(tmp_path / "db.py", f'URL = "{url}"\n'))
    assert code == 0 and out == ""


def test_pem_private_key_denied(tmp_path):
    content = f"key = '''{PEM_BEGIN}\nMIIEow...\n{PEM_END}'''\n"
    code, out, _ = run_hook("secret-write-guard.py", _write(tmp_path / "k.py", content))
    assert code == 0
    assert json.loads(out)["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_aws_and_slack_tokens_denied(tmp_path):
    code, out, _ = run_hook("secret-write-guard.py",
                            _write(tmp_path / "a.py", f'k = "{AWS_KEY}"\n'))
    assert code == 0 and json.loads(out)["hookSpecificOutput"]["permissionDecision"] == "deny"
    code, out, _ = run_hook("secret-write-guard.py",
                            _write(tmp_path / "b.py", f'k = "{SLACK_TOKEN}"\n'))
    assert code == 0 and json.loads(out)["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_google_key_denied_via_live_scrub_patterns(tmp_path):
    # Google AIza shape lives ONLY in scrub.py SECRET_PATTERNS — this proves the
    # guard's external_patterns() wiring is live, not a stale copy.
    gkey = "AIza" + "a" * 35
    code, out, _ = run_hook("secret-write-guard.py",
                            _write(tmp_path / "g.py", f'GOOGLE_KEY = "{gkey}"\n'))
    assert code == 0
    spec = json.loads(out)["hookSpecificOutput"]
    assert spec["permissionDecision"] == "deny"
    assert gkey not in out


def test_ordinary_code_allowed(tmp_path):
    code, out, _ = run_hook("secret-write-guard.py",
                            _write(tmp_path / "plain.py", "x = 1\nprint(x * 2)\n"))
    assert code == 0 and out == ""


def test_fails_open_on_garbage_stdin():
    proc = subprocess.run([sys.executable, os.path.join(HOOKS_DIR, "secret-write-guard.py")],
                          input=b"this is not json", capture_output=True, timeout=10)
    assert proc.returncode == 0 and proc.stdout == b""


# every hook that does json.load(sys.stdin) + .get must fail open on non-dict JSON
STDIN_HOOKS = [h for h in ("secret-write-guard.py", "gateguard.py", "suggest-compact.py",
                           "post-edit-check.py", "guard-study-delete.py", "allow-scratch-rm.py",
                           "postcompact-anchor.py")
               if os.path.isfile(os.path.join(HOOKS_DIR, h))]  # worktree omits live-only hooks


@pytest.mark.parametrize("payload", [[1, 2, 3], "just a string", 42, 3.5])
@pytest.mark.parametrize("script", STDIN_HOOKS)
def test_non_dict_json_stdin_fails_open(script, payload):
    code, out, err = run_hook(script, payload)
    assert code == 0 and out == "" and err == ""


# ------------------------------------------------------------------ Bash pass
def _bash(command):
    return {"tool_name": "Bash", "tool_input": {"command": command}}


def _denied(payload):
    code, out, _ = _run_swg(payload)
    assert code == 0
    spec = json.loads(out)["hookSpecificOutput"]
    assert spec["permissionDecision"] == "deny"
    return spec["permissionDecisionReason"]


def _allowed(payload):
    code, out, _ = _run_swg(payload)
    assert code == 0
    assert out == ""
    return out


def test_bash_heredoc_fake_key_denied(tmp_path):
    # negative control from the work order: fake key heredoc -> deny
    cmd = "cat <<'EOF' > %s\nOPENAI_API_KEY=%s\nEOF" % (tmp_path / "app.py", FAKE_OPENAI)
    reason = _denied(_bash(cmd))
    assert "OPENAI_API_KEY" in reason and FAKE_OPENAI not in reason


def test_bash_echo_env_var_redirect_allowed(tmp_path):
    # negative control: $VAR reference (no literal) must pass even though it writes
    _allowed(_bash('echo "$OPENAI_API_KEY" > %s' % (tmp_path / "out.txt")))


def test_bash_cat_read_only_allowed(tmp_path):
    # negative control: pure read, no write, no literal
    _allowed(_bash("cat %s" % (tmp_path / "file.py")))


def test_bash_redirect_literal_token_denied(tmp_path):
    reason = _denied(_bash('echo "%s" > %s' % (FAKE_GHP, tmp_path / "cfg.sh")))
    assert "GitHub token" in reason and FAKE_GHP not in reason


def test_bash_export_assignment_redirect_denied(tmp_path):
    # line-anchored assignment: export NAME=literal with a redirect in the command
    # (filename avoids "settings." — the guard's intentional non-literal heuristic)
    cmd = "export SERVICE_PASSWORD=%s >> %s" % (SERVICE_PW, tmp_path / "deploy.sh")
    reason = _denied(_bash(cmd))
    assert "SERVICE_PASSWORD" in reason and SERVICE_PW not in reason


def test_bash_tee_with_token_denied(tmp_path):
    cmd = "echo %s | tee %s" % (FAKE_OPENAI, tmp_path / "config.py")
    reason = _denied(_bash(cmd))
    assert FAKE_OPENAI not in reason


def test_bash_sed_inplace_with_token_denied(tmp_path):
    cmd = "sed -i 's/old/%s/' %s" % (FAKE_GHP, tmp_path / "conf.py")
    _denied(_bash(cmd))


def test_bash_sed_inplace_env_allowed(tmp_path):
    _allowed(_bash("sed -i 's/^KEY=.*/KEY=x/' %s" % (tmp_path / ".env")))


def test_bash_python_c_open_w_denied(tmp_path):
    cmd = "python3 -c \"open('%s','w').write('API_TOKEN=%s\\n')\"" % (tmp_path / "t.py", FAKE_OPENAI)
    _denied(_bash(cmd))


def test_bash_python_c_read_only_allowed(tmp_path):
    cmd = "python3 -c \"print(open('%s').read())\"" % (tmp_path / "plain.py")
    _allowed(_bash(cmd))


def test_bash_write_to_env_target_allowed(tmp_path):
    # secrets belong in .env: every named sink is an env file -> allow
    _allowed(_bash("echo OPENAI_API_KEY=%s >> %s" % (FAKE_OPENAI, tmp_path / ".env")))
    _allowed(_bash("echo %s | tee %s" % (FAKE_OPENAI, tmp_path / "prod.env")))


def test_bash_plain_commands_without_literals_allowed(tmp_path):
    _allowed(_bash("ls -la && git status --short"))
    _allowed(_bash("pytest -q tests > /dev/null 2>&1"))
    _allowed(_bash("cat %s | grep -c def" % (tmp_path / "file.py")))


def test_bash_non_write_secret_command_allowed():
    # a literal token in a command that writes NO file is out of scope (Edit-path parity)
    _allowed(_bash("echo done"))


# ------------------------------------------- round 3: unanchored bash assignments
def test_bash_echo_unanchored_assignment_denied(tmp_path):
    # echo 'SOME_API_KEY=<literal>' > notes.txt — assignment NOT at line start
    cmd = "echo 'SOME_API_KEY=%s' > %s" % (SERVICE_PW, tmp_path / "notes.txt")
    reason = _denied(_bash(cmd))
    assert "SOME_API_KEY" in reason and SERVICE_PW not in reason


def test_bash_echo_unanchored_placeholder_allowed(tmp_path):
    # negative control: placeholder / $VAR / ${VAR} values pass the unanchored scan
    for value in ("changeme", "$MY_KEY", "${MY_KEY}"):
        _allowed(_bash("echo 'SOME_API_KEY=%s' > %s" % (value, tmp_path / "notes.txt")))


def test_bash_printf_secret_literal_arg_denied(tmp_path):
    # printf "TOKEN=%s" <literal> >> x.md — the literal arrives as a printf argument
    cmd = 'printf "SERVICE_TOKEN=%%s" "%s" >> %s' % (SERVICE_PW, tmp_path / "x.md")
    reason = _denied(_bash(cmd))
    assert "SERVICE_TOKEN" in reason and SERVICE_PW not in reason


def test_bash_printf_env_var_arg_allowed(tmp_path):
    # negative control: the value comes from a variable — no literal on the command
    _allowed(_bash('printf "SERVICE_TOKEN=%%s" "$SERVICE_TOKEN" >> %s'
                   % (tmp_path / "x.md")))


# ------------------------------------------------- round 3: .env content copies
def test_bash_cat_env_into_non_env_denied(tmp_path):
    reason = _denied(_bash("cat .env > %s" % (tmp_path / "notes.txt")))
    assert ".env" in reason and "notes.txt" in reason
    reason = _denied(_bash("cat ${AI_SETUP_ROOT}/.env >> %s" % (tmp_path / "y.txt")))
    assert ".env" in reason and "y.txt" in reason


def test_bash_cp_env_into_non_env_denied(tmp_path):
    reason = _denied(_bash("cp .env %s" % (tmp_path / "backup.txt")))
    assert ".env" in reason and "backup.txt" in reason


def test_bash_tee_from_env_denied(tmp_path):
    _denied(_bash("cat .env | tee %s" % (tmp_path / "out.txt")))
    _denied(_bash("tee %s < .env" % (tmp_path / "out.txt")))


def test_bash_env_copy_near_misses_allowed(tmp_path):
    # negative controls: examples stay allowed; no write target, env destination, or
    # env->env copy. env_target() is the single source: basename(".env.bak") starts
    # with ".env." so cp a/.env b/.env.bak is an env->env copy and passes.
    _allowed(_bash("cp .env.example .env"))
    _allowed(_bash("cat .env.example"))
    _allowed(_bash("cat .env | grep -c KEY"))
    _allowed(_bash("cp a/.env b/.env.bak"))


# ----------------------------- round 4: bare names, colon form, new write sinks
BARE_PW = "bare" + "-pw-" + "7qx"
YAML_PW = "pg" + "-yaml-" + "pw9"


def test_file_pass_bare_names_denied(tmp_path):
    for name in ("PASSWORD", "TOKEN", "API_KEY", "SECRET", "PASSWD"):
        payload = _write(tmp_path / "app.py", "%s = \"%s\"\n" % (name, BARE_PW))
        code, out, _ = run_hook("secret-write-guard.py", payload)
        assert code == 0
        reason = json.loads(out)["hookSpecificOutput"]["permissionDecisionReason"]
        assert name in reason and BARE_PW not in out


def test_file_pass_bare_name_near_misses_allowed(tmp_path):
    # the reviewer's false-positive watch list: env references, getpass(),
    # argparse plumbing and placeholders must all stay allowed
    content = ('TOKEN = os.environ["TOKEN"]\n'
               'PASSWORD = getenv("PASSWORD")\n'
               'password = getpass()\n'
               'api_key = args.api_key\n'
               'PASSWORD = "${PW}"\n')
    code, out, _ = run_hook("secret-write-guard.py", _write(tmp_path / "cfg.py", content))
    assert code == 0 and out == ""


def test_bash_bare_name_assignment_denied(tmp_path):
    cmd = 'echo "PASSWORD=%s" > %s' % (BARE_PW, tmp_path / "notes.txt")
    reason = _denied(_bash(cmd))
    assert "PASSWORD" in reason and BARE_PW not in reason


def test_bash_bare_name_var_ref_allowed(tmp_path):
    _allowed(_bash('echo "PASSWORD=$PW" > %s' % (tmp_path / "notes.txt")))
    _allowed(_bash('printf "TOKEN=%%s" "$TOKEN" > %s' % (tmp_path / "notes.txt")))


def test_bash_printf_bare_name_literal_denied(tmp_path):
    cmd = 'printf "PASSWORD=%%s" "%s" >> %s' % (BARE_PW, tmp_path / "x.md")
    reason = _denied(_bash(cmd))
    assert "PASSWORD" in reason and BARE_PW not in reason


def test_bash_heredoc_colon_form_yaml_denied(tmp_path):
    # REQ2: the Bash pass catches the YAML colon form the file pass already catches
    cmd = "cat <<'EOF' > %s\ndb:\n  DB_PASSWORD: %s\nEOF" % (tmp_path / "app.yaml", YAML_PW)
    reason = _denied(_bash(cmd))
    assert "DB_PASSWORD" in reason and YAML_PW not in reason


def test_bash_echo_colon_form_conf_denied(tmp_path):
    cmd = 'echo "DB_PASSWORD: %s" > %s' % (YAML_PW, tmp_path / "app.conf")
    reason = _denied(_bash(cmd))
    assert "DB_PASSWORD" in reason and YAML_PW not in reason


def test_bash_colon_form_near_misses_allowed(tmp_path):
    _allowed(_bash('echo "DB_PASSWORD: ${DB_PW}" > %s' % (tmp_path / "app.yaml")))
    _allowed(_bash('echo "DB_PASSWORD: null" > %s' % (tmp_path / "app.yaml")))
    _allowed(_bash('echo "PORT: 5432" > %s' % (tmp_path / "app.conf")))


def test_bash_dd_of_secret_denied(tmp_path):
    cmd = 'echo "API_KEY=%s" | dd of=%s' % (BARE_PW, tmp_path / "out.conf")
    reason = _denied(_bash(cmd))
    assert "API_KEY" in reason and BARE_PW not in reason


def test_bash_dd_near_misses_allowed(tmp_path):
    _allowed(_bash("dd if=/dev/zero of=%s bs=1k count=2" % (tmp_path / "blank.bin")))
    _allowed(_bash('echo "TOKEN=$T" | dd of=%s' % (tmp_path / "x.txt")))


def test_bash_python_path_write_text_denied(tmp_path):
    cmd = ("python3 -c \"from pathlib import Path; "
           "Path('%s').write_text('DB_PASSWORD=%s\\n')\"" % (tmp_path / "p.py", BARE_PW))
    reason = _denied(_bash(cmd))
    assert "DB_PASSWORD" in reason and BARE_PW not in reason


def test_bash_python_path_write_bytes_no_secret_allowed(tmp_path):
    cmd = ("python3 -c \"from pathlib import Path; "
           "Path('%s').write_bytes(b'hello')\"" % (tmp_path / "p.bin"))
    _allowed(_bash(cmd))


def test_bash_mv_env_into_non_env_denied(tmp_path):
    reason = _denied(_bash("mv .env %s" % (tmp_path / "notes.txt")))
    assert ".env" in reason and "notes.txt" in reason


def test_bash_install_env_into_non_env_denied(tmp_path):
    reason = _denied(_bash("install -m 600 .env %s" % (tmp_path / "backup.conf")))
    assert ".env" in reason and "backup.conf" in reason


def test_bash_mv_install_near_misses_allowed(tmp_path):
    _allowed(_bash("mv .env .env.bak"))
    _allowed(_bash("mv %s %s" % (tmp_path / "a.txt", tmp_path / "b.txt")))
    _allowed(_bash("install -m 755 script.sh %s" % (tmp_path / "bin" / "script.sh")))


# ------------------------------------------------- Q4 (2026-10-10): test fixtures
# Owner ruling Q4 / M-041: in a file under */tests/* (plural only), a quoted literal that starts
# with test-/test_/fake-/fake_/dummy-/dummy_ is a fixture, not a secret. Nothing else changes.
# Values are assembled at runtime, like the fakes above, so this file holds no secret shapes.
Q4_DSN = "postgres" + "://u:" + DSN_PW + "@h/db"
Q4_FIX = "test-hub-" + "token"
Q4_TESTING = "testing-" + "value"


def _tests_file(tmp_path, name="test_hub_token.py", folder="tests"):
    return tmp_path / "pkg" / folder / name


def _assign(name, value, quote='"'):
    return "%s = %s%s%s\n" % (name, quote, value, quote)


@pytest.mark.parametrize("value", [Q4_FIX, "test_" + "token_value", "fake-" + "k" * 20,
                                   "fake_secret", "dummy-pass", "dummy_" + "api_key"])
def test_q4_fixture_assignment_in_tests_dir_allowed(tmp_path, value):
    content = _assign("HUB_TOKEN", value) + _assign("API_KEY", value, "'")
    _allowed(_write(_tests_file(tmp_path), content))


def test_q4_singular_test_dir_denied_nested_tests_fixture_dir_allowed(tmp_path):
    # owner ruling Q4 (2026-10-10): TEST_DIRS is ("tests",) only; a singular test/ dir is ordinary
    reason = _denied(_write(_tests_file(tmp_path, "conftest.py", "test"), _assign("DB_PASSWORD", "test-pw")))
    assert "DB_PASSWORD" in reason and "test-pw" not in reason
    nested = tmp_path / "svc" / "tests" / "fixtures" / "settings.py"
    _allowed(_write(nested, _assign("SECRET_KEY", "fake_" + "django_key")))
    assert swg.TEST_DIRS == ("tests",)


def test_q4_token_shape_and_dsn_inside_fixture_literal_allowed(tmp_path):
    content = (_assign("OPENAI_API_KEY", "fake-" + FAKE_OPENAI) + _assign("GH", "test_" + FAKE_GHP)
               + _assign("DSN", "dummy-" + Q4_DSN))
    _allowed(_write(_tests_file(tmp_path), content))


def test_q4_unquoted_fixture_assignment_value_allowed(tmp_path):
    _allowed(_write(_tests_file(tmp_path, "fixture.conf"), "API_TOKEN=test-abc\nPASSWORD: fake_pw\n"))


def test_q4_edit_and_multiedit_in_tests_dir_allowed(tmp_path):
    target = str(_tests_file(tmp_path))
    _allowed({"tool_name": "Edit", "tool_input": {
        "file_path": target, "old_string": "x", "new_string": _assign("AUTH_TOKEN", "test-auth")}})
    _allowed({"tool_name": "MultiEdit", "tool_input": {"file_path": target, "edits": [
        {"old_string": "a", "new_string": _assign("ACCESS_TOKEN", "fake-access")}]}})


def test_q4_negative_control_same_fixture_outside_tests_dir_denied(tmp_path):
    for target in (tmp_path / "pkg" / "hub_token.py", tmp_path / "testing" / "x.py",
                   tmp_path / "mytests" / "x.py", tmp_path / "pkg" / "tests.py",
                   tmp_path / "tests" / ".." / "app.py"):
        reason = _denied(_write(target, _assign("HUB_TOKEN", Q4_FIX)))
        assert "HUB_TOKEN" in reason and Q4_FIX not in reason


@pytest.mark.parametrize("content", [
    _assign("HUB_TOKEN", SERVICE_PW),             # no fixture prefix
    _assign("HUB_TOKEN", "TEST-upper"),           # the prefix is case-sensitive
    _assign("HUB_TOKEN", Q4_TESTING),             # test- / test_ only
    _assign("HUB_TOKEN", "faketoken"),            # the prefix needs - or _
    _assign("KEY", FAKE_OPENAI),                  # a bare token shape
    'KEY = "fake-" "%s"\n' % FAKE_OPENAI,         # the second literal is not a fixture
    _assign("DSN", Q4_DSN),                       # a DSN literal without the prefix
    PEM_BEGIN + "\nabc\n" + PEM_END + "\n",
])
def test_q4_non_fixture_literals_in_tests_dir_still_denied(tmp_path, content):
    _denied(_write(_tests_file(tmp_path), content))


def test_q4_bash_heredoc_into_tests_file_allowed_elsewhere_denied(tmp_path):
    body = _assign("HUB_TOKEN", Q4_FIX, "'") + _assign("KEY", "fake-" + FAKE_OPENAI)
    _allowed(_bash("cat <<'EOF' > %s\n%sEOF" % (_tests_file(tmp_path), body)))
    _denied(_bash("cat <<'EOF' > %s\n%sEOF" % (tmp_path / "pkg" / "app.py", body)))


def test_q4_bash_relative_target_resolved_against_cwd(tmp_path):
    payload = _bash("echo 'API_TOKEN=test-abc' > conftest.txt")
    payload["cwd"] = str(tmp_path / "proj" / "tests")
    _allowed(payload)
    payload["cwd"] = str(tmp_path / "proj" / "src")
    _denied(payload)
    _allowed(_bash("echo 'API_TOKEN=test-abc' > tests/conftest.txt"))
    _allowed(_bash("printf 'API_TOKEN=%s\\n' 'fake_value' > tests/conftest.txt"))


def test_q4_bash_mixed_targets_or_unnamed_sink_still_denied(tmp_path):
    both = "echo 'API_TOKEN=test-abc' | tee %s %s" % (_tests_file(tmp_path), tmp_path / "app.cfg")
    _denied(_bash(both))
    unnamed = "python3 - <<'EOF'\nKEY = 'fake-%s'\nEOF" % FAKE_OPENAI   # no named sink: no Q4 allowance
    _denied(_bash(unnamed))
    _allowed(_bash("cat <<'EOF' > %s\nKEY = 'fake-%s'\nEOF" % (_tests_file(tmp_path), FAKE_OPENAI)))


def test_q4_env_copy_into_tests_dir_still_denied(tmp_path):
    reason = _denied(_bash("cp .env %s" % _tests_file(tmp_path, "env_copy.txt")))
    assert ".env" in reason


# Addendum #2 (B): a cd / pushd / popd in the command moves relative targets out of tests/.
@pytest.mark.parametrize("prefix", ["pushd .. && ", "cd .. && ", "cd ..; ", "cd /tmp && ",
                                    "cd ../../src\n", 'cd "$OLDPWD" && ', "cd - && ", "cd && ",
                                    "pushd && ", "builtin cd .. && "])
def test_q4_bash_change_dir_out_of_tests_denied(tmp_path, prefix):
    payload = _bash(prefix + "echo 'API_TOKEN=test-abc' > app.cfg")
    payload["cwd"] = str(tmp_path / "proj" / "tests")
    assert "API_TOKEN" in _denied(payload)


@pytest.mark.parametrize("prefix", ["", "cd sub && ", "pushd ./fixtures >/dev/null && ", "cd . && "])
def test_q4_bash_change_dir_within_tests_allowed(tmp_path, prefix):
    payload = _bash(prefix + "echo 'API_TOKEN=test-abc' > app.cfg")
    payload["cwd"] = str(tmp_path / "proj" / "tests")
    _allowed(payload)


def test_q4_bash_absolute_tests_target_after_cd_allowed(tmp_path):
    payload = _bash("cd /tmp && echo 'API_TOKEN=test-abc' > %s" % _tests_file(tmp_path, "x.cfg"))
    payload["cwd"] = str(tmp_path / "proj" / "src")
    _allowed(payload)


@pytest.mark.parametrize("target", ["$HOME/app.cfg", "~/app.cfg", "${OUT:-x}.cfg", "*.cfg"])
def test_q4_bash_unresolvable_target_from_tests_cwd_denied(tmp_path, target):
    payload = _bash("echo 'API_TOKEN=test-abc' > " + target)
    payload["cwd"] = str(tmp_path / "proj" / "tests")
    _denied(payload)


def test_bash_cwds_tracks_cd_pushd_popd():
    assert swg.bash_cwds("pushd a && pushd ../b; popd; echo x > f", "/r") == ["/r", "/r/a", "/r/b"]
    assert swg.bash_cwds("echo 'no dir change' > f", "/r") == ["/r"]
    assert swg.bash_cwds("cd $X && echo x > f", "/r") is None
    assert swg.bash_cwds("popd; echo x > f", "/r") is None


# Addendum item (1): the redirect parser is quote-aware; `>=`, `2>&1`, `>&2` are never targets.
@pytest.mark.parametrize("command", [
    "jq '.[] | select(.n >= 2)' data.json", "make 2>&1", "echo err >&2", "exec 3>&-",
    "awk '$1 > 5 {print}' f.txt", 'python3 -c "print(1 if a > b else 2)"',
    "[[ $a > $b ]] && echo ok", "(( a > b )) && echo y", "diff <(ls) >(cat)",
    'echo "a > b" # note > x', "echo a\\>b", "sqlite3 db 'select * from t where n >= 2'",
    "jq -r '.items[] | select(.size > 0) | .name' in.json 2>&1 | head"])
def test_bash_exact_targets_ignore_quoted_text_and_fd_dups(command):
    assert swg.bash_write_targets(command, quoted=False) == (False, [])


@pytest.mark.parametrize("command,target", [
    ("jq '.a > 1' x.json > out.json", "out.json"), ("echo hi > /tmp/x 2>&1", "/tmp/x"),
    ("echo hi &> log.txt", "log.txt"), ("echo hi &>> log.txt", "log.txt"), ("ls >| out", "out"),
    ("exec 3>f3", "f3"), ('cmd > "/tmp/a b"', "/tmp/a b"), ("echo x>y", "y"),
    ("cat <<'EOF' > out.txt\nline > not_a_target\nEOF", "out.txt"),
    ("bash -c 'echo hi > inner.txt'", "inner.txt"), ('sudo sh -c "echo hi >> /etc/x.conf"', "/etc/x.conf"),
    ("bash <<'EOF'\necho hi > fed.txt\nEOF", "fed.txt"), ("eval 'echo hi > ev.txt'", "ev.txt")])
def test_bash_exact_targets(command, target):
    assert swg.bash_write_targets(command, quoted=False)[1] == [target]


def test_bash_guard_mode_keeps_legacy_quoted_redirects():
    # this guard stays over-inclusive: text after `>` inside quotes is still a candidate sink
    command = "ssh host 'echo hi > remote.txt'"
    assert swg.bash_write_targets(command, quoted=False)[1] == []
    assert "remote.txt" in swg.bash_write_targets(command)[1]


def test_bash_nested_shell_write_with_secret_denied(tmp_path):
    _denied(_bash("sudo sh -c \"echo 'HUB_TOKEN=%s' > %s\"" % (SERVICE_PW, tmp_path / "app.cfg")))
    _allowed(_bash("sudo sh -c \"echo 'HUB_TOKEN=$HUB' > %s\"" % (tmp_path / "app.cfg")))
