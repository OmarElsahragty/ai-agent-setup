"""Pytest bootstrap: put the package dir on sys.path for engine/server/client."""

import os
import sys

PKG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTS_DIR = os.path.join(PKG_DIR, "tests")
for path in (PKG_DIR, TESTS_DIR):
    if path not in sys.path:
        sys.path.insert(0, path)

# The routing tests must not pay the 1 GB model load; engine tests start their
# own Engine explicitly.  Set before any import of `server`.
os.environ.setdefault("LOCAL_DECIDE_EAGER_LOAD", "0")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


# Transcript allowlist (paths.py): pytest tmp dirs must count as a transcript root wherever TMPDIR points.
# paths.transcript_roots() ignores roots with fewer than 2 path components (e.g. "/tmp"),
# so each test's tmp_path is appended lazily by the autouse fixture below.
import tempfile as _tempfile  # noqa: E402
import pytest as _pytest  # noqa: E402
os.environ.setdefault("LOCAL_DECIDE_TRANSCRIPT_ROOTS", _tempfile.gettempdir())


@_pytest.fixture(autouse=True)
def _allow_tmp_transcripts(tmp_path, monkeypatch):
    """Allowlist this test's tmp_path (read fresh by paths.transcript_roots())."""
    current = os.environ.get("LOCAL_DECIDE_TRANSCRIPT_ROOTS", "")
    monkeypatch.setenv("LOCAL_DECIDE_TRANSCRIPT_ROOTS",
                       current + os.pathsep + str(tmp_path) if current else str(tmp_path))
    yield
