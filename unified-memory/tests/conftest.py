import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

import qdrant_client
from scrub import SOT_SUFFIX

ROW_COLS = ["id", "namespace", "agent", "title", "content", "content_preview", "tags",
            "importance", "source", "created_at", "updated_at", "metadata",
            "chunk_index", "chunk_total"]
VEC_COLS = ROW_COLS + ["score"]


def make_row(rid, title, chunk_index=0, chunk_total=1, namespace="knowledge",
             agent="build", content="chunk body", importance=5, created_at=None,
             metadata=None):
    from datetime import datetime, timezone
    ts = created_at or datetime(2026, 10, 7, 12, 0, tzinfo=timezone.utc)
    return {
        "id": rid, "namespace": namespace, "agent": agent, "title": title,
        "content": content, "content_preview": content[:200], "tags": [],
        "importance": importance, "source": "", "created_at": ts,
        "updated_at": ts, "metadata": metadata if metadata is not None else {},
        "chunk_index": chunk_index, "chunk_total": chunk_total,
    }


def as_tuple(row, cols):
    return tuple(row[c] for c in cols)


class FakeCursor:
    def __init__(self, router):
        self._router = router
        self.executed = []
        self.description = ()
        self._rows = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        cols, rows = self._router(sql, list(params) if params is not None else [])
        self.description = tuple((c, None, None, None, None, None, None) for c in cols)
        self._rows = list(rows)

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def close(self):
        pass


class FakeConn:
    def __init__(self, router):
        self._router = router
        self.cursors = []
        self.autocommit = True
        self.commits = 0
        self.rollbacks = 0

    def cursor(self):
        cur = FakeCursor(self._router)
        self.cursors.append(cur)
        return cur

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


def scroll_router(by_title):
    """Router for title-driven flows (get_topic / append): {title: [row dicts]}.
    INSERTs are tracked so COUNT(*) returns the real row count of the title."""
    inserted_by_title = {}

    def router(sql, params):
        if "COUNT(*)" in sql:
            n = len(by_title.get(params[0], [])) + inserted_by_title.get(params[0], 0)
            return ("count",), [(n,)]
        if "WHERE title" in sql:
            rows = by_title.get(params[0], [])
            return ROW_COLS, [as_tuple(r, ROW_COLS) for r in rows]
        if "ORDER BY embedding" in sql:
            return VEC_COLS, []
        if "INSERT INTO memory_entries" in sql:
            inserted_by_title[params[3]] = inserted_by_title.get(params[3], 0) + 1
            return [], []
        if "UPDATE memory_entries SET chunk_total" in sql:
            return [], []
        raise AssertionError(f"unexpected SQL in test: {sql[:80]}")
    return router


@pytest.fixture
def fake_conn(monkeypatch):
    def install(router):
        conn = FakeConn(router)
        monkeypatch.setattr(qdrant_client, "_get_conn", lambda dsn=None: conn)
        return conn
    return install


@pytest.fixture
def embed_stub(monkeypatch):
    monkeypatch.setattr(qdrant_client, "embed", lambda text, max_retries=3: [0.1] * 4)
    monkeypatch.setattr(qdrant_client, "embed_batch",
                        lambda texts: [[0.1] * 4 for _ in texts])


@pytest.fixture
def no_fts(monkeypatch):
    monkeypatch.setattr(qdrant_client, "_fts_available", lambda: False)


@pytest.fixture
def all_executed():
    def get(conn):
        return [item for cur in conn.cursors for item in cur.executed]
    return get
