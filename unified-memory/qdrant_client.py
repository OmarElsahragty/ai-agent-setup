import json, hashlib, math
import psycopg2
from psycopg2.extras import Json as PGJson
from config import PG_DSN, COLLECTION
from embeddings import embed, embed_batch
from chunker import chunk_text
from scrub import scrub, normalize_topic, sot_title

_conns = {}  # one autocommit connection per DSN (search() may target the work store)

SOT_SUFFIX = " — SINGLE SOURCE OF TRUTH"

_FTS_STATE = {"checked": False, "available": False}


def _fts_available():
    """True when memory_entries has an 'fts' tsvector column (WO-2 DDL). Detected
    once per process; any failure degrades safely to vector-only search."""
    if not _FTS_STATE["checked"]:
        try:
            conn = _get_conn()
            cur = conn.cursor()
            cur.execute(
                """SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'memory_entries' AND column_name = 'fts' LIMIT 1"""
            )
            _FTS_STATE["available"] = cur.fetchone() is not None
            cur.close()
        except Exception:
            _FTS_STATE["available"] = False
        _FTS_STATE["checked"] = True
    return _FTS_STATE["available"]


def _blend_score(cosine, created_at, importance):
    """cosine x recency decay (45-day window) x small importance boost (1-10 scale)."""
    from datetime import datetime, timezone
    age_days = 0.0
    if created_at is not None:
        try:
            age_days = (datetime.now(timezone.utc) - created_at).total_seconds() / 86400.0
            if age_days < 0:
                age_days = 0.0
        except TypeError:
            age_days = 0.0
    imp = importance if isinstance(importance, (int, float)) else 5
    return cosine * (0.75 + 0.25 * math.exp(-age_days / 45.0)) * (1 + 0.02 * (imp - 5))


def _get_conn(dsn=None):
    dsn = dsn or PG_DSN
    conn = _conns.get(dsn)
    if conn is None or conn.closed:
        conn = psycopg2.connect(dsn)
        conn.autocommit = True
        _conns[dsn] = conn
    return conn


def _vec_to_pg(vector):
    """Convert a list of floats to pgvector string literal."""
    return "[" + ",".join(repr(float(x)) for x in vector) + "]"


def _make_id(namespace, title, agent):
    raw = f"{namespace}|{title}|{agent}"
    return int(hashlib.md5(raw.encode()).hexdigest()[:15], 16)


def _row_to_payload(row):
    """Convert a DB row dict to the payload format expected by callers."""
    return {
        "namespace": row["namespace"],
        "agent": row["agent"],
        "title": row["title"],
        "content": row["content"],
        "content_preview": row["content_preview"] or "",
        "tags": row["tags"] or [],
        "importance": row["importance"],
        "source": row["source"] or "",
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
        "metadata": row["metadata"] or {},
        "chunk_index": row["chunk_index"],
        "chunk_total": row["chunk_total"],
    }


def store(namespace, agent, title, content, tags=None, importance=3, metadata=None, source=None):
    tags = tags or []
    metadata = dict(metadata or {})
    title, _title_kinds = scrub(title)  # titles are written to disk too
    content, scrub_kinds = scrub(content)
    if scrub_kinds:
        metadata["scrubbed"] = scrub_kinds
    chunks = chunk_text(content)

    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()

    conn = _get_conn()
    cur = conn.cursor()

    if len(chunks) <= 1:
        point_id = _make_id(namespace, title, agent)
        text = f"{title}\n\n{chunks[0] if chunks else content}"
        vector = embed(text)
        if vector is None:
            return {"id": None, "chunks": 0}
        payload = {
            "namespace": namespace, "agent": agent, "title": title,
            "content": content, "content_preview": content[:200],
            "tags": tags, "importance": importance, "source": source or "",
            "created_at": now, "updated_at": now,
            "metadata": metadata, "chunk_index": 0, "chunk_total": 1
        }
        cur.execute(
            """INSERT INTO memory_entries
               (id, namespace, agent, title, content, content_preview, tags, importance,
                source, created_at, updated_at, metadata, chunk_index, chunk_total, embedding)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::vector)
               ON CONFLICT (id) DO UPDATE SET
                 namespace=EXCLUDED.namespace, agent=EXCLUDED.agent, title=EXCLUDED.title,
                 content=EXCLUDED.content, content_preview=EXCLUDED.content_preview,
                 tags=EXCLUDED.tags, importance=EXCLUDED.importance, source=EXCLUDED.source,
                 updated_at=EXCLUDED.updated_at, metadata=EXCLUDED.metadata,
                 chunk_index=EXCLUDED.chunk_index, chunk_total=EXCLUDED.chunk_total,
                 embedding=EXCLUDED.embedding""",
            (point_id, namespace, agent, title, content, content[:200], tags, importance,
             source or "", now, now, PGJson(metadata), 0, 1, _vec_to_pg(vector))
        )
        cur.close()
        return {"id": point_id, "chunks": 1}

    chunk_texts = [f"{title}\n\n{c}" for c in chunks]
    vectors = embed_batch(chunk_texts)
    inserted = 0
    first_id = None
    for i, (chunk, vector) in enumerate(zip(chunks, vectors)):
        if vector is None:
            continue
        point_id = _make_id(namespace, f"{title}_chunk_{i}", agent)
        if first_id is None:
            first_id = point_id
        cur.execute(
            """INSERT INTO memory_entries
               (id, namespace, agent, title, content, content_preview, tags, importance,
                source, created_at, updated_at, metadata, chunk_index, chunk_total, embedding)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::vector)
               ON CONFLICT (id) DO UPDATE SET
                 namespace=EXCLUDED.namespace, agent=EXCLUDED.agent, title=EXCLUDED.title,
                 content=EXCLUDED.content, content_preview=EXCLUDED.content_preview,
                 tags=EXCLUDED.tags, importance=EXCLUDED.importance, source=EXCLUDED.source,
                 updated_at=EXCLUDED.updated_at, metadata=EXCLUDED.metadata,
                 chunk_index=EXCLUDED.chunk_index, chunk_total=EXCLUDED.chunk_total,
                 embedding=EXCLUDED.embedding""",
            (point_id, namespace, agent, title, chunk, chunk[:200], tags, importance,
             source or "", now, now, PGJson(metadata), i, len(chunks), _vec_to_pg(vector))
        )
        inserted += 1

    cur.close()
    return {"id": first_id, "chunks": inserted}


def search(query, namespace=None, agent=None, tags=None, limit=10, dsn=None,
           include_archive=False):
    vector = embed(query)
    if vector is None:
        return {"results": []}

    conn = _get_conn(dsn)
    cur = conn.cursor()
    vec_str = _vec_to_pg(vector)

    where_clauses = []
    params = []

    if namespace:
        where_clauses.append("namespace = %s")
        params.append(namespace)
    if agent:
        where_clauses.append("agent = %s")
        params.append(agent)
    if tags:
        for tag in tags:
            where_clauses.append("%s = ANY(tags)")
            params.append(tag)
    # lifecycle defaults: archive namespace and superseded rows are invisible
    # unless the caller explicitly opts in (or explicitly filters namespace='archive')
    if not include_archive and namespace != "archive":
        where_clauses.append("namespace <> 'archive'")
    if not include_archive:
        where_clauses.append("(metadata->>'superseded') IS DISTINCT FROM 'true'")

    where_sql = (" WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
    search_limit = limit * 5 if where_clauses else limit * 3

    cur.execute(
        f"""SELECT id, namespace, agent, title, content, content_preview, tags,
                  importance, source, created_at, updated_at, metadata,
                  chunk_index, chunk_total,
                  1 - (embedding <=> %s::vector) AS score
           FROM memory_entries{where_sql}
           ORDER BY embedding <=> %s::vector
           LIMIT %s""",
        [vec_str] + params + [vec_str, search_limit]
    )

    cols = [desc[0] for desc in cur.description]
    vec_rows = [dict(zip(cols, r)) for r in cur.fetchall()]

    # optional full-text pass (tsvector column 'fts', added by WO-2); merged below
    fts_rows = []
    if _fts_available():
        fts_clause = ("AND" if where_sql else "WHERE") + " fts @@ plainto_tsquery('english', %s)"
        cur.execute(
            f"""SELECT id, namespace, agent, title, content, content_preview, tags,
                      importance, source, created_at, updated_at, metadata,
                      chunk_index, chunk_total
               FROM memory_entries{where_sql} {fts_clause}
               ORDER BY ts_rank(fts, plainto_tsquery('english', %s)) DESC
               LIMIT %s""",
            params + [query, query, search_limit]
        )
        fcols = [desc[0] for desc in cur.description]
        fts_rows = [dict(zip(fcols, r)) for r in cur.fetchall()]
    cur.close()

    # blended vector score: cosine x recency x importance
    for row in vec_rows:
        row["blended"] = _blend_score(row.get("score") or 0.0, row.get("created_at"),
                                      row.get("importance"))
    vec_sorted = sorted(vec_rows, key=lambda r: r["blended"], reverse=True)
    vec_rank = {row["id"]: i + 1 for i, row in enumerate(vec_sorted)}
    fts_rank = {row["id"]: i + 1 for i, row in enumerate(fts_rows)}
    hybrid = bool(fts_rank)

    by_id = {}
    for row in vec_sorted + fts_rows:
        if row["id"] not in by_id:
            r = dict(row)
            if "blended" not in r:
                r["score"] = None
                r["blended"] = 0.0
            by_id[row["id"]] = r

    # reciprocal-rank fusion (k=60) when FTS participated, blended score otherwise
    RRF_K = 60
    scored = []
    for rid, row in by_id.items():
        rrf = 0.0
        if rid in vec_rank:
            rrf += 1.0 / (RRF_K + vec_rank[rid])
        if rid in fts_rank:
            rrf += 1.0 / (RRF_K + fts_rank[rid])
        scored.append((rrf if hybrid else row["blended"], row))
    scored.sort(key=lambda t: t[0], reverse=True)

    seen = {}
    ordered = []
    for key, row in scored:
        dedup_key = f"{row['title']}|{row['agent']}"
        if dedup_key in seen:
            continue
        entry = _row_to_payload(row)
        entry["id"] = row["id"]
        entry["score"] = round(row["blended"], 6)
        if hybrid:
            entry["rrf_score"] = round(key, 8)
        seen[dedup_key] = entry
        ordered.append(entry)

    return {"results": ordered[:limit]}


def recall(agent=None, namespace=None, importance_min=None, limit=50, include_archive=False):
    conn = _get_conn()
    cur = conn.cursor()

    where_clauses = []
    params = []

    if agent:
        where_clauses.append("agent = %s")
        params.append(agent)
    if namespace:
        where_clauses.append("namespace = %s")
        params.append(namespace)
    if importance_min:
        where_clauses.append("importance >= %s")
        params.append(importance_min)
    if not include_archive and namespace != "archive":
        where_clauses.append("namespace <> 'archive'")
    if not include_archive:
        where_clauses.append("(metadata->>'superseded') IS DISTINCT FROM 'true'")

    where_sql = (" WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
    params.append(limit)

    cur.execute(
        f"""SELECT id, namespace, agent, title, content, content_preview, tags,
                  importance, source, created_at, updated_at, metadata,
                  chunk_index, chunk_total
           FROM memory_entries{where_sql}
           ORDER BY created_at DESC
           LIMIT %s""",
        params
    )

    cols = [desc[0] for desc in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    cur.close()

    seen = {}
    for row in rows:
        key = f"{row['title']}|{row['agent']}"
        if key not in seen:
            entry = _row_to_payload(row)
            entry["id"] = row["id"]
            seen[key] = entry

    return {"results": list(seen.values())[:limit]}


def link(source_id, target_id, relationship_type="relates_to"):
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute(
        "SELECT metadata FROM memory_entries WHERE id = %s",
        (source_id,)
    )
    row = cur.fetchone()
    if row is None:
        cur.close()
        return {"error": "source not found"}

    metadata = row[0] or {}
    links = metadata.get("relationships", [])
    links.append({"type": relationship_type, "target_id": target_id})
    metadata["relationships"] = links

    cur.execute(
        "UPDATE memory_entries SET metadata = %s WHERE id = %s",
        (PGJson(metadata), source_id)
    )
    cur.close()
    return {"linked": True}


def update(point_id, fields):
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute(
        """SELECT namespace, agent, title, content, content_preview, tags, importance,
                  source, created_at, updated_at, metadata, chunk_index, chunk_total
           FROM memory_entries WHERE id = %s""",
        (point_id,)
    )
    cols = [desc[0] for desc in cur.description]
    row = cur.fetchone()
    if row is None:
        cur.close()
        return {"error": "not found"}

    payload = dict(zip(cols, row))

    scrub_kinds = []
    if "title" in fields:
        clean_title, _tk = scrub(fields["title"])
        fields = dict(fields)
        fields["title"] = clean_title
    if "content" in fields:
        clean, scrub_kinds = scrub(fields["content"])
        fields = dict(fields)
        fields["content"] = clean
        if scrub_kinds:
            md = dict(fields.get("metadata") or payload.get("metadata") or {})
            md.setdefault("scrubbed", scrub_kinds)
            fields["metadata"] = md

    if "content" in fields:
        text = f"{fields.get('title', payload.get('title', ''))}\n\n{fields['content']}"
        vector = embed(text)
        from datetime import datetime, timezone
        payload.update(fields)
        payload["updated_at"] = datetime.now(timezone.utc).isoformat()
        cur.execute(
            """UPDATE memory_entries SET
                 namespace=%s, agent=%s, title=%s, content=%s, content_preview=%s,
                 tags=%s, importance=%s, source=%s, updated_at=%s, metadata=%s,
                 chunk_index=%s, chunk_total=%s, embedding=%s::vector
               WHERE id = %s""",
            (payload["namespace"], payload["agent"], payload["title"],
             payload["content"], payload["content_preview"],
             payload["tags"], payload["importance"], payload["source"],
             payload["updated_at"], PGJson(payload.get("metadata") or {}),
             payload["chunk_index"], payload["chunk_total"],
             _vec_to_pg(vector) if vector else _vec_to_pg([0.0] * 1024),
             point_id)
        )
    else:
        set_clauses = []
        params = []
        for k, v in fields.items():
            if k == "metadata":
                set_clauses.append("metadata = %s")
                params.append(PGJson(v))
            elif k == "tags":
                set_clauses.append("tags = %s")
                params.append(v)
            else:
                set_clauses.append(f"{k} = %s")
                params.append(v)
        set_clauses.append("updated_at = now()")
        params.append(point_id)
        cur.execute(
            f"UPDATE memory_entries SET {', '.join(set_clauses)} WHERE id = %s",
            params
        )
    cur.close()
    return {"updated": True}


def delete(point_id):
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute("DELETE FROM memory_entries WHERE id = %s", (point_id,))
    cur.close()
    return {"deleted": True}


def _scroll_by_title(title, namespace=None, limit=200):
    """Get all chunks for a document by exact title match."""
    conn = _get_conn()
    cur = conn.cursor()
    if namespace:
        cur.execute(
            """SELECT id, namespace, agent, title, content, content_preview, tags,
                      importance, source, created_at, updated_at, metadata,
                      chunk_index, chunk_total
               FROM memory_entries WHERE title = %s AND namespace = %s
               ORDER BY chunk_index LIMIT %s""",
            (title, namespace, limit)
        )
    else:
        cur.execute(
            """SELECT id, namespace, agent, title, content, content_preview, tags,
                      importance, source, created_at, updated_at, metadata,
                      chunk_index, chunk_total
               FROM memory_entries WHERE title = %s
               ORDER BY chunk_index LIMIT %s""",
            (title, limit)
        )
    cols = [desc[0] for desc in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    cur.close()
    points = []
    for row in rows:
        entry = _row_to_payload(row)
        entry["id"] = row["id"]
        points.append({"id": row["id"], "payload": entry})
    return points


def get_topic(topic, namespace=None, agent=None):
    """Retrieve a full SOT entry: every chunk, ordered by chunk_index, with created_at.

    Accepts the topic with or without the ' — SINGLE SOURCE OF TRUTH' suffix.
    The legacy doubled-suffix title is a NO-OP FALLBACK: it is consulted only
    when the canonical title has zero rows (the WO-2 retitle removed every
    doubled chain, so canonical and legacy rows are never merged any more).
    An optional agent filter restricts to chunks written by one agent."""
    base = normalize_topic(topic)
    canonical = []
    for cand in (topic.strip(), sot_title(base), base):
        if cand and cand not in canonical:
            canonical.append(cand)

    def fetch(cands):
        seen_ids = set()
        found = []
        for cand in cands:
            for point in _scroll_by_title(cand, namespace, limit=1000):
                payload = point["payload"]
                if agent and payload.get("agent") != agent:
                    continue
                if point["id"] in seen_ids:
                    continue
                seen_ids.add(point["id"])
                found.append(payload)
        return found

    chunks = fetch(canonical)
    if not chunks:
        chunks = fetch([sot_title(base) + SOT_SUFFIX])  # pre-retitle chain only
    matched_title = next((c.get("title") for c in chunks if c.get("title")), None)

    chunks.sort(key=lambda x: (x.get("chunk_index", 0), x.get("created_at") or ""))
    return {"topic": base, "title": matched_title or sot_title(base),
            "namespace": namespace, "agent": agent, "chunks": len(chunks),
            "results": chunks}


class _Txn:
    """Best-effort single transaction on the shared autocommit connection.

    psycopg2 autocommit connections accept no BEGIN from psycopg2 itself, so the
    block flips autocommit off and commits on exit (rollback on error). Fakes or
    drivers without commit()/autocommit run the same statements bare — the
    chunk_total sync still executes, just without the atomicity guarantee.
    """

    def __init__(self, conn):
        self.conn = conn
        self.managed = hasattr(conn, "commit")

    def __enter__(self):
        if self.managed:
            try:
                self.conn.autocommit = False
            except Exception:
                self.managed = False
        return self

    def _mark_broken(self):
        """Drop the connection from the shared cache and close it, so the next
        _get_conn() reconnects fresh instead of reusing an unsafe one."""
        for key, cached in list(_conns.items()):
            if cached is self.conn:
                _conns[key] = None
        try:
            self.conn.close()
        except Exception:
            pass

    def _restore_autocommit(self):
        """Flip the shared connection back to autocommit after commit/rollback.

        A driver may refuse the flip while the transaction is aborted: roll
        back once more and retry. If it still refuses, the connection can
        never be reused safely -> mark it broken (forces reconnect).
        """
        try:
            self.conn.autocommit = True
            return
        except Exception:
            pass
        try:
            self.conn.rollback()
        except Exception:
            pass
        try:
            self.conn.autocommit = True
        except Exception:
            self._mark_broken()

    def __exit__(self, exc_type, exc, tb):
        if self.managed:
            if exc_type is None:
                try:
                    self.conn.commit()
                except Exception:
                    try:
                        self.conn.rollback()
                    except Exception:
                        pass
                    raise
                finally:
                    self._restore_autocommit()
            else:
                try:
                    self.conn.rollback()
                finally:
                    self._restore_autocommit()
        return False


def append_to_topic(topic, new_content, namespace="knowledge", agent="system",
                    tags=None, importance=9):
    """Find existing SOT entry by topic name, append new content incrementally.

    Instead of re-embedding all chunks (O(n)), this only embeds the new content
    and appends it as new chunks. Existing chunks and their vectors are preserved.
    """
    from datetime import datetime, timezone
    topic, _topic_kinds = scrub(topic)  # the stored title must never carry a secret
    topic = normalize_topic(topic)
    title = sot_title(topic)
    tags = tags or []
    new_content, scrub_kinds = scrub(new_content)

    existing_chunks = _scroll_by_title(title, namespace)
    if not existing_chunks:
        # legacy doubled-suffix rows (pre-2026-10): adopt that chain rather than
        # splitting the topic into a second title; WO-2 retitles the rows
        legacy = _scroll_by_title(title + SOT_SUFFIX, namespace)
        if legacy:
            existing_chunks = legacy
            title = title + SOT_SUFFIX

    if not existing_chunks:
        search_result = search(query=f"{topic} SINGLE SOURCE OF TRUTH", limit=10)
        best_chunks = []
        best_title = None
        best_ns = None
        for r in search_result.get("results", []):
            ptitle = r.get("title", "")
            if "SINGLE SOURCE OF TRUTH" in ptitle and topic.upper() in ptitle.upper():
                other_ns = r.get("namespace")
                candidates = [ptitle]
                stripped = ptitle
                while stripped.count("SINGLE SOURCE OF TRUTH") > 1:
                    stripped = stripped.rsplit(" — SINGLE SOURCE OF TRUTH", 1)[0]
                    candidates.append(stripped)
                for cand in candidates:
                    chunks = _scroll_by_title(cand, other_ns)
                    if chunks and len(chunks) > len(best_chunks):
                        best_chunks = chunks
                        best_title = cand
                        best_ns = other_ns
                        break
        if best_chunks:
            existing_chunks = best_chunks
            title = existing_chunks[0]["payload"].get("title", best_title)
            namespace = best_ns

    if existing_chunks:
        existing_chunks.sort(key=lambda x: x["payload"].get("chunk_index", 0))
        last_index = max(c["payload"].get("chunk_index", 0) for c in existing_chunks)
        existing_tags = existing_chunks[0]["payload"].get("tags", [])
        existing_importance = existing_chunks[0]["payload"].get("importance", importance)

        merged_tags = list(set(tags + existing_tags))
        merged_importance = max(existing_importance, importance)

        ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        new_text = f"\n\n---\n## UPDATE {ts} (agent={agent})\n{new_content}"

        new_chunks_list = chunk_text(new_text)
        if not new_chunks_list:
            new_chunks_list = [new_text]

        new_chunk_texts = [f"{title}\n\n{c}" for c in new_chunks_list]
        new_vectors = embed_batch(new_chunk_texts)

        now = datetime.now(timezone.utc).isoformat()
        conn = _get_conn()
        cur = conn.cursor()
        total = last_index + 1 + len(new_chunks_list)
        inserted = 0
        first_id = None
        with _Txn(conn):  # inserts + chunk_total sync commit (or roll back) together
            for i, (chunk, vector) in enumerate(zip(new_chunks_list, new_vectors)):
                if vector is None:
                    continue
                idx = last_index + 1 + i
                point_id = _make_id(namespace, f"{title}_chunk_{idx}", agent)
                if first_id is None:
                    first_id = point_id
                cur.execute(
                    """INSERT INTO memory_entries
                       (id, namespace, agent, title, content, content_preview, tags, importance,
                        source, created_at, updated_at, metadata, chunk_index, chunk_total, embedding)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::vector)
                       ON CONFLICT (id) DO UPDATE SET
                         namespace=EXCLUDED.namespace, agent=EXCLUDED.agent, title=EXCLUDED.title,
                         content=EXCLUDED.content, content_preview=EXCLUDED.content_preview,
                         tags=EXCLUDED.tags, importance=EXCLUDED.importance, source=EXCLUDED.source,
                         updated_at=EXCLUDED.updated_at, metadata=EXCLUDED.metadata,
                         chunk_index=EXCLUDED.chunk_index, chunk_total=EXCLUDED.chunk_total,
                         embedding=EXCLUDED.embedding""",
                    (point_id, namespace, agent, title, chunk, chunk[:200], merged_tags,
                     merged_importance, "append", now, now,
                     PGJson({"scrubbed": scrub_kinds} if scrub_kinds else {}), idx, total,
                     _vec_to_pg(vector))
                )
                inserted += 1

            # keep chunk_total truthful on EVERY row of the title: the real row
            # count (COUNT over the title inside the same transaction), never the
            # chunk_index arithmetic — index gaps left stale totals behind (qa
            # saw chunk_total=36 over 42 rows)
            cur.execute(
                "SELECT COUNT(*) FROM memory_entries WHERE title = %s AND namespace = %s",
                (title, namespace))
            row = cur.fetchone()
            real_total = (row[0] if row and row[0] is not None else None) or total
            cur.execute(
                "UPDATE memory_entries SET chunk_total = %s WHERE title = %s AND namespace = %s",
                (real_total, title, namespace)
            )

        cur.close()
        return {"action": "updated", "id": first_id,
                "chunks": inserted, "topic": topic, "title": title}
    else:
        result = store(
            namespace=namespace, agent=agent, title=title,
            content=new_content, tags=tags, importance=importance
        )
        return {"action": "created", "id": result.get("id"), "chunks": result.get("chunks"),
                "topic": topic, "title": title}
