"""opencode-mac profile (rules/profiles.yaml, owner ruling 2026-10-05): the work MacBook's OpenCode gets
safety + work-memory recall only, and the server's own OpenCode keeps its full rule set."""
import json

import pytest

import decisions  # noqa: E402
import policy  # noqa: E402

MAC, SRV = policy.OPENCODE_MAC, policy.OPENCODE


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    monkeypatch.setattr(decisions, "log", lambda *a, **k: True)
    monkeypatch.setattr(decisions, "log_error", lambda *a, **k: True)


@pytest.fixture
def memory_calls(monkeypatch):
    calls = []

    def spy(query, limit, db=None):
        calls.append(db)
        return [{"title": "T", "content": "work note about checkout service"}]
    monkeypatch.setattr(policy, "_memory_search", spy)
    return calls


def ev(agent, event, payload):
    return policy.evaluate(agent, event, payload, None)


def bash(command):
    return {"tool": "bash", "args": {"command": command}}


@pytest.mark.parametrize("command", ["rm -rf ~", "rm -rf ~/Bazaarvoice", "rm -rf ${HOME}/Bazaarvoice",
                                     "git push --force origin main", "psql -c 'DROP TABLE x'", "sleep 30"])
def test_mac_denies(command):
    assert ev(MAC, "tool.execute.before", bash(command)).get("action") == "deny"


@pytest.mark.parametrize("command", ["git commit -m x", "rm -rf ${AI_SETUP_ROOT}/x", "systemctl restart nginx",
                                     "rm -rf ./build", "rm -rf ~/Bazaarvoice/repo/dist", "ls"])
def test_mac_allows_homelab_only_rules(command):
    assert ev(MAC, "tool.execute.before", bash(command)) == {"action": "allow"}


def test_server_opencode_rules_unchanged():
    assert ev(SRV, "tool.execute.before", bash("git commit -m x")).get("action") == "deny"
    assert ev(SRV, "tool.execute.before", bash("rm -rf ~")) == {"action": "allow"}


def test_mac_d7_matches_server():
    write = {"tool": "write", "args": {"filePath": "/Users/o/x/.env", "content": "A=1"}}
    out = ev(MAC, "tool.execute.before", write)
    assert out.get("action") == "deny" and out == ev(SRV, "tool.execute.before", write)


def test_mac_has_no_d4_or_d17():
    task = {"tool": "task", "args": {"prompt": "do stuff", "subagent_type": "code-reviewer"}}
    assert ev(MAC, "tool.execute.before", task) == {"action": "allow"}
    assert ev(SRV, "tool.execute.before", task).get("action") == "deny"
    read = {"tool": "read", "args": {"filePath": policy.__file__}}
    assert ev(MAC, "tool.execute.before", read) == {"action": "allow"}


def test_mac_recall_reads_work_memory_only(memory_calls):
    out = ev(MAC, "chat.message", {"sessionID": "s1", "prompt": "how does the checkout service retry payments?"})
    assert memory_calls == ["work_memory"] and "Relevant memory" in json.dumps(out)
    memory_calls.clear()
    ev(MAC, "chat.message", {"sessionID": "s2", "prompt": "<system-reminder> x"})
    assert memory_calls == []
    ev(SRV, "chat.message", {"sessionID": "s3", "prompt": "restart the caddy docker container on the host"})
    assert "work_memory" not in memory_calls


def test_d10_recite_mac_template_only_server_with_state_files(tmp_path):
    note = tmp_path / "progress-note.md"
    note.write_text("step 1: plan written\nstep 2: next\n", encoding="utf-8")
    plan = str(note)
    payload = {"sessionID": "c1", "context": ["working on " + plan + " step 3"]}
    mac = ev(MAC, "experimental.session.compacting", payload).get("context", "")
    assert "COMPACTION INSTRUCTIONS" in mac and plan not in mac and "tail of" not in mac
    srv = ev(SRV, "experimental.session.compacting", payload)
    assert srv.get("action") == "allow" and ("tail of " + plan) in srv.get("context", "")


def test_mac_unknown_event_is_noop():
    assert ev(MAC, "session.idle", {}) == {"action": "allow"}
