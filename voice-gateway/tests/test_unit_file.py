"""F9/F10 (2026-10-07): the unit runs uvicorn through the venv's python (no
shebang dependency), stops restart storms and drops uvicorn access lines."""
from pathlib import Path

UNIT = (Path(__file__).resolve().parents[2] / "systemd" / "voice-gateway.service").read_text(encoding="utf-8")


def test_unit_runs_python_module_without_access_log():
    exec_line = next(line for line in UNIT.splitlines() if line.startswith("ExecStart="))
    assert "/.venv/bin/python -m uvicorn app:app" in exec_line
    assert "--no-access-log" in exec_line
    assert "--workers 1" in exec_line and "--host 127.0.0.1" in exec_line


def test_unit_limits_restart_storms_and_keeps_hardening():
    unit_section = UNIT.split("[Service]")[0]
    assert "StartLimitIntervalSec=" in unit_section and "StartLimitBurst=5" in unit_section
    for directive in ("NoNewPrivileges=true", "ProtectSystem=strict", "LoadCredential=gemini_key:"):
        assert directive in UNIT
