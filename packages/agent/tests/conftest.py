"""Shared fixtures.

Everything here runs offline. No test in this suite may reach the network, construct a
real client, create a sandbox or call a model — `http_app` imports clean with no API key,
and these tests rely on that staying true.
"""

import pytest
from starlette.testclient import TestClient

import http_app
from routes import feedback, sandbox_files


@pytest.fixture(autouse=True)
def _reset_module_globals():
    """Clear the cached clients between tests.

    `feedback._project_id` is the dangerous one: it is a process-lifetime cache, so once
    any test sets it no later test performs the lookup, and a test that passes alone can
    fail in a suite (or worse, pass for the wrong reason).
    """
    sandbox_files._client = None
    feedback._feedback_client = None
    feedback._project_id = None
    yield
    sandbox_files._client = None
    feedback._feedback_client = None
    feedback._project_id = None


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    """Make any accidental network call fail loudly instead of quietly going out.

    Without this a test that slips past a validation branch builds a real client and
    makes a real request — which is slow, needs a key, and silently tests nothing. It
    caught exactly that while this suite was being written.
    """

    def forbidden(*_args, **_kwargs):
        raise AssertionError("test attempted network access")

    monkeypatch.setattr(sandbox_files, "_get_client", forbidden)
    monkeypatch.setattr(feedback, "_get_feedback_client", forbidden)


@pytest.fixture
def client() -> TestClient:
    """The real Starlette app, exercised over HTTP.

    Note this does NOT reproduce the BlockingError that `langgraph dev` raises for a sync
    call inside an async handler — `blockbuster` ships with langgraph-api, not with the
    test path. See the `_backend` docstring. These tests are not a substitute for running
    the dev server.
    """
    return TestClient(http_app.app)


class FakeBackend:
    """Minimal stand-in for a sandbox backend.

    `_changed_files`, `_git` and `_tree_entries` each touch exactly one method and read
    `.output`, so a parser test needs nothing more than this.
    """

    def __init__(self, output: str = ""):
        self.output = output
        self.commands: list[str] = []

    def execute(self, command: str) -> "FakeBackend":
        self.commands.append(command)
        return self

    async def aexecute(self, command: str) -> "FakeBackend":
        self.commands.append(command)
        return self
