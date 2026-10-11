"""search()/recall() blended ranking, lifecycle exclusions, hybrid RRF."""
from datetime import datetime, timedelta, timezone

import qdrant_client
from qdrant_client import search, recall

from conftest import make_row, as_tuple, ROW_COLS, VEC_COLS

NOW = datetime(2026, 10, 7, 12, 0, tzinfo=timezone.utc)


def vec_router(rows, capture=None):
    """rows: list of row dicts (score key optional, defaults 0.8)."""
    def router(sql, params):
        if capture is not None:
            capture.append((sql, params))
        if "ORDER BY embedding" in sql:
            out = [dict(r, score=r.get("score", 0.8)) for r in rows]
            return VEC_COLS, [as_tuple(r, VEC_COLS) for r in out]
        return [], []
    return router


def test_recency_blend_ranks_newer_above_older_equal_cosine(fake_conn, embed_stub, no_fts):
    old = make_row(1, "Old — SINGLE SOURCE OF TRUTH", created_at=NOW - timedelta(days=365))
    new = make_row(2, "New — SINGLE SOURCE OF TRUTH", created_at=NOW - timedelta(days=1))
    fake_conn(vec_router([old, new]))
    res = search(query="q", limit=5)
    titles = [r["title"] for r in res["results"]]
    assert titles[0].startswith("New")
    assert res["results"][0]["score"] > res["results"][1]["score"]
    assert res["results"][0]["score"] < 0.8  # decay always applied
    assert res["results"][0]["created_at"]  # dates returned


def test_importance_boost_breaks_ties(fake_conn, embed_stub, no_fts):
    low = make_row(1, "Low", importance=3, created_at=NOW)
    high = make_row(2, "High", importance=9, created_at=NOW)
    fake_conn(vec_router([low, high]))
    res = search(query="q", limit=5)
    assert res["results"][0]["title"] == "High"
    assert res["results"][0]["score"] > res["results"][1]["score"]


def test_search_excludes_archive_and_superseded_by_default(fake_conn, embed_stub, no_fts):
    capture = []
    fake_conn(vec_router([], capture))
    search(query="q")
    sql = capture[0][0]
    assert "namespace <> 'archive'" in sql
    assert "(metadata->>'superseded') IS DISTINCT FROM 'true'" in sql


def test_search_include_archive_opts_out(fake_conn, embed_stub, no_fts):
    capture = []
    fake_conn(vec_router([], capture))
    search(query="q", include_archive=True)
    sql = capture[0][0]
    assert "namespace <> 'archive'" not in sql
    assert "IS DISTINCT FROM 'true'" not in sql


def test_search_agent_filter_in_sql_and_params(fake_conn, embed_stub, no_fts):
    capture = []
    fake_conn(vec_router([], capture))
    search(query="q", agent="build")
    sql, params = capture[0]
    assert "agent = %s" in sql
    assert "build" in params


def test_search_hybrid_rrf_merges_fts_rank(fake_conn, embed_stub, monkeypatch):
    monkeypatch.setattr(qdrant_client, "_fts_available", lambda: True)
    a = make_row(1, "A — SINGLE SOURCE OF TRUTH", created_at=NOW)
    b = make_row(2, "B — SINGLE SOURCE OF TRUTH", created_at=NOW)
    c = make_row(3, "C — SINGLE SOURCE OF TRUTH", created_at=NOW)

    def router(sql, params):
        if "ts_rank" in sql:
            return ROW_COLS, [as_tuple(c, ROW_COLS), as_tuple(b, ROW_COLS)]
        out = [dict(a, score=0.90), dict(b, score=0.85)]
        return VEC_COLS, [as_tuple(r, VEC_COLS) for r in out]

    fake_conn(router)
    res = search(query="port 3012 gateway", limit=3)
    titles = [r["title"][:1] for r in res["results"]]
    # B appears in both lists -> top by reciprocal-rank fusion (k=60)
    assert titles[0] == "B"
    # C exists only in the FTS pass but still surfaces
    assert "C" in titles and "A" in titles
    assert all("rrf_score" in r for r in res["results"])


def test_recall_excludes_archive_and_supports_importance_min(fake_conn, embed_stub):
    capture = []

    def router(sql, params):
        capture.append((sql, params))
        return ROW_COLS, []

    fake_conn(router)
    recall(agent="build", namespace="knowledge", importance_min=7)
    sql, params = capture[0]
    assert "agent = %s" in sql and "namespace = %s" in sql
    assert "importance >= %s" in sql and 7 in params
    assert "namespace <> 'archive'" in sql
    assert "IS DISTINCT FROM 'true'" in sql


def test_recall_include_archive_opts_out(fake_conn, embed_stub):
    capture = []

    def router(sql, params):
        capture.append((sql, params))
        return ROW_COLS, []

    fake_conn(router)
    recall(include_archive=True)
    sql, _ = capture[0]
    assert "namespace <> 'archive'" not in sql
    assert "IS DISTINCT FROM 'true'" not in sql
