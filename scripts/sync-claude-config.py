#!/usr/bin/env python3
"""Synchronize Claude Code configuration with homelab single source of truth.

Unified configuration paths for Claude Code:
1. Rules & Context:
   - /root/.claude/CLAUDE.md -> ${AI_SETUP_ROOT}/rules/AGENTS.md
   - ${AI_SETUP_ROOT}/CLAUDE.md -> ${AI_SETUP_ROOT}/rules/AGENTS.md
   - /root/CLAUDE.md -> ${AI_SETUP_ROOT}/rules/AGENTS.md

2. MCP Servers:
   - ${AI_SETUP_ROOT}/.mcp.json -> ${AI_SETUP_ROOT}/mcp/mcp_config.json
   - /root/.claude.json: 'mcpServers' synchronized with ${AI_SETUP_ROOT}/mcp/mcp_config.json
   - opencode-hub bearer token (audit F3, WO-6), only while its file exists (hub_token.TOKEN_FILE):
     every loopback hub entry in ~/.claude.json gets `headersHelper` (hub_token.helper_command(): the
     CLI runs it at connect time and it prints the header to the CLI only), never a literal token:
     CloudCLI copies these entries into the CLI's world-readable argv (--mcp-config <json>). And
     ${AI_SETUP_ROOT}/.mcp.json -> mcp_project_empty.json instead: Claude Code prefers the git-tracked,
     helper-less project entry over the user one, from ${AI_SETUP_ROOT} and every subdirectory (probe
     2026-10-09, CLI 2.1.293). No token file = the layout above, unchanged. The value is never printed.
   - ~/.claude.json is rewritten only when its mcpServers map changes, and never when it cannot be
     parsed (the CLI writes it constantly; a torn read must not replace its account state).

3. Skills & Commands:
   - /root/.claude/skills -> ${AI_SETUP_ROOT}/skills
   - ${AI_SETUP_ROOT}/.claude/skills -> ${AI_SETUP_ROOT}/skills
   - /root/.claude/commands/*.md -> ${AI_SETUP_ROOT}/commands/*.md (symlinks; collisions reported, never overwritten)
   - /root/.config/opencode/command/*.md -> ${AI_SETUP_ROOT}/commands/*.md (same)

4. Subagents:
   - /root/.claude/agents -> ${AI_SETUP_ROOT}/claude-agents
   - ${AI_SETUP_ROOT}/.claude/agents -> ${AI_SETUP_ROOT}/claude-agents
   - Invokes ${AI_SETUP_ROOT}/scripts/sync-claude-agents.py

5. Permissions & Settings:
   - /root/.claude/settings.json (Permissions matching OpenCode / AGY, MCP approvals)
   - ${AI_SETUP_ROOT}/.claude/settings.json -> /root/.claude/settings.json
   - written only when its content changes (WO-6, audit P1/B-F2): an identical regeneration leaves the
     file, its inode and its mtime alone, so CloudCLI never respawns a session over a no-op sync.
"""
import contextlib
import json
import os
import pwd
import subprocess
import sys
from pathlib import Path

ROOT = Path(os.environ.get("AI_SETUP_ROOT") or Path(__file__).resolve().parents[1])
AGENTS = ROOT  # this repo holds the agent trees at its own root
HOME = Path(os.environ.get("AI_SETUP_HOME") or pwd.getpwuid(os.getuid()).pw_dir)

GLOBAL_RULES = str(AGENTS / "rules" / "AGENTS.md")
MCP_CONFIG = str(AGENTS / "mcp" / "mcp_config.json")
SKILLS_DIR = str(AGENTS / "skills")
CLAUDE_AGENTS_DIR = str(AGENTS / "claude-agents")
CLAUDE_CONFIG_DIR = str(HOME / ".claude")
CLAUDE_JSON_PATH = str(HOME / ".claude.json")
PROJECT_SETTINGS_LINK = str(ROOT / ".claude" / "settings.json")
PROJECT_MCP_LINK = str(ROOT / ".mcp.json")
# git-tracked, secret-free: the project .mcp.json target while the hub token is on (see the docstring, 2.)
PROJECT_MCP_EMPTY = str(AGENTS / "mcp" / "mcp_project_empty.json")
HUB_TOKEN_DIR = str(AGENTS / "opencode-hub")
HOOKS_DIR = str(AGENTS / "scripts" / "hooks")

sys.path.insert(0, HUB_TOKEN_DIR)
try:
    import hub_token  # the client half of the opencode-hub bearer token (audit F3)
except ImportError:  # configs are then generated without the helper, with a warning (hub_helper_command)
    hub_token = None
finally:
    sys.path.remove(HUB_TOKEN_DIR)


def _canonical(data) -> str:
    # sort_keys + type-exact: true and 1 differ, key order alone does not
    return json.dumps(data, sort_keys=True)


def write_json_if_changed(path: str, data, mode: int = 0o600) -> bool:
    """Atomically replace the file behind `path` (symlinks followed, so links stay links) with `data`,
    only when its parsed content differs. Same content: no write, only the mode is enforced (chmod
    leaves mtime alone). Returns True when the file was written."""
    real = os.path.realpath(path)
    try:
        with open(real, "r", encoding="utf-8") as fh:
            unchanged = _canonical(json.load(fh)) == _canonical(data)
    except (OSError, ValueError):
        unchanged = False
    if unchanged:
        if (os.stat(real).st_mode & 0o777) != mode:
            os.chmod(real, mode)
        return False
    tmp = f"{real}.tmp.{os.getpid()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
        os.chmod(tmp, mode)
        os.replace(tmp, real)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise
    return True


def hub_helper_command() -> str | None:
    """The Claude Code headersHelper command while a usable hub token file exists, else None (configs
    then keep the pre-F3 layout). The token is only validated here: never kept, returned or printed; an
    unusable file is reported by reason only."""
    if hub_token is None:
        print(f"WARN: {HUB_TOKEN_DIR}/hub_token.py not importable: no hub headersHelper", file=sys.stderr)
        return None
    try:
        if hub_token.read_token() is None:
            return None
    except hub_token.TokenError as exc:
        print(f"WARN: hub token unusable ({exc}): no hub headersHelper", file=sys.stderr)
        return None
    return hub_token.helper_command()


def ensure_symlink(target: str, link_path: str) -> None:
    os.makedirs(os.path.dirname(link_path), exist_ok=True)
    if os.path.islink(link_path):
        if os.readlink(link_path) != target:
            os.remove(link_path)
            os.symlink(target, link_path)
    elif os.path.exists(link_path):
        if os.path.isdir(link_path) and not os.listdir(link_path):
            os.rmdir(link_path)
            os.symlink(target, link_path)
        else:
            print(f"WARN: {link_path} exists and is not a symlink", file=sys.stderr)
    else:
        os.symlink(target, link_path)


def sync_mcp_to_claude_json(helper: str | None = None) -> list[str]:
    """~/.claude.json 'mcpServers' = mcp_config.json, plus `headersHelper` on the hub entries when
    `helper` is set. Rewritten only when that map changes: the CLI writes this file all the time, so a
    no-op sync must not race it. An existing file that cannot be parsed is left alone (WARN)."""
    with open(MCP_CONFIG, "r", encoding="utf-8") as f:
        shared_mcp = json.load(f).get("mcpServers", {})
    if helper and hub_token is not None:
        shared_mcp = hub_token.with_hub_helper(shared_mcp, helper)

    claude_data = {}
    if os.path.exists(CLAUDE_JSON_PATH):
        try:
            with open(CLAUDE_JSON_PATH, "r", encoding="utf-8") as f:
                claude_data = json.load(f)
        except Exception as e:
            # never replace the CLI's account/project state with a bare {"mcpServers": ...}
            print(f"WARN: Error reading {CLAUDE_JSON_PATH} ({e.__class__.__name__}): mcpServers NOT synced",
                  file=sys.stderr)
            return list(shared_mcp.keys())
        if not isinstance(claude_data, dict):
            print(f"WARN: {CLAUDE_JSON_PATH} is not a JSON object: mcpServers NOT synced", file=sys.stderr)
            return list(shared_mcp.keys())

    if "mcpServers" not in claude_data or _canonical(claude_data["mcpServers"]) != _canonical(shared_mcp):
        claude_data["mcpServers"] = shared_mcp
        write_json_if_changed(CLAUDE_JSON_PATH, claude_data, 0o600)

    return list(shared_mcp.keys())


def sync_project_mcp_link(token_on: bool) -> str:
    """${AI_SETUP_ROOT}/.mcp.json -> mcp_config.json, or, while the hub token is on, -> an empty server list
    (the hub entries then come only from ~/.claude.json, with the header). Returns the link target."""
    target = MCP_CONFIG
    if token_on:
        write_json_if_changed(PROJECT_MCP_EMPTY, {"mcpServers": {}}, 0o644)
        target = PROJECT_MCP_EMPTY
    ensure_symlink(target, PROJECT_MCP_LINK)
    return target


LOCAL_DECIDE_URL = "http://127.0.0.1:11438/hook/claude"


def _decide_hook(event: str, timeout: int = 5) -> dict:
    return {"type": "http", "url": f"{LOCAL_DECIDE_URL}/{event}", "timeout": timeout}


LOCAL_DECIDE_HOOKS = {
    "UserPromptSubmit": [{"hooks": [_decide_hook("UserPromptSubmit", 10)]}],
    "SubagentStart": [{"hooks": [_decide_hook("SubagentStart")]}],
    "SubagentStop": [{"hooks": [_decide_hook("SubagentStop")]}],
    "PostToolUse": [{"matcher": "mcp__exa__.*|WebFetch|Read", "hooks": [_decide_hook("PostToolUse")]}],
    "Stop": [{"hooks": [_decide_hook("Stop")]}],
}
# 2026-10-02: Read added — the complexity/GLiNER heads triage every file the session opens.
LOCAL_DECIDE_PRE_TOOL = {"matcher": "Agent|Task|Edit|Write|MultiEdit|Bash|Read", "hooks": [_decide_hook("PreToolUse")]}
# Go-live switch: the http hooks are emitted only while this file exists (created by the owner/CEO after the
# local-decide gates pass). Without it, a stopped daemon would surface "ECONNREFUSED" on every tool call.
LOCAL_DECIDE_ENABLED = os.path.exists(str(AGENTS / "local-decide" / "ENABLED"))
if not LOCAL_DECIDE_ENABLED:
    LOCAL_DECIDE_HOOKS = {}


def session_start_hooks() -> list[dict]:
    # postcompact-anchor (2026-10-02, RESEARCH-LONGTASK.md M7): after compact/resume, re-inject the
    # ledger/plan/progress files the transcript actually touched so the session re-anchors on disk state.
    return [
        {
            "matcher": "compact|resume",
            "hooks": [
                {
                    "type": "command",
                    "command": f"/usr/bin/python3 {HOOKS_DIR}/postcompact-anchor.py",
                    "timeout": 10,
                }
            ],
        },
    ]


def _cmd_hook(script: str, timeout: int) -> dict:
    return {
        "type": "command",
        "command": f"/usr/bin/python3 {HOOKS_DIR}/{script}",
        "timeout": timeout,
    }


# Wave-B (2026-10-07): register the WO-3 session-memory hooks and WO-5 guard hooks.
# Entries are APPENDED after any existing entries per event (local-decide ENABLED
# gating above stays untouched and keeps precedence). Kill switch for the
# session-memory scripts is SESSION_MEMORY=off (checked inside each script).
WAVE_B_HOOKS: dict[str, list[dict]] = {
    "PreToolUse": [
        {
            "matcher": "Edit|Write|MultiEdit",
            "hooks": [
                _cmd_hook("secret-write-guard.py", 10),
                _cmd_hook("gateguard.py", 10),
            ],
        },
        # Bash pass (2026-10-07 wave-1): same guard, command-writing form — denies
        # secret literals redirected/tee'd/sed -i/heredoc-ed into non-env files.
        {
            "matcher": "Bash",
            "hooks": [
                _cmd_hook("secret-write-guard.py", 10),
                # restart-guard (2026-10-07): raw cloudcli restarts kill every running
                # session + subagent in its cgroup; route them via safe-restart.sh.
                _cmd_hook("restart-guard.py", 5),
                # poll-guard (WO-N3 / M-045, 2026-10-10): deny the 6th identical Bash command within
                # 10 min in one transcript (I-09 poll loops); points to run_in_background instead.
                _cmd_hook("poll-guard.py", 5),
                # agent-claude-launch-guard (GAP-8, owner 2026-10-10): agents never launch interactive or
                # background `claude` (tmux/screen/systemd-run/nohup/setsid/&/run_in_background).
                _cmd_hook("agent-claude-launch-guard.py", 5),
            ],
        },
        {"matcher": "*", "hooks": [_cmd_hook("suggest-compact.py", 10)]},
        # file-lease (2026-10-10, lane G Option A; owner: BLOCK, all live files, lease per agent).
        # Kill switch: touch ${AI_SETUP_ROOT}/scripts/hooks/FILE_LEASE_DISABLED (or env FILE_LEASE=off).
        {"matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash", "hooks": [_cmd_hook("file-lease.py", 5)]},
    ],
    "PostToolUse": [
        {
            "matcher": "Edit|Write|MultiEdit",
            # poll-guard reset (orchestrator ruling 2026-10-10): an edit clears the transcript's identical-
            # command counter, so edit -> re-run test loops are never treated as polls.
            "hooks": [_cmd_hook("post-edit-check.py", 15), _cmd_hook("poll-guard.py", 5)],
        },
        {"matcher": "Read|Edit|Write|MultiEdit|NotebookEdit|Bash", "hooks": [_cmd_hook("file-lease.py", 5)]},
    ],
    "SessionStart": [
        {"matcher": "startup", "hooks": [_cmd_hook("session-brief.py", 15)]},
        {"matcher": "startup|resume|clear", "hooks": [_cmd_hook("file-lease.py", 5)]},
    ],
    # terminal-prompt-guard (audit H GAP-6, 2026-10-10): block a terminal prompt into a session id a
    # live CloudCLI process holds (second writer = fork). Kill switch TERMINAL_PROMPT_GUARD_DISABLED=1.
    "UserPromptSubmit": [{"hooks": [_cmd_hook("terminal-prompt-guard.py", 5)]}],
    "Stop": [{"hooks": [_cmd_hook("session-summary.py", 10)]}],
    # file-lease clean release: a finished agent/session frees its leases at once.
    "SessionEnd": [{"hooks": [_cmd_hook("session-summary.py", 10), _cmd_hook("file-lease.py", 5)]}],
    "SubagentStart": [{"hooks": [_cmd_hook("agent-brief.py", 10)]}],
    "SubagentStop": [{"hooks": [_cmd_hook("agent-experience.py", 10), _cmd_hook("file-lease.py", 5)]}],
}


def prune_missing_hooks(hooks: dict) -> dict:
    """Drop any hook whose script is not present in this checkout.

    The shipped hook set is a subset of the full one: an optional hook file that was not
    installed must never leave a command that fails on every tool call. Command hooks name
    their script as an absolute path, so presence is a plain os.path.exists check.
    """
    def entry_ok(entry: dict) -> bool:
        for hook in entry.get("hooks", []):
            command = hook.get("command")
            if not isinstance(command, str):
                continue
            for token in command.split():
                if token.endswith((".py", ".sh")) and not os.path.exists(token):
                    return False
        return True

    return {event: [e for e in entries if entry_ok(e)] for event, entries in hooks.items()}


def merge_wave_b_hooks(hooks: dict) -> dict:
    # new lists, never extend() in place: `**LOCAL_DECIDE_HOOKS` shares the module-level lists, which a
    # second call in one process would otherwise grow again (WO-6: duplicated hooks, non-idempotent)
    for event, entries in WAVE_B_HOOKS.items():
        hooks[event] = [*hooks.get(event, []), *entries]
    return hooks


COMMANDS_DIR = str(AGENTS / "commands")
COMMAND_LINK_DIRS = (str(HOME / ".claude" / "commands"), str(HOME / ".config" / "opencode" / "command"))


def sync_commands() -> list[str]:
    """Symlink every canonical command .md into the Claude Code + OpenCode command dirs.

    Never overwrites a differing existing file; collisions are returned as strings
    (printed as WARN by the caller, never fatal).
    """
    collisions: list[str] = []
    for name in sorted(os.listdir(COMMANDS_DIR)):
        if not name.endswith(".md"):
            continue
        target = os.path.join(COMMANDS_DIR, name)
        for link_dir in COMMAND_LINK_DIRS:
            link = os.path.join(link_dir, name)
            os.makedirs(link_dir, exist_ok=True)
            if os.path.islink(link):
                if os.readlink(link) == target:
                    continue
                collisions.append(f"{link} -> {os.readlink(link)} (expected {target})")
            elif os.path.exists(link):
                collisions.append(f"{link} exists and is not the canonical symlink")
            else:
                os.symlink(target, link)
    return collisions


def write_claude_settings(server_names: list[str]) -> bool:
    """Regenerates settings.json; returns False when the content was already current (file untouched)."""
    os.makedirs(CLAUDE_CONFIG_DIR, exist_ok=True)
    settings_path = os.path.join(CLAUDE_CONFIG_DIR, "settings.json")

    settings = {
        "$schema": "https://json.schemastore.org/claude-code-settings.json",
        "model": "claude-opus-5-5[1m]",
        # Owner policy 2026-09-21: main CEO runs at `high` (cost/speed balance,
        # user-switchable live via /effort). Do NOT silently revert to xhigh.
        "effortLevel": "high",
        "modelSettings": {
            "claude-opus-5-5[1m]": {
                "effortLevel": "high"
            },
            "claude-opus-5[1m]": {
                "effortLevel": "high"
            },
            "claude-opus-5": {
                "effortLevel": "xhigh"
            },
            "claude-sonnet-5": {
                "effortLevel": "xhigh"
            },
            "claude-haiku-4-5-20251001": {
                "effortLevel": "medium"
            },
            "deepseek-v4.1-flash": {
                "effortLevel": "xhigh"
            }
        },
        "autoCompactEnabled": True,
        "autoCompactWindow": 300000,
        "fastMode": True,
        "language": "en",
        "promptCacheTtl": "1h",
        "subagentPromptCacheTtl": "1h",
        "precomputeCompactionEnabled": True,
        "fileCheckpointingEnabled": True,
        "todoFeatureEnabled": True,
        "showClearContextOnPlanAccept": True,
        "useAutoModeDuringPlan": True,
        "terminalProgressBarEnabled": True,
        "claudeMdExcludes": [],
        "includeGitInstructions": False,
        "autoMemoryEnabled": False,
        "skillListingBudgetFraction": 0.005,
        "skillListingMaxDescChars": 160,
        "skipDangerousModePermissionPrompt": True,
        "permissions": {
            "allow": [
                "Bash",
                "Edit",
                "Write",
                "Read",
                "Glob",
                "Grep",
                "Task",
                "Skill",
                "Cd",
                "Agent",
                "Artifact",
                "EnterWorktree",
                "ExitPlanMode",
                "KillShell",
                "LSP",
                "Monitor",
                "MultiEdit",
                "NotebookEdit",
                "PowerShell",
                "TaskCreate",
                "TaskGet",
                "TaskList",
                "TaskOutput",
                "TaskStop",
                "TaskUpdate",
                "TodoWrite",
                "ToolSearch",
                "Workflow",
            ] + [f"mcp__{name}__*" for name in server_names],
            "deny": [
                "WebSearch",
                "WebFetch",
                "Read(.env)",
                "Read(./.env)",
                "Read(./.env.*)",
                f"Read({ROOT}/.env)",
                f"Read({ROOT}/.env.*)",
                "Read(./secrets/**)",
                "Bash(git push *)",
            ],
            "defaultMode": "bypassPermissions",
        },
        # Owner ruling 2026-09-28 17:02: answer the critical-path "dangerous rm"
        # prompt only for rm targets provably under /var/tmp/claude scratch space.
        # Owner directive 2026-09-28 "never lose any data": keep every session
        # transcript (default is a 30-day purge) and deny deletes of study trees.
        "cleanupPeriodDays": 36500,
        # Wave-B (2026-10-07): merge the WO-3/WO-5 hooks in AFTER the existing
        # entries of each event (see merge_wave_b_hooks above).
        "hooks": prune_missing_hooks(merge_wave_b_hooks({
            "PreToolUse": (
                [LOCAL_DECIDE_PRE_TOOL] if LOCAL_DECIDE_ENABLED else []
            ),
            # local-decide (2026-10-02): GLiNER2.5 + rerankers decision layer, D1-D8/D13.
            # type:"http" fails OPEN on connection failure, so a stopped daemon never blocks work.
            **LOCAL_DECIDE_HOOKS,
            "PermissionRequest": [
                {
                    "matcher": "Bash",
                    "hooks": [
                        {
                            "type": "command",
                            "command": f"/usr/bin/python3 {HOOKS_DIR}/allow-scratch-rm.py",
                            "timeout": 10,
                        }
                    ],
                }
            ],
            # Long-task compaction steering (2026-10-02, RESEARCH-LONGTASK.md M7): PreCompact stdout is merged
            # into the summarizer instructions on manual AND auto compaction.
            "PreCompact": [
                {
                    "hooks": [
                        {
                            "type": "command",
                            "command": f"/usr/bin/python3 {HOOKS_DIR}/precompact-recite.py",
                            "timeout": 10,
                        }
                    ],
                }
            ],
            "SessionStart": session_start_hooks(),
        })),
        # Wave-B (2026-10-07, WO-6): status line (model · ctx% · today's tokens).
        "statusLine": {
            "type": "command",
            "command": f"python3 {AGENTS}/scripts/statusline.py",
            "padding": 0,
        },
        "enableAllProjectMcpServers": False,
        "enabledMcpjsonServers": server_names,
    }

    # Preserve the owner's live `/model` choice (2026-09-22): the CLI saves it into
    # settings.json, and a regeneration must not silently revert it to the default.
    try:
        with open(settings_path, "r", encoding="utf-8") as existing_file:
            existing_model = json.load(existing_file).get("model")
        if isinstance(existing_model, str) and existing_model:
            settings["model"] = existing_model
    except (OSError, ValueError):
        pass

    # WO-6: content-only write. A rewrite of identical settings bumped mtime, which CloudCLI's session
    # fingerprint read as a config change and respawned held sessions (audit B-F2: 2 of 10 spawns).
    written = write_json_if_changed(settings_path, settings, 0o600)

    # Link to ${AI_SETUP_ROOT}/.claude/settings.json
    ensure_symlink(settings_path, PROJECT_SETTINGS_LINK)
    return written


def sync_mcp_and_settings() -> dict:
    """The MCP + settings half of main(): ~/.claude.json, the ${AI_SETUP_ROOT}/.mcp.json link and settings.json.
    Idempotent (WO-6): a second run with unchanged inputs writes nothing and leaves every mtime alone."""
    helper = hub_helper_command()
    server_names = sync_mcp_to_claude_json(helper)
    project_target = sync_project_mcp_link(helper is not None)
    return {"servers": server_names, "helper": helper is not None, "project_target": project_target,
            "settings_written": write_claude_settings(server_names)}


def main() -> None:
    print("=== Synchronizing Claude Code Subagents ===")
    subprocess.run([sys.executable, str(AGENTS / "scripts" / "sync-claude-agents.py")], check=True)

    print("\n=== Synchronizing Instructions & Rules (CLAUDE.md) ===")
    ensure_symlink(GLOBAL_RULES, str(HOME / ".claude" / "CLAUDE.md"))
    ensure_symlink(GLOBAL_RULES, str(ROOT / "CLAUDE.md"))
    ensure_symlink(GLOBAL_RULES, str(HOME / "CLAUDE.md"))
    print("Symlinks created: ~/.claude/CLAUDE.md, ${AI_SETUP_ROOT}/CLAUDE.md, /root/CLAUDE.md -> AGENTS.md")

    print("\n=== Synchronizing Skills ===")
    ensure_symlink(SKILLS_DIR, str(HOME / ".claude" / "skills"))
    # 2026-09-22: project-level skills symlink removed — it duplicated ~/.claude/skills (same target) in every skill listing (Claude Code + OpenCode)
    pass  # ensure_symlink(SKILLS_DIR, "${AI_SETUP_ROOT}/.claude/skills")
    print("Symlinks created: ~/.claude/skills, ${AI_SETUP_ROOT}/.claude/skills -> ${AI_SETUP_ROOT}/skills")

    print("\n=== Synchronizing Slash Commands ===")
    collisions = sync_commands()
    for c in collisions:
        print(f"WARN: command collision: {c}", file=sys.stderr)
    print("Symlinked ${AI_SETUP_ROOT}/commands/*.md -> ~/.claude/commands/ and /root/.config/opencode/command/"
          + (f" ({len(collisions)} collisions, NOT overwritten)" if collisions else " (no collisions)"))

    print("\n=== Synchronizing MCP Servers + Claude Settings & Permissions ===")
    result = sync_mcp_and_settings()
    print(f"Synchronized {len(result['servers'])} MCP servers into ~/.claude.json (hub headersHelper "
          f"{'on' if result['helper'] else 'off'}); <root>/.mcp.json -> {result['project_target']}")
    if result["settings_written"]:
        print("Written ~/.claude/settings.json and linked to ${AI_SETUP_ROOT}/.claude/settings.json")
    else:
        print("~/.claude/settings.json already current: not rewritten (linked to ${AI_SETUP_ROOT}/.claude/settings.json)")

    print("\nClaude Code configuration successfully synchronized with homelab single source of truth.")


if __name__ == "__main__":
    main()
