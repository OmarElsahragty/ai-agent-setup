#!/usr/bin/env python3
"""Synchronize the canonical agent setup across Claude Code, OpenCode, agy and local-decide.

Canonical sources (single source of truth, ${AI_SETUP_ROOT}):
- rules:      rules/AGENTS.md      -> CLAUDE.md / GEMINI.md (symlinks)
- subagents:  subagents/*.md            -> claude-agents/ (sync-claude-agents.py, via sync-claude-config.py),
                                           opencode-agents/ (sync-opencode-agents.py),
                                           agy reads ~/.gemini/config/agents -> subagents/ directly.
- MCP:        mcp/mcp_config.json       -> Claude: .mcp.json symlink + ~/.claude.json (sync-claude-config.py)
                                           OpenCode: injected at runtime by ~/.config/opencode/plugin/sync-shared.ts
                                           agy: ~/.gemini/config/mcp_config.json symlink
- skills:     skills/                   -> ~/.claude/skills and ~/.gemini/skills symlinks (OpenCode auto-discovers ~/.claude/skills)
- routing:    subagents/*.md            -> local-decide/rules/agents.yaml (written here)
- hooks:      local-decide/agy_hook.py  -> ~/.gemini/config/hooks.json (written here; any other
                                           hook already in that file is preserved verbatim)

Each consumer keeps only its own model configuration; everything else is generated from here.

The return contract is defined ONCE below and injected into every canonical subagent body,
so no agent ever hand-copies it and every consumer (Claude Code, OpenCode, agy, local-decide)
returns the identical block. Injection is idempotent: re-running rewrites the same bytes.

Run after any canonical subagent, rule or MCP change.
--check: diff every artifact rendered HERE against disk (zero writes); exit 1 on drift.
"""
import importlib.util
import json
import os
import pwd
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(os.environ.get("AI_SETUP_ROOT") or Path(__file__).resolve().parents[1])
AGENTS = ROOT  # this repo holds the agent trees at its own root
HOME = Path(os.environ.get("AI_SETUP_HOME") or pwd.getpwuid(os.getuid()).pw_dir)

SUBAGENT_DIR = str(AGENTS / "subagents")
LOCAL_DECIDE_RULES = str(AGENTS / "local-decide" / "rules" / "agents.yaml")
CLAUDE_GENERATOR = str(AGENTS / "scripts" / "sync-claude-agents.py")

# agy lifecycle hooks -> local-decide daemon. agy reads this file directly; there is no
# generated copy elsewhere, so sync-all-agents.py owns it (and nothing else touches it).
AGY_HOOKS = str(HOME / ".gemini" / "config" / "hooks.json")
AGY_HOOKS_BACKUP = AGY_HOOKS + ".bak.20261002"
AGY_HOOK_NAME = "local-decide"
AGY_HOOK_BRIDGE = str(AGENTS / "local-decide" / "agy_hook.py")
AGY_PYTHON = "/usr/bin/python3"
# agy handler `timeout` is in SECONDS and killing a handler there would leave stdout empty,
# which agy PreToolUse reads as a deny. The bridge caps its own HTTP budget at 1.5s, so 10s
# is headroom, not latency.
AGY_HANDLER_TIMEOUT_S = 10

# agy derives tool names by lowercasing the step type and dropping the CORTEX_STEP_TYPE_
# prefix (hooks.md, verified against the installed agy binary: `strings` CORTEX_STEP_TYPE_
# enum), plus write_file as observed live in state/local-decide/agy-tool-names.log.
# Every name below is confirmed from those two sources; nothing is guessed, and
# mcp_tool is deliberately unmatched (it can do anything — not classifiable into
# one group, and the previous matchers did not fire on it either).
AGY_PRETOOL_MATCHERS = {
    "write": r"^(write_file|write_blob|file_change|edit_notebook"
             r"|move|delete_directory|git_commit)$",
    "command": r"^(run_command|shell_exec|send_command_input)$",
    "agent": r"^(agency_tool_call|invoke_subagent|browser_subagent)$",
}
AGY_POSTTOOL_MATCHER = (
    r"^(view_file|view_code_item|view_content_chunk|view_file_outline"
    r"|read_url_content|read_resource|read_terminal|read_notebook"
    r"|open_browser_url|read_browser_page"
    r"|search_web|grep_search|code_search|find_all_references)$"
)

# Canonical supersede list: "## Output Format" was the hand-copied predecessor of this block.
SUPERSEDED_HEADINGS = ("## Output Format",)

RETURN_CONTRACT = """## Return contract

Return ONLY this block — no prose before, after, or around it:

```
STATUS: COMPLETED | PARTIAL | CLARIFICATION NEEDED | NEEDS_OWNER | FAILED
FILES MODIFIED: <absolute paths, or none>
CHANGES: <at most 15 bullets>
DECISIONS: <non-obvious choices and the reason for each>
RISKS: <edge cases, coupling, follow-ups>
GATE EVIDENCE: <one line per command: <command> → exit <n>>
NEXT STEPS: <next action, or none>
```

Rules:
- English only, in reasoning and in output.
- GATE EVIDENCE lists each verification command exactly as executed with its real exit code.
  A claim without a command is not evidence; the orchestrator re-runs the TEST command itself
  (§E4), so never report a gate you did not execute.
- A defect you find in your own verification must be self-reported. A broken check reported is
  pass-grade behavior; a hidden one is a failure.
- Stay inside SCOPE. If the task is another lane (money/C++/quant/parity -> quant-engineer,
  internet -> research, DB -> database-analyst, Docker/systemd/network -> homelab-operator,
  review -> code-reviewer, tests -> tester, acceptance/browser -> qa), say so and name the lane
  instead of doing the work.
- FILES MODIFIED must list only files you actually edited in this run (it is checked against your
  transcript). List every file you were asked to read but did not, under RISKS.
- Long tasks (likely > 50 turns): keep a checkpoint file `<project>/state/progress-<task>.md`
  (done / verified with evidence / next step), update it at each milestone, and re-read it after
  any compaction. A turn cap returns PARTIAL output that can be resumed from that file.
- Keep your working context lean (target < 150k tokens): page through code with codebase-memory
  and targeted reads instead of loading whole trees.
- Never end your turn on a narration line ("Continuing…", "Now I will…"): finish the work, then
  return this block. Keep the block under ~2,000 tokens."""

# Claude Code built-ins are not canonical files, but the router still needs cards for them.
BUILTINS = {
    "Explore": {
        "description": (
            "Use for: locating files, symbols and call paths in an unfamiliar repo. "
            "Never for: editing files, mutating state, or answering without file:line proof. "
            "Inputs: a question or a target path. Outputs: a file list or symbol map with file:line."
        ),
        "tools_allowed": [
            "Read", "Glob", "Grep", "Bash",
            "mcp__codebase-memory__*", "mcp__unified-memory__*", "mcp__local-decide__*",
        ],
        "maxTurns": 60,
    },
    "Plan": {
        "description": (
            "Use for: designing an implementation plan with no writes. "
            "Never for: editing files, mutating state, or executing the plan. "
            "Inputs: a goal, constraints, target files. Outputs: an atomic numbered plan with paths and a test command."
        ),
        "tools_allowed": [
            "Read", "Glob", "Grep", "WebFetch",
            "mcp__codebase-memory__*", "mcp__unified-memory__*", "mcp__local-decide__*",
        ],
        "maxTurns": 60,
    },
}

STEPS = [
    ("Claude Code subagents & config", str(AGENTS / "scripts" / "sync-claude-config.py")),
    ("OpenCode subagents", str(AGENTS / "scripts" / "sync-opencode-agents.py")),
]


def load_claude_parser():
    """Reuse sync-claude-agents.parse_agent so the rules file sees the canonical cards verbatim."""
    spec = importlib.util.spec_from_file_location("sync_claude_agents", CLAUDE_GENERATOR)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {CLAUDE_GENERATOR}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.parse_agent


def strip_section(body: str, heading: str) -> str:
    """Remove a whole '## heading' section (up to the next H2 or end of body)."""
    pattern = re.compile(r"^" + re.escape(heading) + r"[ \t]*\n.*?(?=^## |\Z)", re.S | re.M)
    return pattern.sub("", body)


def apply_return_contract(path: str, check: bool = False) -> str:
    """Idempotently (re)write the canonical return contract at the end of the body.

    Returns "updated" (bytes rewritten), "current" (already canonical), "skipped"
    (no frontmatter) or "drift" (check mode: disk differs from the canonical render).
    """
    with open(path, encoding="utf-8") as fh:
        raw = fh.read()
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", raw, re.S)
    if not m:
        print(f"WARN: {path} has no frontmatter, skipping return contract", file=sys.stderr)
        return "skipped"
    frontmatter, body = m.group(1), m.group(2)
    for heading in SUPERSEDED_HEADINGS + ("## Return contract",):
        body = strip_section(body, heading)
    new = "---\n" + frontmatter + "\n---\n" + body.rstrip() + "\n\n" + RETURN_CONTRACT + "\n"
    if new == raw:
        return "current"
    if check:
        return "drift"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(new)
    return "updated"


def yaml_scalar(value) -> str:
    """JSON strings are valid YAML double-quoted scalars; deterministic and escape-safe."""
    return json.dumps(value, ensure_ascii=False)


def render_rules(agents: list) -> str:
    lines = [
        "# GENERATED FILE - do not edit by hand.",
        "# Source of truth: subagents/*.md (canonical bodies + frontmatter).",
        "# Regenerate with: python3 scripts/sync-all-agents.py",
        "# Consumed by the local-decide MCP router: routing card, tool allow-list, turn budget.",
        "agents:",
    ]
    for agent in agents:
        lines.append(f"  {agent['name']}:")
        lines.append(f"    description: {yaml_scalar(agent['description'])}")
        lines.append("    tools_allowed:")
        lines.extend(f"      - {yaml_scalar(tool)}" for tool in agent["tools_allowed"])
        lines.append(f"    maxTurns: {agent['maxTurns']}")
    lines.append("  # Claude Code built-ins (not canonical files, routed by the same role plan).")
    for name, spec in BUILTINS.items():
        lines.append(f"  {name}:")
        lines.append(f"    description: {yaml_scalar(spec['description'])}")
        lines.append("    tools_allowed:")
        lines.extend(f"      - {yaml_scalar(tool)}" for tool in spec["tools_allowed"])
        lines.append(f"    maxTurns: {spec['maxTurns']}")
    return "\n".join(lines) + "\n"


def collect_agents(parse_agent) -> list:
    agents = []
    for filename in sorted(os.listdir(SUBAGENT_DIR)):
        if not filename.endswith(".md"):
            continue
        agent = parse_agent(os.path.join(SUBAGENT_DIR, filename))
        if not agent["name"]:
            print(f"WARN: {filename} has no name field, skipping", file=sys.stderr)
            continue
        if not agent["maxTurns"]:
            raise RuntimeError(f"{filename} has no maxTurns in frontmatter")
        agents.append({
            "name": agent["name"],
            "description": agent["description"],
            "tools_allowed": agent["tools"],
            "maxTurns": int(agent["maxTurns"]),
        })
    return agents


def write_rules(parse_agent) -> int:
    agents = collect_agents(parse_agent)
    os.makedirs(os.path.dirname(LOCAL_DECIDE_RULES), exist_ok=True)
    content = render_rules(agents)
    existing = None
    if os.path.exists(LOCAL_DECIDE_RULES):
        with open(LOCAL_DECIDE_RULES, encoding="utf-8") as fh:
            existing = fh.read()
    if existing != content:
        with open(LOCAL_DECIDE_RULES, "w", encoding="utf-8") as fh:
            fh.write(content)
    print(f"Routing rules for {len(agents)} subagents + {len(BUILTINS)} built-ins -> {LOCAL_DECIDE_RULES}")
    return len(agents)


def agy_handler(event: str) -> dict:
    return {
        "type": "command",
        "command": f"{AGY_PYTHON} {AGY_HOOK_BRIDGE} {event}",
        "timeout": AGY_HANDLER_TIMEOUT_S,
    }


def render_agy_hook() -> dict:
    """The local-decide named hook container.

    Shape is the one agy actually parses (verified in the installed binary): the file is an
    object keyed by hook name; PreToolUse/PostToolUse entries are grouped under
    {matcher, hooks:[...]}; PreInvocation/PostInvocation/Stop take a FLAT handler list --
    wrapping those in {"hooks": [...]} makes agy skip them silently.
    """
    return {
        # D1/D2 -> context injection. The bridge itself gates on invocationNum == 0.
        "PreInvocation": [agy_handler("PreInvocation")],
        # D3/D4 + D7 + D8 -> deny (or inject) before a write, a command or a subagent spawn.
        "PreToolUse": [
            {"matcher": matcher, "hooks": [agy_handler("PreToolUse")]}
            for matcher in AGY_PRETOOL_MATCHERS.values()
        ],
        # D13 -> warn about untrusted text just pulled in from a web/read tool.
        "PostToolUse": [
            {"matcher": AGY_POSTTOOL_MATCHER, "hooks": [agy_handler("PostToolUse")]}
        ],
        # Session/turn bookkeeping only.
        "Stop": [agy_handler("Stop")],
    }


def write_agy_hooks(check: bool = False) -> str:
    """Idempotently (re)write the local-decide hook; every other hook in the file survives.

    Returns "written", "current", "refused" (target unreadable) or "drift" (check mode).
    """
    spec = render_agy_hook()
    existing: dict = {}
    if os.path.exists(AGY_HOOKS):
        try:
            with open(AGY_HOOKS, encoding="utf-8") as fh:
                loaded = json.load(fh)
            existing = loaded if isinstance(loaded, dict) else {}
        except (OSError, ValueError) as exc:
            print(f"WARN: {AGY_HOOKS} unreadable ({exc}); refusing to overwrite", file=sys.stderr)
            return "refused"
    foreign = [k for k in existing if k != AGY_HOOK_NAME]
    if foreign and not os.path.exists(AGY_HOOKS_BACKUP) and not check:
        # First time we touch a hand-maintained file: keep the owner's bytes before rewriting.
        with open(AGY_HOOKS, "rb") as src, open(AGY_HOOKS_BACKUP, "wb") as dst:
            dst.write(src.read())
        print(f"Backed up pre-existing agy hooks -> {AGY_HOOKS_BACKUP}")
    if existing.get(AGY_HOOK_NAME) == spec:
        print(f"agy hooks already current: {AGY_HOOKS} (hook '{AGY_HOOK_NAME}')")
        return "current"
    if check:
        return "drift"
    existing[AGY_HOOK_NAME] = spec
    os.makedirs(os.path.dirname(AGY_HOOKS), exist_ok=True)
    with open(AGY_HOOKS, "w", encoding="utf-8") as fh:
        json.dump(existing, fh, indent=2, sort_keys=True)
        fh.write("\n")
    print(
        f"agy hooks written -> {AGY_HOOKS} (hook '{AGY_HOOK_NAME}': "
        f"{len(spec['PreInvocation'])} PreInvocation, {len(spec['PreToolUse'])} PreToolUse "
        f"matchers, {len(spec['PostToolUse'])} PostToolUse, {len(spec['Stop'])} Stop; "
        f"{len(foreign)} foreign hook(s) preserved)"
    )
    return "written"


def run_check() -> int:
    """--check: diff every artifact THIS script renders against disk. Zero writes, exit 1 on drift.

    The two delegated generators (sync-claude-config.py, sync-opencode-agents.py) are separate
    writers and are deliberately not executed here; run them directly to sync those trees.
    """
    drift = []
    for filename in sorted(os.listdir(SUBAGENT_DIR)):
        if not filename.endswith(".md"):
            continue
        try:
            if apply_return_contract(os.path.join(SUBAGENT_DIR, filename), check=True) == "drift":
                drift.append(f"{os.path.join(SUBAGENT_DIR, filename)}: return contract not canonical")
        except Exception as exc:
            drift.append(f"{os.path.join(SUBAGENT_DIR, filename)}: cannot read ({exc})")
    try:
        content = render_rules(collect_agents(load_claude_parser()))
        on_disk = None
        if os.path.exists(LOCAL_DECIDE_RULES):
            with open(LOCAL_DECIDE_RULES, encoding="utf-8") as fh:
                on_disk = fh.read()
        if on_disk != content:
            drift.append(f"{LOCAL_DECIDE_RULES}: routing rules differ from canonical subagents")
    except Exception as exc:
        drift.append(f"{LOCAL_DECIDE_RULES}: cannot compute ({exc})")
    if write_agy_hooks(check=True) == "drift":
        drift.append(f"{AGY_HOOKS}: local-decide hook entry differs from rendered spec")
    if drift:
        print(f"DRIFT detected in {len(drift)} artifact(s):")
        for line in drift:
            print(f"  - {line}")
        print(f"Fix with: python3 {AGENTS}/scripts/sync-all-agents.py")
        return 1
    print("--check clean: return contracts, local-decide routing rules and agy hooks match disk.")
    print("Not checked (separate generators, run them directly): "
          "sync-claude-config.py, sync-opencode-agents.py")
    return 0


def main() -> None:
    if "--check" in sys.argv[1:]:
        sys.exit(run_check())
    print("=== Injecting canonical return contract ===")
    changed = 0
    total = 0
    for filename in sorted(os.listdir(SUBAGENT_DIR)):
        if not filename.endswith(".md"):
            continue
        total += 1
        if apply_return_contract(os.path.join(SUBAGENT_DIR, filename)) == "updated":
            changed += 1
    print(f"Return contract: {changed} file(s) updated, {total - changed} already current\n")

    for label, script in STEPS:
        print(f"=== Syncing {label} ===")
        subprocess.run([sys.executable, script], check=True)
        print()

    print("=== Syncing local-decide routing rules ===")
    write_rules(load_claude_parser())
    print()

    print("=== Syncing agy lifecycle hooks ===")
    write_agy_hooks()
    print()
    print(f"agy: reads {AGENTS}/subagents, mcp_config.json and skills through symlinks; "
          "hooks.json above is the only generated artifact.")
    print("All agents synchronized (Claude Code, OpenCode, agy, local-decide).")


if __name__ == "__main__":
    main()
