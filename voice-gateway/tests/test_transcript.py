"""Call transcripts (owner ruling 2026-10-07): /voice/transcript appends JSONL."""
import json
import os
import stat

import app as vg

CALL = "c-20261007-abcdef12"


def _post(client, call, body):
    return client.post(f"/voice/transcript?call={call}", content=json.dumps(body))


def test_appends_jsonl_per_call_owner_only(client, monkeypatch, tmp_path):
    monkeypatch.setattr(vg, "TRANSCRIPT_DIR", tmp_path)
    r = _post(client, CALL, {"entries": [
        {"t": 1, "role": "owner", "text": "قول لكلود يشغل التستات"},
        {"t": 2, "role": "tool-call", "text": 'send_to_claude {"instruction":"(voice) run the tests"}'},
    ]})
    assert r.status_code == 200, r.text
    assert _post(client, CALL, {"entries": [{"t": 3, "role": "gemini", "text": "تمام، قلتله."}]}).status_code == 200
    files = list(tmp_path.glob(f"*/{CALL}.jsonl"))
    assert len(files) == 1  # second post appends to the same file
    rows = [json.loads(line) for line in files[0].read_text(encoding="utf-8").splitlines()]
    assert [row["role"] for row in rows] == ["owner", "tool-call", "gemini"]
    assert rows[0]["text"] == "قول لكلود يشغل التستات"
    assert stat.S_IMODE(os.stat(files[0]).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(files[0].parent).st_mode) == 0o700


def test_rejects_bad_input(client, monkeypatch, tmp_path):
    monkeypatch.setattr(vg, "TRANSCRIPT_DIR", tmp_path)
    assert _post(client, "../etc", {"entries": []}).status_code in (400, 422)
    assert _post(client, "short", {"entries": []}).status_code == 400
    assert _post(client, CALL, {"entries": [{"t": 1, "role": "system", "text": "x"}]}).status_code == 400
    assert _post(client, CALL, {"entries": [{"t": 1, "role": "owner", "text": 5}]}).status_code == 400
    assert client.post(f"/voice/transcript?call={CALL}", content=b"{not json").status_code == 400
    assert _post(client, CALL, {"entries": [{"t": 1, "role": "owner", "text": "x"}] * 501}).status_code == 400
    assert not list(tmp_path.rglob("*.jsonl"))  # nothing written on rejection


def test_text_capped_and_never_logged(client, monkeypatch, tmp_path, caplog):
    monkeypatch.setattr(vg, "TRANSCRIPT_DIR", tmp_path)
    secret_words = "SENTINEL-OWNER-WORDS"
    with caplog.at_level("INFO", logger="voice-gateway"):
        assert _post(client, CALL, {"entries": [{"t": 1, "role": "owner", "text": secret_words + "x" * 30000}]}).status_code == 200
    row = json.loads(next(tmp_path.glob(f"*/{CALL}.jsonl")).read_text(encoding="utf-8"))
    assert len(row["text"]) == vg.TRANSCRIPT_MAX_TEXT
    assert secret_words not in caplog.text


def test_prune_keeps_seven_days(monkeypatch, tmp_path):
    """Owner ruling 2026-10-07: transcripts are kept 7 days, older day folders go."""
    from datetime import date
    monkeypatch.setattr(vg, "TRANSCRIPT_DIR", tmp_path)
    for day in ("2026-09-29", "2026-09-30", "2026-10-01", "2026-10-07"):
        (tmp_path / day).mkdir(mode=0o700)
        (tmp_path / day / f"{CALL}.jsonl").write_text("{}\n", encoding="utf-8")
    (tmp_path / "notes").mkdir()  # not a day folder: never touched
    (tmp_path / "notes" / "keep.jsonl").write_text("{}\n", encoding="utf-8")
    removed = vg.prune_transcripts(today=date(2026, 10, 7))
    assert removed == 2
    assert sorted(p.name for p in tmp_path.iterdir()) == ["2026-10-01", "2026-10-07", "notes"]  # 10-01..10-07 = 7 days
    assert (tmp_path / "notes" / "keep.jsonl").exists()


def test_prune_missing_dir_is_harmless(monkeypatch, tmp_path):
    monkeypatch.setattr(vg, "TRANSCRIPT_DIR", tmp_path / "absent")
    assert vg.prune_transcripts() == 0


def test_prune_never_follows_a_symlinked_day_folder(monkeypatch, tmp_path):
    """Wave-1 security 2026-10-07: a YYYY-MM-DD symlink never leads the prune
    out of the transcript root; the transcript root itself always survives."""
    from datetime import date
    root = tmp_path / "transcripts"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "victim.jsonl").write_text("{}\n", encoding="utf-8")
    (root / "2026-09-01").symlink_to(outside, target_is_directory=True)
    (root / "2026-09-02").mkdir()
    (root / "2026-09-02" / f"{CALL}.jsonl").write_text("{}\n", encoding="utf-8")
    monkeypatch.setattr(vg, "TRANSCRIPT_DIR", root)
    assert vg.prune_transcripts(today=date(2026, 10, 7)) == 1
    assert (outside / "victim.jsonl").exists()
    assert root.is_dir() and [p.name for p in root.iterdir()] == ["2026-09-01"]
