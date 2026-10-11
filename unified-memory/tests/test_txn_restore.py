"""_Txn hardening: a failed commit/rollback must never leave the shared
connection outside autocommit or inside an open transaction, and the original
commit error must still reach the caller."""
import pytest

import qdrant_client


class OkConn:
    """Healthy driver: commit/rollback/autocommit all work."""

    def __init__(self):
        self.autocommit = True
        self.commits = 0
        self.rollbacks = 0
        self.closed = False

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closed = True


class CommitFailConn(OkConn):
    """commit() always fails; rollback + autocommit restore still work."""

    def commit(self):
        raise RuntimeError("commit failed")


class RefusingAutocommitConn(CommitFailConn):
    """Driver that refuses every autocommit=True flip (aborted-txn state)."""

    def __init__(self):
        self._autocommit = True
        self.commits = 0
        self.rollbacks = 0
        self.closed = False

    @property
    def autocommit(self):
        return self._autocommit

    @autocommit.setter
    def autocommit(self, value):
        if value:
            raise RuntimeError("autocommit refused while txn aborted")
        self._autocommit = value


def test_happy_path_commit_and_restore():
    conn = OkConn()
    with qdrant_client._Txn(conn):
        pass
    assert conn.commits == 1 and conn.rollbacks == 0
    assert conn.autocommit is True and conn.closed is False


def test_failed_commit_propagates_rolls_back_restores_autocommit():
    conn = CommitFailConn()
    with pytest.raises(RuntimeError, match="commit failed"):
        with qdrant_client._Txn(conn):
            pass
    assert conn.autocommit is True
    assert conn.rollbacks == 1
    assert conn.closed is False


def test_refused_autocommit_flip_marks_conn_for_reconnect(monkeypatch):
    conn = RefusingAutocommitConn()
    monkeypatch.setattr(qdrant_client, "_conns", {qdrant_client.PG_DSN: conn})
    with pytest.raises(RuntimeError, match="commit failed"):
        with qdrant_client._Txn(conn):
            pass
    assert conn.rollbacks == 2
    assert conn.closed is True
    assert qdrant_client._conns.get(qdrant_client.PG_DSN) is None


def test_body_error_rolls_back_restores_autocommit():
    conn = OkConn()
    with pytest.raises(ValueError, match="boom"):
        with qdrant_client._Txn(conn):
            raise ValueError("boom")
    assert conn.commits == 0 and conn.rollbacks == 1
    assert conn.autocommit is True and conn.closed is False


def test_fake_without_commit_runs_bare():
    class Bare:
        pass

    conn = Bare()
    with qdrant_client._Txn(conn):
        pass
    assert not hasattr(conn, "autocommit")
