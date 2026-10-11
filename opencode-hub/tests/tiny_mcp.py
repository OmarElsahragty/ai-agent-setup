"""A one-tool stdio MCP server for the hub tests: ping -> pong."""
from mcp.server.fastmcp import FastMCP

server = FastMCP("tiny")


@server.tool()
def ping() -> str:
    """Answer pong."""
    return "pong"


if __name__ == "__main__":
    server.run()
