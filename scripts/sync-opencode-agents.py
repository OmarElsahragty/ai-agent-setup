#!/usr/bin/env python3
"""Generate OpenCode subagent files from canonical subagents.

Canonical source: ${AI_SETUP_ROOT}/subagents/<name>.md
Output:          ${AI_SETUP_ROOT}/opencode-agents/<name>.md
Symlink target:  /root/.config/opencode/agents -> ${AI_SETUP_ROOT}/opencode-agents

All OpenCode subagents use DeepSeek V4.1 Flash via the opencode-go provider (opencode-go/deepseek-v4.1-flash)
with variant: max (owner 2026-10-11) and concurrency capped at 4 streams.
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
OUTPUT_DIR = str(AGENTS / "opencode-agents")
GLOBAL_AGENTS_LINK = str(HOME / ".config" / "opencode" / "agents")
MODEL = "opencode-go/deepseek-v4.1-flash"
VARIANT = "max"
MODEL_LABEL = "DeepSeek V4.1 Flash"

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


def permissions_for(disallowed: list[str]) -> list[str]:
    perms: list[str] = []
    def add_perm(p: str):
        if p not in perms:
            perms.append(p)

    for item in disallowed:
        if item in ("Edit", "Write"):
            add_perm("edit: deny")
        elif item == "WebSearch":
            add_perm("websearch: deny")
        elif item == "FetchURL":
            add_perm("webfetch: deny")
        elif item == "Bash":
            add_perm("bash: deny")
        elif item in ("Agent", "AgentSwarm", "Task"):
            add_perm("task: deny")
    return perms


def opencode_body(agent: dict) -> str:
    body = agent["body"]
    if not re.search(r"^\*\*\[Agent: [^\n]+\]\*\*$", body, flags=re.M):
        body = f"**[Agent: {agent['name']} | Model: {MODEL_LABEL}]**\n\n" + body
    else:
        body = re.sub(r"^\*\*\[Agent: [^\n]+\]\*\*$", f"**[Agent: {agent['name']} | Model: {MODEL_LABEL}]**", body, count=1, flags=re.M)
    body = body.replace("Google Gemini 3.8 Flash (Proxy)", MODEL_LABEL)
    body = body.replace("Claude Sonnet 5", MODEL_LABEL)
    body = body.replace("Anthropic Claude Sonnet 5", MODEL_LABEL)
    # OpenCode's agent frontmatter is deny-based (permission:), so the canonical
    # allow-list is restated here to keep the routing contract readable and auditable.
    allowed = "\n".join(f"  - {tool}" for tool in agent.get("tools", []))
    turn_budget = f"- Turn budget: {agent['maxTurns']} (maxTurns).\n" if agent.get("maxTurns") else ""
    body += f"""

## Tools allowed
{allowed}

## OpenCode Delegation & Concurrency Contract
- Model: {MODEL_LABEL} via the opencode-go provider (variant: {VARIANT}).
{turn_budget}- Language Invariant: Think, reason, and respond EXCLUSIVELY in English. Under NO circumstances should Chinese or any other language be used in thinking or output.
- Concurrency limit: Maximum 4 parallel subagent streams globally across homelab.
- Follow Output Format strictly.
"""
    return body.strip()


def render(agent: dict) -> str:
    perms = permissions_for(agent["disallowed"])
    head = [
        "---",
        f"name: {agent['name']}",
        f"description: {json.dumps(agent['description'])}",
        "mode: subagent",
        f"model: {MODEL}",
        f"variant: {VARIANT}",
    ]
    if perms:
        head.append("permission:")
        for p in perms:
            head.append(f"  {p}")
    head.append("---")
    return "\n".join(head) + "\n\n" + opencode_body(agent) + "\n"


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

    # Clean orphaned agents
    for existing in os.listdir(OUTPUT_DIR):
        if existing.endswith(".md") and existing not in written:
            os.remove(os.path.join(OUTPUT_DIR, existing))

    ensure_symlink(OUTPUT_DIR, GLOBAL_AGENTS_LINK)
    print(f"Generated {len(written)} OpenCode agents -> {OUTPUT_DIR}")
    print(f"Symlink verified: {GLOBAL_AGENTS_LINK} -> {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
