"""get_topic + append_to_topic behavior: ordering, doubled-suffix handling,
chunk_total drift fix, scrub-on-write."""
import qdrant_client
from qdrant_client import get_topic, append_to_topic, store
from scrub import SOT_SUFFIX

from conftest import make_row, scroll_router

LONG = " ".join(f"finding {i}" for i in range(30))


def test_get_topic_doubled_chain_not_merged_when_canonical_exists(fake_conn, embed_stub):
    title = "Trading Systems" + SOT_SUFFIX
    doubled = title + SOT_SUFFIX
    rows = [make_row(2, title, chunk_index=1), make_row(0, title, chunk_index=0),
            make_row(1, title, chunk_index=2)]
    doubled_rows = [make_row(5, doubled, chunk_index=3)]
    fake_conn(scroll_router({title: rows, doubled: doubled_rows}))

    res = get_topic(topic="Trading Systems" + SOT_SUFFIX)  # caller passes suffixed topic
    # WO-2 retitle removed every doubled chain: canonical rows present -> the
    # legacy doubled title is a NO-OP and must NOT be merged in
    assert res["chunks"] == 3
    idx = [c["chunk_index"] for c in res["results"]]
    assert idx == [0, 1, 2]
    assert all(c.get("created_at") for c in res["results"])
    assert res["title"] == title


def test_get_topic_doubled_fallback_only_when_canonical_empty(fake_conn, embed_stub):
    title = "Legacy" + SOT_SUFFIX
    doubled = title + SOT_SUFFIX
    fake_conn(scroll_router({doubled: [make_row(5, doubled, chunk_index=0)]}))
    res = get_topic(topic="Legacy")  # zero canonical rows -> pre-retitle chain serves
    assert res["chunks"] == 1
    assert res["title"] == doubled
    assert res["results"][0]["chunk_index"] == 0


def test_get_topic_bare_topic_and_namespace(fake_conn, embed_stub):
    title = "Homelab" + SOT_SUFFIX
    rows = [make_row(1, title, chunk_index=0, namespace="knowledge"),
            make_row(2, title, chunk_index=1, namespace="knowledge")]
    other_ns = [make_row(9, title, chunk_index=0, namespace="research")]
    router = scroll_router({title: rows})
    fake_conn(router)
    res = get_topic(topic="Homelab", namespace="knowledge")
    assert res["chunks"] == 2
    assert res["namespace"] == "knowledge"


def test_get_topic_agent_filter(fake_conn, embed_stub):
    title = "T" + SOT_SUFFIX
    rows = [make_row(1, title, agent="build"), make_row(2, title, agent="quant-engineer")]
    fake_conn(scroll_router({title: rows}))
    res = get_topic(topic="T", agent="build")
    assert res["chunks"] == 1
    assert res["results"][0]["agent"] == "build"


def test_append_strips_suffix_no_doubled_title(fake_conn, embed_stub, no_fts, all_executed):
    title = "X Topic" + SOT_SUFFIX
    rows = [make_row(11, title, chunk_index=0, chunk_total=1),
            make_row(12, title, chunk_index=1, chunk_total=1)]
    conn = fake_conn(scroll_router({title: rows}))

    result = append_to_topic(topic="X Topic" + SOT_SUFFIX, new_content=LONG,
                             namespace="knowledge", agent="build")
    # NEGATIVE control: suffixed topic must NOT produce a doubled title
    assert result["title"] == title
    assert title + SOT_SUFFIX != result["title"]

    executed = all_executed(conn)
    inserts = [(s, p) for s, p in executed if "INSERT INTO memory_entries" in s]
    assert inserts and all(p[3] == title for _, p in inserts)
    updates = [(s, p) for s, p in executed if "UPDATE memory_entries SET chunk_total" in s]
    assert updates, "chunk_total drift fix UPDATE missing"
    assert updates[0][1] == (3, title, "knowledge")  # real COUNT: 2 old + 1 new chunk
    # inserts + chunk_total sync committed as ONE transaction on the shared conn
    assert conn.commits == 1 and conn.rollbacks == 0 and conn.autocommit is True


def test_append_chunk_total_real_count_not_index_arithmetic(fake_conn, embed_stub, no_fts,
                                                            all_executed):
    # qa regression: 42 real rows whose last chunk_index left chunk_total=36 stale.
    # gapped indices (0, 1, 5) must yield the real row count, not last_index+1
    title = "Gapped" + SOT_SUFFIX
    rows = [make_row(41, title, chunk_index=0, chunk_total=36),
            make_row(42, title, chunk_index=1, chunk_total=36),
            make_row(43, title, chunk_index=5, chunk_total=36)]
    conn = fake_conn(scroll_router({title: rows}))
    result = append_to_topic(topic="Gapped", new_content=LONG,
                             namespace="knowledge", agent="build")
    assert result["action"] == "updated"
    updates = [(s, p) for s, p in all_executed(conn)
               if "UPDATE memory_entries SET chunk_total" in s]
    assert updates and updates[0][1] == (4, title, "knowledge")  # 3 real rows + 1 new


def test_append_adopts_legacy_doubled_chain(fake_conn, embed_stub, no_fts):
    single = "Y" + SOT_SUFFIX
    doubled = single + SOT_SUFFIX
    rows = [make_row(21, doubled, chunk_index=0)]
    fake_conn(scroll_router({doubled: rows}))
    result = append_to_topic(topic="Y", new_content=LONG, namespace="knowledge", agent="build")
    # existing doubled chain is adopted (single chain), never a third title
    assert result["title"] == doubled


def test_append_scrubs_secrets_before_write(fake_conn, embed_stub, no_fts, all_executed):
    title = "Sec" + SOT_SUFFIX
    pw = "Su" + "perSecret99"
    rows = [make_row(31, title, chunk_index=0)]
    conn = fake_conn(scroll_router({title: rows}))
    append_to_topic(topic="Sec", new_content="dsn postgresql://u:" + pw + "@h/db " + LONG,
                    namespace="knowledge", agent="build")
    executed = all_executed(conn)
    inserts = [p for s, p in executed if "INSERT INTO memory_entries" in s]
    assert inserts
    assert all(pw not in (p[4] or "") for p in inserts)
    assert all("[REDACTED:dsn]" in p[4] for p in inserts)
    assert all(p[11].adapted.get("scrubbed") == ["dsn"] for p in inserts)


def test_store_scrubs_secrets(fake_conn, embed_stub):
    from psycopg2.extras import Json
    pw = "stor" + "edPass77"
    conn = fake_conn(scroll_router({}))
    store("knowledge", "build", "Plain Title",
          "short body with password=" + pw + " tail")
    inserts = [p for cur in conn.cursors for s, p in cur.executed
               if "INSERT INTO memory_entries" in s]
    assert inserts
    assert pw not in inserts[0][4]
    assert "[REDACTED:password]" in inserts[0][4]
    assert inserts[0][11].adapted.get("scrubbed") == ["password"]


def test_append_creates_when_missing(fake_conn, embed_stub, no_fts, all_executed):
    conn = fake_conn(scroll_router({}))
    result = append_to_topic(topic="Brand New", new_content=LONG,
                             namespace="knowledge", agent="build")
    assert result["action"] == "created"
    assert result["title"] == "Brand New" + SOT_SUFFIX  # exactly one suffix
