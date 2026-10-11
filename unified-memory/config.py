import os, re
from urllib.parse import urlsplit, urlunsplit

def _homelab_dsn():
    """The homelab DSN lives only in a root-only file (mode 600), never in source (2026-10-05). A process
    that cannot read it (e.g. a non-root work copy, which uses WORK_PG_DSN) still imports this module."""
    try:
        with open("/etc/unified-memory/pg_dsn", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


PG_DSN = os.environ.get("UNIFIED_MEMORY_PG_DSN") or _homelab_dsn()
# opencode-hub's unified-memory-work (2026-10-05) is this same server on another database of the same
# Postgres: UNIFIED_MEMORY_DB swaps only the database name, so the credentials stay in one place.
WORK_DB = "work_memory"
# v5 work isolation (2026-10-05): the two work databases answer on the Postgres Unix socket to the
# peer-mapped workmem role (no password anywhere), separate from the homelab DSN above.
WORK_PG_DSN = os.environ.get(
    "WORK_MEMORY_PG_DSN",
    "postgresql://workmem@/work_memory?host=/var/run/postgresql",
)
WORK_DBS = {"work_memory", "work_mac_archive"}


def dsn_for(db):
    if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", db or ""):
        raise ValueError("invalid database name")
    return urlunsplit(urlsplit(WORK_PG_DSN if db in WORK_DBS else PG_DSN)._replace(path="/" + db))


if os.environ.get("UNIFIED_MEMORY_DB"):
    PG_DSN = dsn_for(os.environ["UNIFIED_MEMORY_DB"])
EMBED_URL = os.environ.get("EMBED_URL", "http://127.0.0.1:11437/v1/embeddings")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "qwen3-embedding")
COLLECTION = "unified_memory"
VECTOR_DIM = 1024
