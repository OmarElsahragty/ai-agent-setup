"""Shared helpers for the hook unit tests: load hook modules by file path and run them end-to-end."""
import importlib.util
import json
import os
import subprocess
import sys

HOOKS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS_DIR = os.path.dirname(HOOKS_DIR)


def _resolve(file_name):
    for base in (HOOKS_DIR, SCRIPTS_DIR):
        candidate = os.path.join(base, file_name)
        if os.path.isfile(candidate):
            return candidate
    raise FileNotFoundError(file_name)

CONTINUATION_MARKER = "This session is being continued from a previous conversation"


def load_hook(file_name, unique_name=None):
    name = unique_name or file_name.replace("-", "_").replace(".py", "")
    spec = importlib.util.spec_from_file_location(name, _resolve(file_name))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def write_transcript(path, entries):
    with open(path, "w", encoding="utf-8") as fh:
        for entry in entries:
            fh.write(json.dumps(entry) + "\n")
    return str(path)


def compacted_transcript(path, n_markers):
    entries = []
    for _ in range(n_markers):
        entries.append({"type": "user", "message": {"role": "user", "content": CONTINUATION_MARKER + " ...summary..."}})
    entries.append({"type": "user", "message": {"role": "user", "content": "continue the work"}})
    return write_transcript(path, entries)


def run_hook(file_name, payload, timeout=10):
    proc = subprocess.run(
        [sys.executable, os.path.join(HOOKS_DIR, file_name)],
        input=json.dumps(payload).encode("utf-8"),
        capture_output=True,
        timeout=timeout,
    )
    return proc.returncode, proc.stdout.decode("utf-8", "replace"), proc.stderr.decode("utf-8", "replace")
