"""agent-claude-launch-guard PreToolUse hook tests (GAP-8 owner ruling 2026-10-10).

Agents never launch interactive or background Claude Code sessions. Denied: a `claude` without
-p/--print in any form, and every `claude` (even -p) started through a launch vehicle (tmux,
screen, nohup, setsid, systemd-run, script -c, `&`, process substitution, run_in_background, ...)
or from inline code with a background marker. Allowed: foreground `claude -p ...` one-shots
(wrapped, piped, substituted), and the read-only --version/--help/mcp list/config forms.
End-to-end via subprocess; unit via check().
"""
import json
import os
import subprocess
import sys

import pytest

from conftest import HOOKS_DIR, load_hook

_ORIG = "/var/tmp/claude/acg-probe/orig/agent-claude-launch-guard.py"
if os.environ.get("FILE_LEASE_NEGATIVE_CONTROL") == "1" and os.path.exists(_ORIG):
    acg = load_hook(_ORIG, unique_name="acg_negctl")  # negative control: the ORIGINAL guard
else:
    acg = load_hook("agent-claude-launch-guard.py")

DENY = [
    # plain interactive launches
    "claude",
    "claude --resume abc-123",
    "claude -c",
    "claude --continue",
    "claude --dangerously-skip-permissions",
    "claude --model deepseek-v4.1-flash",
    "/usr/local/bin/claude",
    "/home/omar/.local/bin/claude --resume x",
    "claude.exe",
    '"claude"',
    "claude; echo done",
    "claude | tee /tmp/session.log",
    "claude > /tmp/session.log 2>&1",
    "claude 2>&1 | tee -a log",
    "claude &",
    "claude & disown",
    "( claude )",
    "( sleep 2; claude ) &",
    "{ claude; } &",
    "( claude; echo hi ) > log 2>&1 &",
    "sleep 5 && claude &",
    "true && claude",
    "claude\n",
    # wrappers around an interactive claude
    "sudo claude",
    "sudo -u omar claude",
    "env TERM=xterm claude",
    "ANTHROPIC_MODEL=deepseek-v4.1-flash claude",
    "nice -n 5 claude",
    "timeout 300 claude",
    "exec claude",
    "command claude",
    "time claude",
    # launch vehicles
    "nohup claude",
    "nohup claude --resume abc &",
    "setsid claude",
    "setsid -f claude",
    "setsid --wait claude",
    "systemd-run claude",
    "systemd-run --unit=cc claude",
    "systemd-run --user --description=agent claude",
    "script -c claude",
    'script -qc "claude" /dev/null',
    "script --command=claude",
    "script -q /dev/null -c 'claude --resume x'",
    # tmux
    "tmux new-session -d claude",
    "tmux new -s agent claude",
    "tmux new-session -d -x 220 -y 50 'claude'",
    "tmux new-window -t dev claude",
    "tmux neww claude",
    "tmux split-window claude",
    "tmux splitw -t dev claude",
    "tmux respawn-pane -k claude",
    "tmux respawn-window claude",
    "tmux send-keys -t dev claude Enter",
    "tmux send-keys -t dev 'claude' C-m",
    "tmux send -t dev claude Enter",
    'tmux send-keys -t dev "claude --resume x" Enter',
    "tmux -c 'claude' new -d",
    "tmux -c claude new-session -d -s x",
    # tmux: even a -p one-shot is refused through the session vehicle
    "tmux new-session -d claude -p hi",
    "tmux new -d 'claude -p \"hi\"'",
    "tmux send-keys -t dev 'claude -p hi' Enter",
    # screen
    "screen -dmS cc claude",
    "screen -dm claude",
    "screen -S cc -X screen claude",
    "screen -S cc -X stuff 'claude\\n'",
    'screen -S cc -X stuff "claude -p hi^M"',
    "screen -dmS cc claude -p hi",
    # shells and substitution bodies
    'bash -c "claude"',
    "bash -c 'claude --resume x'",
    "sh -c claude",
    "bash -lc claude",
    'eval "claude"',
    "eval 'claude --resume x'",
    'su - omar -c "claude"',
    "su omar -c claude",
    'runuser -u omar -c "claude"',
    "echo x $(claude)",
    "echo `claude`",
    "diff <(claude) <(echo hi)",
    # heredoc feeding a shell (the body is the shell's script)
    "bash <<'EOF'\nclaude\nEOF",
    "sudo sh <<EOF\nclaude --resume x\nEOF",
    "bash -s <<'EOF'\nclaude\nEOF",
    # a script piped into a bare shell is that shell's stdin script
    'printf "%s" "claude" | bash',
    "echo 'claude' | sh",
    "echo claude | bash",
    # unquoted -c takes only the next word: this runs an interactive claude
    "runuser -u omar -c claude -p hi",
    # comments hiding a launch
    "true # start session\nclaude",
    # the ruling lists these vehicles without exception: a -p one-shot through them is denied
    "nohup claude -p hi > /tmp/one.log 2>&1 &",
    "setsid claude -p hi",
    "systemd-run --unit=oneshot claude -p hi",
    "script -qc 'claude -p hi' /dev/null",
    "claude -p hi &",
    "( claude -p hi ) &",
    "{ claude -p hi; } &",
    "nohup claude --version",
    "for i in 1 2; do claude -p hi; done &",
    # fix-pass 2026-10-10: substitutions as the command name
    'nohup "$(which claude)" --resume X &',
    '"$(command -v claude)" --resume X',
    "`which claude` --resume x",
    "$(which claude)",
    # fix-pass: heredocs / here-strings / pipes feeding a shell
    "cat <<'EOF' | bash\nclaude &\nEOF",
    "cat <<'EOF' | bash\nclaude\nEOF",
    "echo claude | bash &",
    'bash <<< "claude --resume x"',
    "bash -s <<< 'claude &'",
    # fix-pass: find / xargs clusters / clustered sudo values
    "find . -name x -exec claude --resume {} \\;",
    "find . -exec claude \\;",
    "xargs -ra file claude",
    "xargs -rn 1 claude",
    "sudo -iu omar claude",
    "sudo -Eu omar claude --resume abc",
    # fix-pass: interpreter code spawning claude
    'python3 -c "import subprocess; subprocess.Popen([\'claude\',\'--resume\',\'x\'])"',
    'node -e "require(\'child_process\').spawn(\'claude\', [\'--resume\',\'x\'], {detached:true})"',
    'perl -e \'system("claude --resume x &")\'',
    'python3 -c "import os; os.system(\'claude\')"',
    # fix-pass: --bg / --background / --cloud / --teleport in any form
    "claude --bg task",
    "claude --background x -p hi",
    "claude --cloud -p x",
    "claude --teleport -p x",
    "claude --bg=task -p x",
    # fix-pass: functions, case arms, tmux/screen extensions, flock/watch, odd names
    "f(){ claude & }; f",
    "function f { claude; }; f",
    "case x in x) claude --resume abc;; esac",
    "tmux run-shell 'claude -p hi'",
    "tmux display-popup -E claude",
    'screen -S w -X stuff "claude$(printf \\r)"',
    "screen -S w -X eval 'screen claude'",
    "flock /tmp/l claude --resume abc",
    "watch -n 60 claude --resume abc",
    "$'claude' --resume abc",
    "/usr/local/bin/cla[u]de --resume abc",
    "{claude,} --resume abc",
    "start-stop-daemon --start --background --exec /usr/local/bin/claude -- -p hi",
]

ALLOW = [
    # -p / --print one-shots
    'claude -p "summarize this"',
    'claude --print "hi"',
    "claude -p",   # reads stdin until EOF, then exits: a one-shot in the Bash tool
    'claude -p --output-format json "hi"',
    'claude --model deepseek-v4.1-flash -p "hi"',
    'claude -p "hi" > out.txt',
    'claude -p "hi" 2>&1 | tee out.txt',
    'V=$(claude -p "hi")',
    'echo `claude -p hi`',
    "sudo claude -p hi",
    "sudo -u omar claude -p hi",
    "env NO_COLOR=1 claude -p hi",
    "timeout 600 claude -p hi",
    "nice claude -p hi",
    "exec claude -p hi",
    "command claude -p hi",
    "time claude -p hi",
    "bash -c 'claude -p hi'",
    "eval 'claude -p hi'",
    'su - omar -c "claude -p hi"',
    'runuser -u omar -c "claude -p hi"',
    "while ! grep -q DONE out.log; do sleep 5; done; claude -p hi",
    "claude -p hi; sleep 1 &",
    "claude -p hi -- --resume-flag-as-prompt-text",
    # read-only forms
    "claude --version",
    "claude -v",
    "claude --help",
    "claude -h",
    "claude mcp list",
    "claude mcp list --json",
    "claude config list",
    "claude config get theme",
    "sudo claude --version",
    "/usr/local/bin/claude mcp list",
    # a comment mentioning claude is not a launch
    "echo hi # claude",
    "ls -la # start claude session",
    # quoted words are data, not commands
    "echo 'claude'",
    'git commit -m "claude session work"',
    "printf '%s' claude",
    "grep -rn claude /var/log/syslog",
    # other programs entirely
    "claudeify --not-claude",
    "docker run -it ubuntu bash",
    "tmux new-session -d htop",
    "tmux send-keys -t dev htop Enter",
    "tmux send-keys -t dev 'git status' Enter",
    "screen -dmS mon htop",
    "nohup python3 server.py &",
    "systemd-run python3 job.py",
    "script -q /dev/null -c 'htop'",
    "setsid socat -V",
    # redirection shapes that are not backgrounding
    "claude --version &> /tmp/v.txt",
    "claude -p hi &>> /tmp/out.log",
    "claude -p hi 2>&1",
    "bash -lc 'echo hi' &>log",
    # unbalanced / odd text fails open or parses to nothing harmful
    "echo (unbalanced",
    "if true; then echo hi; fi",
    "for f in *.txt; do echo $f; done",
    "while sleep 1; do echo tick; done & echo started",
    "echo ${CLAUDE_CONFIG_DIR}",
    "case $x in a) echo 1;; b) echo 2;; esac",
    # fix-pass 2026-10-10: read-only subcommands and substitutions that stay foreground
    "claude mcp get x",
    "claude mcp get",
    "claude doctor",
    "claude agents",
    "claude auth status",
    "claude mcp list && claude auth status",
    "$(which claude) --version",
    'x=$(which claude)',
    'echo "$(claude --version)"',
    'claude -p "$(cat prompt.txt)" > out.md',
    "cat <<'EOF' | bash\nclaude -p hi\nEOF",
    "flock /tmp/l claude -p hi",
    "watch claude -p hi",
    'python3 -c "print(\'claude\')"',
    'node -e "console.log(\'claude\')"',
    "f() { echo hi; }; f",
    "case $x in a) echo 1;; *) echo 2;; esac",
]


@pytest.mark.parametrize("command", DENY, ids=lambda c: c.replace("\n", "\\n")[:60])
def test_deny(command):
    reason = acg.check(command)
    assert reason, "expected deny: %r" % command
    spec = json.loads(json.dumps({"r": reason}))  # reason is plain text
    assert "agent-claude-launch-guard" in reason
    assert "Owner ruling 2026-10-10" in reason or "2026-10-10" in reason
    assert spec  # silence linters


@pytest.mark.parametrize("command", ALLOW, ids=lambda c: c.replace("\n", "\\n")[:60])
def test_allow(command):
    assert acg.check(command) is None, "expected allow: %r" % command


def test_deny_end_to_end_subprocess():
    payload = {"tool_name": "Bash", "tool_input": {"command": "tmux new-session -d claude"}}
    proc = subprocess.run([sys.executable, os.path.join(HOOKS_DIR, "agent-claude-launch-guard.py")],
                          input=json.dumps(payload).encode("utf-8"), capture_output=True, timeout=10)
    assert proc.returncode == 0 and proc.stderr == b""
    spec = json.loads(proc.stdout.decode("utf-8"))["hookSpecificOutput"]
    assert spec["permissionDecision"] == "deny"
    assert "tmux" in spec["permissionDecisionReason"]


@pytest.mark.parametrize("command", ['claude -p "hi"', "claude --print x", "timeout 60 claude -p x",
                                     "bash -c 'claude -p x'", "claude"])
def test_run_in_background_denies_every_claude_form(command):
    # owner 2026-10-10: the Bash tool's run_in_background flag is a launch vehicle, -p included
    reason = acg.check(command, background=True)
    assert reason and "run_in_background" in reason


def test_run_in_background_leaves_other_commands_alone():
    assert acg.check("sleep 60; echo done", background=True) is None
    assert acg.check("pytest -q tests", background=True) is None


@pytest.mark.parametrize("flag,denied", [(True, True), (False, False), ("true", False), (None, False)])
def test_run_in_background_end_to_end(flag, denied):
    tool_input = {"command": 'claude -p "hi"'}
    if flag is not None:
        tool_input["run_in_background"] = flag
    payload = {"tool_name": "Bash", "tool_input": tool_input}
    proc = subprocess.run([sys.executable, os.path.join(HOOKS_DIR, "agent-claude-launch-guard.py")],
                          input=json.dumps(payload).encode("utf-8"), capture_output=True, timeout=10)
    assert proc.returncode == 0 and proc.stderr == b""
    if denied:
        spec = json.loads(proc.stdout.decode("utf-8"))["hookSpecificOutput"]
        assert spec["permissionDecision"] == "deny"
    else:
        assert proc.stdout == b""


def test_allow_end_to_end_subprocess():
    payload = {"tool_name": "Bash", "tool_input": {"command": 'claude -p "hi"'}}
    proc = subprocess.run([sys.executable, os.path.join(HOOKS_DIR, "agent-claude-launch-guard.py")],
                          input=json.dumps(payload).encode("utf-8"), capture_output=True, timeout=10)
    assert proc.returncode == 0 and proc.stdout == b"" and proc.stderr == b""


@pytest.mark.parametrize("payload", [
    {"tool_name": "Read", "tool_input": {"file_path": "/x"}},
    {"tool_name": "Bash", "tool_input": {}},
    {"tool_name": "Bash", "tool_input": {"command": "   "}},
    {"tool_name": "Bash", "tool_input": "claude"},
    {"tool_name": "Bash", "tool_input": {"command": 7}},
    {"tool_name": "Edit", "tool_input": {"command": "claude"}},
    {},
])
def test_ignored_payloads_fail_open_end_to_end(payload):
    # main() filters by tool_name/shape; only a real Bash command string is ever judged
    proc = subprocess.run([sys.executable, os.path.join(HOOKS_DIR, "agent-claude-launch-guard.py")],
                          input=json.dumps(payload).encode("utf-8"), capture_output=True, timeout=10)
    assert proc.returncode == 0 and proc.stdout == b"" and proc.stderr == b""


def test_check_none_and_empty_allow():
    assert acg.check(None) is None
    assert acg.check("") is None
    assert acg.check("   ") is None


def test_fails_open_on_bad_stdin():
    for raw in (b"not json", b"[1,2]", b"null", b"\"s\"", b"42"):
        proc = subprocess.run([sys.executable, os.path.join(HOOKS_DIR, "agent-claude-launch-guard.py")],
                              input=raw, capture_output=True, timeout=10)
        assert proc.returncode == 0 and proc.stdout == b"" and proc.stderr == b""


_B64 = __import__("base64").b64encode(b"claude --resume abc").decode()


# D1 2026-10-11: the eight former documented limits are denied (strict, no xfail)
@pytest.mark.parametrize("command", [
    "X=claude; $X --resume abc",
    "X=/usr/local/bin/claude; ${X} --resume abc",
    "export X=claude && \"$X\"",
    "X='claude --resume abc'; eval $X",
    "npx @anthropic-ai/claude-code --resume abc",
    "npx -y @anthropic-ai/claude-code@latest",
    "pnpm dlx @anthropic-ai/claude-code -c",
    "npm exec -- @anthropic-ai/claude-code --resume abc",
    "bunx @anthropic-ai/claude-code",
    "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume abc",
    "nodejs --no-warnings /opt/claude-code/cli.mjs",
    "echo '%s' | base64 -d | bash" % _B64,
    "echo '%s' | base64 --decode | sh" % _B64,
    "base64 -d payload.txt | bash",
    "eval \"$(echo %s | base64 -d)\"" % _B64,
    "bash -c \"$(printf %s | base64 -d)\"" % _B64,
    "bash <<< \"$(echo %s | base64 -d)\"" % _B64,
    "echo %s | base64 -d | python3" % _B64,
    "ln -sf /usr/local/bin/claude /tmp/cc; /tmp/cc --resume abc",
    "ln -s \"$(which claude)\" cc && ./cc",
    "ln -s /usr/local/bin/claude -t /tmp && /tmp/claude",
    "ssh localhost 'claude --resume abc'",
    "ssh 127.0.0.1 claude -p hi",
    "ssh -p 22 root@[::1] 'claude'",
    "ssh -o BatchMode=yes ssh://root@localhost:22 claude --resume abc",
    "echo 'claude --resume abc' | ssh localhost",
    "ssh %s claude" % os.uname().nodename,
    "echo 'claude -p hi' | at now",
    "at now + 1 minute <<< 'claude -p hi'",
    "batch <<'EOF'\nclaude --resume abc\nEOF",
    "coproc claude -p hi",
    "coproc CL { claude -p hi; }",
    "coproc claude",
])
def test_former_documented_limits_denied(command):
    assert acg.check(command), "expected DENY: %r" % command


@pytest.mark.parametrize("command", [
    "X=claude; $X -p hi",
    "X=hello; $X --resume abc",
    "Y=claude-router; $Y --resume abc",
    "npx prettier --check .",
    "npx @anthropic-ai/claude-code -p hi",
    "npm --prefix ${AI_SETUP_ROOT}/claude-router test",
    "pnpm dlx create-vite app",
    "node claude-router/server.js",
    "node /opt/claude-code-router/cli.js",
    "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js -p hi",
    "echo aGVsbG8= | base64 -d",
    "echo aGVsbG8= | base64 -d > out.txt",
    "base64 -w0 file.bin | wc -c",
    "base64 file.bin | bash -c 'cat > enc.txt'",
    "ln -s /etc/hosts /tmp/h; cat /tmp/h",
    "ln -sf /usr/local/bin/claude /tmp/cc; ls -la /tmp/cc",
    "ln -s /usr/local/bin/claude /tmp/cc; /tmp/cc -p hi",
    "ssh build-host 'claude --resume abc'",
    "ssh localhost uptime",
    "ssh -i key 127.0.0.1",
    "echo 'make test' | at now",
    "at -l",
    "atq",
    "coproc sleep 5",
    "coproc W { tail -f log; }",
])
def test_d1_neighbours_allowed(command):
    assert acg.check(command) is None, command


# gate wave 2 (2026-10-11): here-strings, this-host forms, variable fixpoint, GAP-8 inline payloads
GW2_DENY = [
    # a here-string is not a heredoc: the lines after it are still scanned
    "grep -c a <<< abc\ntmux new -d claude",
    "wc -c <<< hi\nnohup claude --resume abc &",
    "bash <<< claude",
    "at now <<< claude",
    "ssh localhost <<< claude",
    # this host in any form
    "ssh 127.1 claude",
    "ssh 0 claude",
    "ssh ::ffff:127.0.0.1 claude",
    "ssh -o HostName=localhost box claude",
    # variable aliases resolved to a fixpoint, across hops and concatenation
    "X=claude; Y=$X; $Y --resume abc",
    "X=cla; ${X}ude",
    'X=cla; "$X"ude --resume a',
    # GAP-8: inline payloads naming claude, backgrounded outside or with a marker inside
    "busybox sh -c 'claude --resume abc' &",
    "$SHELL -c 'claude -p hi' &",
    "exec 3< <(claude -p 'long task')",
    "awk 'BEGIN{system(\"claude --resume abc &\")}'",
    "expect -c 'spawn claude --resume abc; interact' &",
    "python3 -c \"import subprocess; subprocess.Popen(['claude','-p','hi'], start_new_session=True)\"",
]

GW2_ALLOW = [
    "sh -c 'claude -p hi'",
    "python3 -c \"import subprocess; subprocess.run(['claude','-p','hi'])\"",
    "claude -p hi",
    "grep claude file",
    "pytest tests/test_claude*.py",
]

GW2_DENY_NEIGHBOURS = [
    "echo $((1<<x))\nclaude --resume abc",
    "ssh -oHostName=localhost box claude",
    "ssh -o 'HostName 127.1' box claude",
    "ssh box -o HostName=127.0.0.1 claude",
    "ssh 2130706433 claude",
    "ssh 0x7f000001 claude",
    "ssh 0177.0.0.1 claude",
    "ssh 0.0.0.0 claude -p hi",
    "ssh [::1] claude",
    "ssh :: claude",
    "ssh foo.localhost claude",
    "ssh localhost.localdomain claude",
    "sudo ssh localhost claude",
    "echo claude | sudo ssh localhost",
    "${X:-claude} --resume abc",
    "X=claude; $X --resume abc; X=hello",
    "X=cla; X+=ude; $X --resume a",
    "A=cla B=ude; $A$B --resume a",
    "declare -n R=X; X=claude; $R --resume a",
    "X=claude; R=X; ${!R} --resume a",
    "for X in claude; do $X --resume a; done",
    "A0=claude; " + "; ".join("A%d=$A%d" % (k, k - 1) for k in range(1, 21)) + "; $A20 --resume a",
    "bash -c 'X=claude; f(){ $X --resume a; }; f'",
    "bash -c 'X=claude; echo $($X --resume a)'",
    "echo $(claude -p hi) &",
    "diff <(claude -p a) <(echo b)",
    "busybox nohup claude -p hi",
    "${SHELL} -c 'claude --resume a'",
    "$BASH -c 'claude -p hi' &",
    "echo claude | $SHELL",
    "ash -c 'claude'",
    "nohup python3 -c \"import subprocess; subprocess.run(['claude','-p','hi'])\" &",
    "node -e \"require('child_process').execSync('claude -p hi')\"",
    "perl -e 'system(\"claude -p hi &\")'",
    "perl -e 'fork or exec(\"claude\",\"-p\",\"hi\")'",
    "python3 -c \"import os; os.posix_spawn('/usr/local/bin/claude', ['claude','-p','x'], {})\"",
    "awk 'BEGIN{\"claude --resume x\" | getline}'",
    "gawk -e 'BEGIN{system(\"claude\")}'",
    "expect -c 'spawn claude -p hi; expect eof'",
    "expect -c 'exec claude --resume abc'",
]

GW2_ALLOW_NEIGHBOURS = [
    "echo $(( 2 << 3 ))",
    "ssh 10.0.0.5 claude",
    "ssh 128.0.0.1 claude",
    "ssh -o HostName=build box claude --resume a",
    "${X:-claude} -p hi",
    "ls ${X:-claude}",
    "cmd=claude; \"$cmd\" -p hi",
    "X=claude-router; $X --resume",
    "X=claude; echo $X",
    "PATH=$PATH:/x; ls",
    "X=$X$X$X$X; $X",
    "for f in a b; do echo $f; done",
    "exec 3< <(cat file)",
    "diff <(sort a) <(sort b)",
    "while read l; do echo $l; done < <(ls)",
    "V=$(claude -p hi)",
    "busybox sh -c 'claude -p hi'",
    "busybox --list",
    "$SHELL -c 'echo hi' &",
    "python3 -c \"import subprocess; subprocess.check_output(['claude','-p','hi'])\"",
    "perl -e 'system(\"claude -p hi\")'",
    "awk 'BEGIN{system(\"claude -p hi\")}'",
    "awk '/claude/ {print}' file",
    "awk -F: '{print $1}' /etc/passwd",
    "expect -c 'exec claude -p hi'",
    "echo 'f(){ claude; }'",
    "grep -rn '<<<' file",
]


@pytest.mark.parametrize("command", GW2_DENY + GW2_DENY_NEIGHBOURS,
                         ids=lambda c: c.replace("\n", "\\n")[:60])
def test_gate_wave2_denied(command):
    assert acg.check(command), "expected DENY: %r" % command


@pytest.mark.parametrize("command", GW2_ALLOW + GW2_ALLOW_NEIGHBOURS,
                         ids=lambda c: c.replace("\n", "\\n")[:60])
def test_gate_wave2_allowed(command):
    assert acg.check(command) is None, "expected ALLOW: %r" % command


def test_gate_wave2_reasons_name_the_vehicle():
    assert "background marker `Popen`" in acg.check(GW2_DENY[-1])
    assert "process substitution" in acg.check("exec 3< <(claude -p 'long task')")
    assert "ssh to this host" in acg.check("ssh 127.1 claude")


def test_docstring_documents_gate_wave2():
    doc = acg.__doc__
    for needle in ("here-string", "HostName", "127.1", "::ffff:127.x", "fixpoint", "${X}ude",
                   "GAP-8", "Popen", "start_new_session", "child_process", "busybox", "$SHELL",
                   "expect", "awk", "process substitution", "flock, watch"):
        assert needle in doc, needle


@pytest.mark.xfail(strict=True, reason="documented static-parser limit: script files are not read")
def test_documented_limit_script_file():
    assert acg.check("bash /tmp/script-that-launches.sh")


def test_docstring_documents_limits_and_new_forms():
    doc = acg.__doc__
    for needle in ("Documented limits", "base64", "symlink", "ssh", "run-shell", "display-popup",
                   "flock", "watch", "start-stop-daemon", "--cloud", "--teleport", "auth status",
                   "doctor", "agents"):
        assert needle in doc, needle
