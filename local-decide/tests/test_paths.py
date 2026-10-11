"""paths.py transcript-root allowlist: shallow roots are ignored (security E3).

A caller-supplied LOCAL_DECIDE_TRANSCRIPT_ROOTS of "/" (or any single-component
root like "/tmp") would turn the allowlist into "every .jsonl on the machine",
so transcript_roots() must drop it. Tests set the env var directly because
transcript_roots() reads it fresh on every call.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import paths  # noqa: E402


def test_root_slash_is_ignored(monkeypatch):
    monkeypatch.setenv("LOCAL_DECIDE_TRANSCRIPT_ROOTS", "/")
    roots = paths.transcript_roots()
    assert "/" not in roots
    assert paths.safe_transcript_path("/anywhere/evil.jsonl") is None


def test_single_component_root_is_ignored(monkeypatch):
    monkeypatch.setenv("LOCAL_DECIDE_TRANSCRIPT_ROOTS", "/storage")
    roots = paths.transcript_roots()
    assert "/storage" not in roots
    assert paths.safe_transcript_path("/srv/leak.jsonl") is None


def test_deep_extra_root_is_kept_and_enforced(tmp_path, monkeypatch):
    deep = tmp_path / "transcripts"
    deep.mkdir()
    target = deep / "session.jsonl"
    target.write_text("{}\n", encoding="utf-8")
    monkeypatch.setenv("LOCAL_DECIDE_TRANSCRIPT_ROOTS", str(deep))
    assert str(deep) in [os.path.realpath(r) for r in paths.transcript_roots()]
    assert paths.safe_transcript_path(str(target)) == os.path.realpath(str(target))


def test_default_roots_all_carry_at_least_two_components():
    for root in paths.DEFAULT_ROOTS:
        parts = [p for p in os.path.normpath(root).split(os.sep) if p]
        assert len(parts) >= 2, root
