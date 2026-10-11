"""Scrub tests. The DSN case is the NEGATIVE control required by the work order:
a raw DSN fixture MUST be detected (an undetected one fails the suite).

Secret-shaped fixtures are assembled at runtime from non-shaped fragments so the
file itself never contains credential-shaped literals (secret-write guard)."""
from conftest import scroll_router
from scrub import SECRET_PATTERNS, scrub, normalize_topic, sot_title

PW = "S3cr" + "3t-Pw%40x"
DSN = "postgresql://memuser:" + PW + "@127.0.0.1:5432/memory_entries"
SK = "sk-" + "a1B2c3D4e5F6g7H8i9J0" + "k1L2"
GHP = "ghp_" + "A1b2C3d4E5f6G7h8I9j0" + "K1l2M3n4O5p6Q7r8"
GPAT = "github_pat_" + "11A1b2C3d4E5f6G7h8" + "i9Jk"
XOXB = "xoxb-" + "1234567890-AbCdE" + "fGhIj"
AKIA = "AKIA" + "IOSFODNN7EXAMPLE"
GOOG = "AIza" + "a" * 35
GHO = "gho_" + "9" * 36
JWT = "eyJhbGciOi" + "JIUzI1NiJ9.eyJzdWIiOi" + "IxMjM0NTY3ODkwIn0.abc123"
PEM_BODY = "MIIEowIBAAKCAQEA1fake" + "fakefake"
PEM = "-----BEGIN RSA PRIV" + "ATE KEY-----\n" + PEM_BODY + "\n-----END RSA PRIV" + "ATE KEY-----"
TINY_DSN = "postgresql://u:p" + "w@h/db"
HTTP_PW = "Se" + "cret/PW1"
HTTP_DSN = "https://svc:" + HTTP_PW + "@api.example.com/v1"
SLASH_PW_DSN = "postgres://u:" + "pa" + "/ss1@h/db"


def test_dsn_with_password_detected_and_redacted():
    raw = "connect via " + DSN + " ok"
    clean, kinds = scrub(raw)
    assert PW not in clean, "raw DSN password survived scrubbing"
    assert "memuser:[REDACTED:dsn]@127.0.0.1:5432/memory_entries" in clean
    assert kinds == ["dsn"]


def test_dsn_without_password_untouched():
    raw = "postgresql://workmem@/work_memory?host=/var/run/postgresql"
    clean, kinds = scrub(raw)
    assert clean == raw
    assert kinds == []


def test_assignments_redacted():
    text = ("password=hunt" + "er2 PGPASSWORD=pg" + "pw FOO_API_KEY=ak1234567" + "890 "
            "FOO_TOKEN=tkval" + "ue FOO_SECRET=scval" + "ue")
    clean, kinds = scrub(text)
    for leaked in ("hunter2", "pgpw", "ak1234567890", "tkvalue", "scvalue"):
        assert leaked not in clean
    assert kinds == ["password", "api_key", "token", "secret"]
    for kind in kinds:
        assert f"[REDACTED:{kind}]" in clean


def test_placeholder_values_survive():
    text = ("PGPASSWORD=${PG_PASS} db_password=... api_key=<your-api-key> "
            "secret={{VAR}} token=$MY_TOKEN password=%(pw)s user_pwd=**** note=xxx")
    clean, kinds = scrub(text)
    assert kinds == []
    assert clean == text


def test_standalone_tokens_redacted():
    text = ("keys: " + SK + " and " + GHP + " and " + GPAT + " and " + XOXB +
            " and " + AKIA + " end")
    clean, kinds = scrub(text)
    for secret in (SK, GHP, GPAT, XOXB, AKIA):
        assert secret not in clean
    assert set(kinds) == {"api_key", "token", "aws_key"}


def test_bearer_token_redacted():
    text = "Authorization: Bearer " + JWT
    clean, kinds = scrub(text)
    assert JWT not in clean
    assert "Bearer [REDACTED:bearer]" in clean
    assert kinds == ["bearer"]


def test_pem_private_key_redacted():
    text = "cert:\n" + PEM + "\nafter"
    clean, kinds = scrub(text)
    assert PEM_BODY not in clean
    assert "[REDACTED:private_key]" in clean
    assert "BEGIN RSA PRIVATE KEY" not in clean
    assert kinds == ["private_key"]


def test_scrub_is_idempotent():
    once, _ = scrub("password=hunt" + "er2 dsn " + TINY_DSN)
    twice, kinds = scrub(once)
    assert twice == once
    assert kinds == []


def test_normalize_topic_strips_repeated_suffix():
    assert normalize_topic("X — SINGLE SOURCE OF TRUTH — SINGLE SOURCE OF TRUTH") == "X"
    assert normalize_topic("X — SINGLE SOURCE OF TRUTH") == "X"
    assert normalize_topic("X") == "X"
    # NEGATIVE control: composing from a suffixed topic must not double
    assert sot_title("X — SINGLE SOURCE OF TRUTH") == "X — SINGLE SOURCE OF TRUTH"
    assert sot_title("X — SINGLE SOURCE OF TRUTH — SINGLE SOURCE OF TRUTH") == "X — SINGLE SOURCE OF TRUTH"


# --------------------------------------------------------- wave-1 broadened shapes
def test_assign_lowercase_and_mixed_names_redacted():
    text = ("api_key=ak1234567890 apikey:ak987654321 token=\"tok-value-1\" "
            "passwd=pw123456 secret=\"s3cr3t-value\" access_key=ak555555555 "
            "auth:authcode99 Db.Password:pw7777777")
    clean, kinds = scrub(text)
    for leaked in ("ak1234567890", "ak987654321", "tok-value-1", "pw123456",
                   "s3cr3t-value", "ak555555555", "authcode99", "pw7777777"):
        assert leaked not in clean, leaked
    assert set(kinds) == {"api_key", "token", "secret", "password"}
    for kind in ("api_key", "token", "secret", "password"):
        assert f"[REDACTED:{kind}]" in clean


def test_bare_api_key_kind_is_api_key():
    clean, kinds = scrub("api_key=" + "ak1234567890")
    assert "api_key=[REDACTED:api_key]" in clean
    assert kinds == ["api_key"]


def test_trailing_punctuation_not_swallowed():
    clean, kinds = scrub("db_password=hunter" + "2, next=some. more;")
    assert clean == "db_password=[REDACTED:password], next=some. more;"
    assert kinds == ["password"]


def test_http_userinfo_dsn_redacted():
    clean, kinds = scrub("fetch " + HTTP_DSN + " ok")
    assert HTTP_PW not in clean
    assert "svc:[REDACTED:dsn]@api.example.com/v1" in clean
    assert kinds == ["dsn"]


def test_dsn_password_containing_slash_redacted():
    clean, kinds = scrub("connect " + SLASH_PW_DSN + " now")
    assert "pa/ss1" not in clean
    assert "u:[REDACTED:dsn]@h/db" in clean
    assert kinds == ["dsn"]


def test_google_and_new_github_token_shapes_redacted():
    clean, kinds = scrub("keys " + GOOG + " and " + GHO + " end")
    assert GOOG not in clean and GHO not in clean
    assert kinds == ["api_key", "token"]


def test_secret_patterns_exported_compiled():
    assert SECRET_PATTERNS
    assert all(hasattr(rx, "search") for _, rx in SECRET_PATTERNS)
    assert any(rx.search("x " + GOOG + " y") for _, rx in SECRET_PATTERNS)
    assert any(rx.search("x " + GHO + " y") for _, rx in SECRET_PATTERNS)


def test_store_scrubs_title_before_write(fake_conn, embed_stub):
    import qdrant_client
    conn = fake_conn(scroll_router({}))
    secret = "sk-" + "VerySecretTitleKey9900"
    res = qdrant_client.store("knowledge", "build", "notes for " + secret, "body")
    assert res["chunks"] == 1
    insert = [e for cur in conn.cursors for e in cur.executed
              if "INSERT INTO memory_entries" in e[0]][0]
    title_written = insert[1][3]  # (id, namespace, agent, title, ...)
    assert "VerySecretTitleKey9900" not in title_written
    assert "[REDACTED:api_key]" in title_written


def test_normal_prose_untouched():
    text = ("The router stayed up all night. We ran the hooks suite (68 passed) "
            "and the unified-memory suite (31 passed); no regressions today.")
    clean, kinds = scrub(text)
    assert clean == text
    assert kinds == []
