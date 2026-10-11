"""Stub worker used through Engine(worker_entry=...).

Exercises the parent-side machinery (spawn, timeout, kill, respawn, error
mapping) without loading the GLiNER checkpoints.
"""

import os
import time

LABEL_POOL = {"alpha", "beta", "gamma"}


def _decide(conn, msg):
    if msg.get("long"):
        # Emulate chunk aggregation: the chunk carrying the marker wins.
        text = msg["text"]
        chosen = "gamma" if text.rstrip().endswith("gamma gamma gamma") else "alpha"
        probs = {name: 0.0 for name in LABEL_POOL}
        probs[chosen] = 0.9
        probs["beta"] = 0.1
        heads = {}
        for head_name, head in msg["heads"].items():
            heads[head_name] = {"label": chosen, "conf": 0.9, "margin": 0.8,
                                "abstain": False, "reason": "selected"}
        return heads
    heads = {}
    for head_name, head in msg["heads"].items():
        heads[head_name] = {"label": "alpha", "conf": 0.9, "margin": 0.8,
                            "abstain": False, "reason": "selected"}
    return heads


def run(conn, config):
    """Child entrypoint resolved from Engine(worker_entry="stub_worker:run")."""
    conn.send({"ready": True, "pid": os.getpid()})
    while True:
        try:
            msg = conn.recv()
        except (EOFError, KeyboardInterrupt):
            break
        if not isinstance(msg, dict):
            continue
        op = msg.get("op")
        if op == "wedge":
            time.sleep(float(msg.get("seconds", 30)))
            continue
        if config.get("fail"):
            conn.send({"ok": False, "error": "stub failure"})
            continue
        if op == "decide":
            conn.send({"ok": True, "result": _decide(conn, msg)})
        elif op == "pii":
            conn.send({"ok": True, "result": []})
        elif op == "injection":
            conn.send({"ok": True, "result": {"label": "benign", "conf": 0.9}})
        elif op == "health":
            conn.send({"ok": True, "result": {"models_loaded": True,
                                              "pid": os.getpid()}})
        else:
            conn.send({"ok": False, "error": f"unknown op {op!r}"})
    try:
        conn.close()
    except Exception:
        pass
