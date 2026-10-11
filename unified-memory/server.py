#!/usr/bin/env python3
"""Unified Memory MCP Server — single source of truth for all agent memory.

Exposes stdio MCP protocol for Kimi/OpenCode.
"""
import sys, os, json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from qdrant_client import store, search, recall, link, update, delete, append_to_topic, get_topic
from scrub import scrub

# === stdio MCP Protocol (simple JSON-RPC over stdin/stdout) ===
def handle_mcp_line(line):
    req = None
    try:
        req = json.loads(line)
        method = req.get("method", "")
        params = req.get("params", {})
        req_id = req.get("id")
        is_notification = "id" not in req

        # --- Core MCP handshake ---
        if method == "initialize":
            return {"jsonrpc": "2.0", "id": req_id, "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "unified-memory", "version": "1.0.0"},
            }}

        # Notifications have no id — server MUST NOT respond
        if method == "notifications/initialized":
            return None
        if method == "notifications/cancelled":
            return None

        # Ping/pong keepalive
        if method == "ping":
            return {"jsonrpc": "2.0", "id": req_id, "result": {}}

        # Empty capability lists (we only expose tools)
        if method == "prompts/list":
            return {"jsonrpc": "2.0", "id": req_id, "result": {"prompts": []}}
        if method == "resources/list":
            return {"jsonrpc": "2.0", "id": req_id, "result": {"resources": []}}
        if method == "resources/templates/list":
            return {"jsonrpc": "2.0", "id": req_id, "result": {"resourceTemplates": []}}

        # --- Tool listing ---
        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": [
                {"name": "store_memory", "description": "Store a memory/knowledge entry in the unified database",
                 "inputSchema": {"type": "object", "properties": {
                     "namespace": {"type": "string", "enum": ["memory","research","session","plan","skill","state","knowledge","experience"]},
                     "agent": {"type": "string"},
                     "title": {"type": "string"},
                     "content": {"type": "string"},
                     "tags": {"type": "array", "items": {"type": "string"}},
                     "importance": {"type": "integer", "minimum": 1, "maximum": 10}
                 }, "required": ["namespace", "title", "content"]}},
                {"name": "search_memory", "description": "Semantic search across all memory. Results are ranked by a blended score (cosine similarity x recency decay x importance boost) and merged with full-text rank when available. Excludes the 'archive' namespace and superseded rows unless include_archive is true.",
                 "inputSchema": {"type": "object", "properties": {
                     "query": {"type": "string"},
                     "namespace": {"type": "string"},
                     "agent": {"type": "string"},
                     "limit": {"type": "integer"},
                     "include_archive": {"type": "boolean", "description": "Also search archived/superseded rows (default false)"}
                 }, "required": ["query"]}},
                {"name": "recall_memory", "description": "Recall all memory for an agent or namespace",
                 "inputSchema": {"type": "object", "properties": {
                     "agent": {"type": "string"},
                     "namespace": {"type": "string"},
                     "importance_min": {"type": "integer", "description": "Only entries with importance >= this (1-10 scale)"},
                     "limit": {"type": "integer"},
                     "include_archive": {"type": "boolean", "description": "Also recall archived/superseded rows (default false)"}
                 }}},
                {"name": "get_topic", "description": "Retrieve the FULL Single Source of Truth entry for a topic: every chunk ordered by chunk_index, with created_at. Accepts the topic with or without the ' — SINGLE SOURCE OF TRUTH' suffix; also matches legacy doubled-suffix titles. Use this instead of search_memory when you need the whole SOT.",
                 "inputSchema": {"type": "object", "properties": {
                     "topic": {"type": "string", "description": "Topic name, with or without the SOT suffix"},
                     "namespace": {"type": "string"},
                     "agent": {"type": "string", "description": "Restrict to chunks written by this agent"}
                 }, "required": ["topic"]}},
                {"name": "link_memory", "description": "Link two memory entries (knowledge graph)",
                 "inputSchema": {"type": "object", "properties": {
                     "source_id": {"type": "integer"},
                     "target_id": {"type": "integer"},
                     "relationship_type": {"type": "string"}
                 }, "required": ["source_id", "target_id"]}},
                {"name": "append_memory", "description": "Append new findings to a topic's Single Source of Truth entry. Auto-finds existing SOT by topic name, merges content, re-stores. Creates new SOT if none exists. PREFERRED over store_memory for all non-trivial work.",
                 "inputSchema": {"type": "object", "properties": {
                     "topic": {"type": "string", "description": "Topic name (e.g. 'Homelab Infrastructure', 'My Project'). Must match existing SOT topic or will create new one."},
                     "content": {"type": "string", "description": "New findings/work to append to the topic's SOT"},
                     "namespace": {"type": "string", "description": "Default: knowledge"},
                     "agent": {"type": "string"},
                     "tags": {"type": "array", "items": {"type": "string"}},
                     "importance": {"type": "integer", "minimum": 1, "maximum": 10}
                 }, "required": ["topic", "content"]}}]
            }}

        # --- Tool execution ---
        if method == "tools/call":
            tool = params.get("name")
            args = params.get("arguments", {})

            if tool == "store_memory":
                result = store(**{"agent": "system", **args})  # agent is optional in the schema
            elif tool == "search_memory":
                result = search(**args)
            elif tool == "recall_memory":
                result = recall(**args)
            elif tool == "get_topic":
                result = get_topic(
                    topic=args["topic"],
                    namespace=args.get("namespace"),
                    agent=args.get("agent")
                )
            elif tool == "link_memory":
                result = link(**args)
            elif tool == "append_memory":
                result = append_to_topic(
                    topic=args["topic"],
                    new_content=args["content"],
                    namespace=args.get("namespace", "knowledge"),
                    agent=args.get("agent", "system"),
                    tags=args.get("tags", []),
                    importance=args.get("importance", 9)
                )
            else:
                if is_notification:
                    return None
                return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": f"unknown tool: {tool}"}}

            return {"jsonrpc": "2.0", "id": req_id, "result": {"content": [{"type": "text", "text": json.dumps(result, indent=2, default=str)}]}}

        # Unknown method — only respond if it's a request (not notification)
        if is_notification:
            return None
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": f"unknown method: {method}"}}

    except Exception as e:
        req_id = req.get("id") if isinstance(req, dict) else None
        # exception text can embed caller-supplied secrets — scrub before returning
        return {"jsonrpc": "2.0", "id": req_id,
                "error": {"code": -32603, "message": scrub(str(e))[0]}}


def run_mcp_stdio():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        response = handle_mcp_line(line)
        if response is not None:
            print(json.dumps(response), flush=True)

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "mcp"

    if mode == "mcp":
        run_mcp_stdio()
    else:
        print(f"Unknown mode: {mode}. Use 'mcp'", file=sys.stderr)
        sys.exit(1)
