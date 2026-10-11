#!/usr/bin/env python3
"""Generate Claude Code subagent files from canonical subagent files.

Canonical source: ${AI_SETUP_ROOT}/subagents/<name>.md
Output:          ${AI_SETUP_ROOT}/claude-agents/<name>.md
Symlink targets: /root/.claude/agents -> ${AI_SETUP_ROOT}/claude-agents
                 ${AI_SETUP_ROOT}/.claude/agents -> ${AI_SETUP_ROOT}/claude-agents

Bodies remain canonical, with Claude-only model identity and contract overlays in
Claude Code output. Re-run whenever canonical subagent files change.
"""
import json
import os
import pwd
import re
import sys
from pathlib import Path

ROOT = Path(os.environ.get("AI_SETUP_ROOT") or Path(__file__).resolve().parents[1])
AGENTS = ROOT  # this repo holds the agent trees at its own root
HOME = Path(os.environ.get("AI_SETUP_HOME") or pwd.getpwuid(os.getuid()).pw_dir)

SOURCE_DIR = str(AGENTS / "subagents")
OUTPUT_DIR = str(AGENTS / "claude-agents")
GLOBAL_AGENTS_LINK = str(HOME / ".claude" / "agents")
PROJECT_AGENTS_LINK = str(ROOT / ".claude" / "agents")


LIST_KEYS = ("tools", "disallowedTools", "skills")


def unquote(value: str) -> str:
    """Return the plain scalar of a YAML frontmatter value (handles quoted cards)."""
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        if value[0] == '"':
            try:
                return json.loads(value)
            except ValueError:
                return value[1:-1]
        return value[1:-1].replace("''", "'")
    return value


def parse_agent(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        raw = fh.read()
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", raw, re.S)
    if not m:
        raise ValueError(f"no frontmatter in {path}")
    frontmatter, body = m.group(1), m.group(2).strip()
    fields: dict[str, str] = {}
    lists: dict[str, list[str]] = {}
    current: str | None = None
    for line in frontmatter.splitlines():
        if line.startswith("  - "):
            # Only known list keys collect entries; anything else is ignored so a
            # future frontmatter list can never leak into tools/disallowedTools.
            if current in LIST_KEYS:
                lists.setdefault(current, []).append(line[4:].strip())
            continue
        if ":" in line and not line.startswith(" "):
            key, _, value = line.partition(":")
            current = key.strip()
            if value.strip():
                fields[current] = unquote(value.strip())
            else:
                lists.setdefault(current, [])
    return {
        "name": fields.get("name", ""),
        "description": fields.get("description", ""),
        "maxTurns": fields.get("maxTurns", ""),
        "tools": lists.get("tools", []),
        "disallowed": lists.get("disallowedTools", []),
        "skills": lists.get("skills", []),
        "body": body,
    }


def map_disallowed_tools(agent: dict) -> list[str]:
    disallowed: list[str] = []
    for item in agent.get("disallowed", []):
        if item in ("Edit", "Write"):
            if "Edit" not in disallowed:
                disallowed.append("Edit")
            if "Write" not in disallowed:
                disallowed.append("Write")
        elif item in ("Agent", "AgentSwarm"):
            if "Agent" not in disallowed:
                disallowed.append("Agent")
            if "Task" not in disallowed:
                disallowed.append("Task")
        elif item == "WebSearch":
            if "WebSearch" not in disallowed:
                disallowed.append("WebSearch")
        elif item == "FetchURL":
            if "WebFetch" not in disallowed:
                disallowed.append("WebFetch")
        elif item == "Bash":
            if "Bash" not in disallowed:
                disallowed.append("Bash")
        else:
            if item not in disallowed:
                disallowed.append(item)

    ALL_MCP_SERVERS = [
        "sequential-thinking",
        "mcp-reasoner",
        "exa",
        "unified-memory",
        "postgres",
        "playwright",
        "cloudflare",
        "codebase-memory",
        "testsprite",
        "shadcn",
        "stitch",
        "android-adb",
        "claude-design",
        "local-decide",
    ]
    for server in ALL_MCP_SERVERS:
        if not any(server in tool for tool in agent.get("tools", [])):
            rule = f"mcp__{server}__*"
            if rule not in disallowed:
                disallowed.append(rule)

    return disallowed


SUBAGENT_MODEL_LABEL = "OpenCode Go deepseek-v4.1-flash, max effort; fallback claude-haiku-5-5 max"


def claude_body(agent: dict) -> str:
    body = agent["body"]
    model_label = SUBAGENT_MODEL_LABEL
    contract_model_line = f"- Model: {SUBAGENT_MODEL_LABEL}."

    if not re.search(r"^\*\*\[Agent: [^\n]+\]\*\*$", body, flags=re.M):
        body = f"**[Agent: {agent['name']} | Model: {model_label}]**\n\n" + body
    else:
        body = re.sub(r"^\*\*\[Agent: [^\n]+\]\*\*$", f"**[Agent: {agent['name']} | Model: {model_label}]**", body, count=1, flags=re.M)

    # Claude Code subagents run at truly unconstrained max effort, so the canonical
    # "Decisive Execution" thinking throttle is stripped from the Claude Code output only.
    # ${AI_SETUP_ROOT}/subagents/ keeps the line intact for agy and Hermes.
    body = re.sub(r"^- Decisive Execution:.*\n?", "", body, flags=re.M)

    body += f"""

## Claude Code Delegation & Routing Contract
{contract_model_line}
- Inputs: TASK, SCOPE & BOUNDARY, TARGET FILES & SYMBOLS, REQUIREMENTS & INVARIANTS, TEST COMMAND.
- Language Invariant: Think, reason, and respond EXCLUSIVELY in English. Under NO circumstances should Chinese or any other language be used in thinking or output.
- Anti-Thrashing Invariant: Never run blind monorepo grep/find loops. Use codebase-memory MCP (search_code, get_code_snippet) or request clarification. Run targeted tests only (never global tsc or unbounded test suites).
- Never request full parent transcript. Load skills and MCP tools only on demand.
- Follow Output Format strictly.
"""
    return body.strip()


def render(agent: dict) -> str:
    name = agent["name"]
    disallowed = map_disallowed_tools(agent)
    head = [
        "---",
        f"name: {name}",
        # JSON quoting is valid YAML and keeps routing cards with ": " inside readable.
        f"description: {json.dumps(agent['description'])}",
    ]

    if agent.get("maxTurns"):
        head.append(f"maxTurns: {agent['maxTurns']}")
    if agent.get("skills"):
        head.append("skills:")
        for skill in agent["skills"]:
            head.append(f"  - {skill}")
    # Model selection is a router concern, not a file concern: the local router maps
    # this agent's role to its lane model, so Claude Code inherits the routed model.
    head.append("model: inherit")
    head.append("# routed by role: DEFAULT_ROLE_PLAN in claude-router/server.js")
    # Every subagent runs at max reasoning effort. "max" is only valid on the per-agent
    # `effort` field; settings.json effortLevel caps at "xhigh". Claude Code downgrades
    # gracefully for any model that does not support it.
    head.append("effort: max")
    head.append("tools:")
    for tool in agent.get("tools", []):
        head.append(f"  - {tool}")
    head.append("# Canonical positive tools are preserved; Claude Code also supports disallowedTools.")

    if disallowed:
        head.append("disallowedTools:")
        for tool in disallowed:
            head.append(f"  - {tool}")
    head.append("---")
    return "\n".join(head) + "\n\n" + claude_body(agent) + "\n"


def ensure_symlink(target: str, link_path: str) -> None:
    os.makedirs(os.path.dirname(link_path), exist_ok=True)
    if os.path.islink(link_path):
        if os.readlink(link_path) != target:
            os.remove(link_path)
            os.symlink(target, link_path)
    elif os.path.exists(link_path):
        print(f"WARN: {link_path} exists and is not a symlink", file=sys.stderr)
    else:
        os.symlink(target, link_path)


def main() -> None:
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    written = []
    for filename in sorted(os.listdir(SOURCE_DIR)):
        if not filename.endswith(".md"):
            continue
        src = os.path.join(SOURCE_DIR, filename)
        agent = parse_agent(src)
        if not agent["name"]:
            print(f"WARN: {filename} has no name field, skipping", file=sys.stderr)
            continue
        out = os.path.join(OUTPUT_DIR, filename)
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(render(agent))
        written.append(filename)

    # Remove stale/orphaned agents in output directory
    for existing in os.listdir(OUTPUT_DIR):
        if existing.endswith(".md") and existing not in written:
            os.remove(os.path.join(OUTPUT_DIR, existing))

    ensure_symlink(OUTPUT_DIR, GLOBAL_AGENTS_LINK)
    ensure_symlink(OUTPUT_DIR, PROJECT_AGENTS_LINK)

    print(f"Generated {len(written)} Claude Code agents -> {OUTPUT_DIR}")
    print(f"Symlinks verified: {GLOBAL_AGENTS_LINK} & {PROJECT_AGENTS_LINK}")


if __name__ == "__main__":
    main()
