# Unified Memory System

Shared semantic memory for Claude Code, OpenCode and agy, served as one MCP server.

## Architecture

```text
Claude Code / OpenCode / agy
    |
    | MCP (through opencode-hub, which launches this server as a stdio child)
    v
/usr/bin/python3 ${AI_SETUP_ROOT}/unified-memory/server.py mcp
    |
    +--> PostgreSQL + pgvector (table `unified_memory`)
    +--> llama-embed :11437 (OpenAI-compatible embeddings endpoint)
```

There is no persistent unified-memory HTTP gateway. The hub (or any stdio MCP client) launches the
server as a child process.

## MCP tools

- `search_memory(query, namespace?, agent?, limit?)`
- `append_memory(topic, content, namespace?, agent?, tags?, importance?)`
- `get_topic(topic, namespace?, agent?)`
- `recall_memory(agent?, namespace?, limit?)`
- `link_memory(source_id, target_id, relationship_type?)`
- `store_memory(...)` is retained for standalone records; topic work should use `append_memory`.

## Logical namespaces

| Namespace | Purpose |
|---|---|
| `memory` | Agent-specific memories |
| `research` | Research findings and summaries |
| `session` | Session summaries |
| `plan` | Execution plans and workflows |
| `skill` | Skill definitions and instructions |
| `state` | Task lifecycle and state |
| `knowledge` | General facts and patterns |
| `experience` | Lessons and mitigations |

## Client configuration

The launch definition lives in `mcp/mcp_servers.json` (hub only):

```json
{
  "unified-memory": {
    "command": "/usr/bin/python3",
    "args": ["${AI_SETUP_ROOT}/unified-memory/server.py", "mcp"]
  }
}
```

Clients never launch it themselves; they connect to the hub URL listed in `mcp/mcp_config.json`.

## Backend

| Setting | Source |
|---|---|
| PostgreSQL DSN | `UNIFIED_MEMORY_PG_DSN`, else the root-only file `/etc/unified-memory/pg_dsn` (mode 600) |
| Second database on the same server | `UNIFIED_MEMORY_DB=<name>` swaps only the database name |
| Embeddings | `EMBED_URL` (default `http://127.0.0.1:11437/v1/embeddings`), `EMBED_MODEL` (default `qwen3-embedding`) |
| Vectors | 1024 dimensions, cosine distance (pgvector) |

Never print the DSN or copy credentials into this repository.

## Verification

1. `python3 -m pytest -q tests` (offline unit tests).
2. Call `search_memory` with a harmless query through the hub.
3. Confirm PostgreSQL and `llama-embed` are active.

## Troubleshooting

- If MCP startup fails, verify Python, `psycopg2` (`requirements.txt`) and `server.py` exist at the configured paths.
- If semantic operations fail, check the embeddings endpoint and the PostgreSQL connection.

## License

Part of a local-first agent setup.
