"""Every route branch that answers without touching the network.

These go through the real Starlette app over HTTP, so they cover the wiring too — path
params, methods, status codes and response shapes — not just the functions underneath.
"""

import pytest

from routes.feedback import _valid_uuid
from routes.sandbox_files import WORKDIR

GOOD_UUID = "01a10a25-2852-77e0-a154-5c60f4da4f65"
THREAD = "thread-1"


# --- the app's shape ---------------------------------------------------------


def test_app_exposes_exactly_the_expected_routes():
    """`langgraph.json` mounts ONE app, so this is the whole custom surface."""
    import http_app

    mounted = {(r.path, tuple(sorted(r.methods - {"HEAD"}))) for r in http_app.app.routes}
    assert mounted == {
        (f"/sandbox/{{thread_id}}/tree", ("GET",)),
        (f"/sandbox/{{thread_id}}/file", ("GET",)),
        (f"/sandbox/{{thread_id}}/changes", ("GET",)),
        (f"/sandbox/{{thread_id}}/baseline", ("POST",)),
        ("/feedback/{thread_id}", ("POST",)),
        ("/feedback/{thread_id}/votes", ("GET",)),
    }


# --- containment, rejected before any sandbox call ---------------------------


@pytest.mark.parametrize("route", ["tree", "file"])
@pytest.mark.parametrize(
    "bad_path",
    ["/etc/passwd", f"{WORKDIR}/../etc/passwd", "relative/path", f"{WORKDIR}/../.."],
)
def test_path_outside_the_workspace_is_rejected(client, route, bad_path):
    res = client.get(f"/sandbox/{THREAD}/{route}", params={"filePath": bad_path})
    assert res.status_code == 400
    assert res.json() == {"error": "filePath outside the workspace"}


def test_empty_filepath_means_the_workspace_root_for_tree_but_not_file(client):
    """A deliberate asymmetry, so it is pinned rather than rediscovered.

    `tree` defaults a missing filePath to WORKDIR — browsing the root is the normal
    case. `file` has no sensible default, so an empty path is rejected.
    """
    assert client.get(f"/sandbox/{THREAD}/file", params={"filePath": ""}).status_code == 400
    # tree accepts it; it reaches the sandbox lookup, which the guard below blocks.
    with pytest.raises(AssertionError, match="network"):
        client.get(f"/sandbox/{THREAD}/tree", params={"filePath": ""})


def test_rejection_happens_without_constructing_a_client(client):
    """The 400 must come back before anything reaches for the sandbox API.

    If this starts failing, a GET is doing work — which is also how you get the
    "anyone can spend money by guessing thread ids" problem.
    """
    from routes import sandbox_files

    client.get(f"/sandbox/{THREAD}/tree", params={"filePath": "/etc/passwd"})
    assert sandbox_files._client is None


# --- POST /feedback validation -----------------------------------------------


def test_rejects_a_non_json_body(client):
    res = client.post(
        f"/feedback/{THREAD}", content="nonsense", headers={"content-type": "application/json"}
    )
    assert res.status_code == 400
    assert res.json() == {"error": "expected a JSON body"}


def test_rejects_json_that_is_not_an_object(client):
    res = client.post(f"/feedback/{THREAD}", json=["a", "list"])
    assert res.status_code == 400
    assert res.json() == {"error": "expected a JSON object"}


@pytest.mark.parametrize("run_id", ["not-a-uuid", "", None, 12345, GOOD_UUID[:-1]])
def test_rejects_a_bad_run_id(client, run_id):
    res = client.post(f"/feedback/{THREAD}", json={"run_id": run_id, "score": 1})
    assert res.status_code == 400
    assert res.json() == {"error": "run_id must be a UUID"}


@pytest.mark.parametrize("score", [5, -1, 0.5, "1", None, [1]])
def test_rejects_a_score_that_is_not_zero_or_one(client, score):
    res = client.post(f"/feedback/{THREAD}", json={"run_id": GOOD_UUID, "score": score})
    assert res.status_code == 400
    assert res.json() == {"error": "score must be 0 or 1"}


@pytest.mark.parametrize("score", [True, False])
def test_rejects_a_boolean_score(client, score):
    """`score in (0, 1)` is True for a bool, so the type check is load-bearing."""
    res = client.post(f"/feedback/{THREAD}", json={"run_id": GOOD_UUID, "score": score})
    assert res.status_code == 400
    assert res.json() == {"error": "score must be 0 or 1"}


def test_validation_runs_before_any_client_is_built(client):
    """A rejected vote must not construct a LangSmith client or resolve a project."""
    from routes import feedback

    client.post(f"/feedback/{THREAD}", json={"run_id": "bad", "score": 1})
    assert feedback._feedback_client is None
    assert feedback._project_id is None


# --- GET /votes --------------------------------------------------------------


@pytest.mark.parametrize("query", ["", "notauuid", "notauuid,alsobad", ",,,", "   "])
def test_votes_with_no_valid_ids_answers_empty_without_a_lookup(client, query):
    from routes import feedback

    res = client.get(f"/feedback/{THREAD}/votes", params={"run_ids": query})
    assert res.status_code == 200
    assert res.json() == {"votes": {}}
    assert feedback._feedback_client is None


def test_votes_requires_no_run_ids_param_at_all(client):
    res = client.get(f"/feedback/{THREAD}/votes")
    assert res.status_code == 200
    assert res.json() == {"votes": {}}


# --- _valid_uuid -------------------------------------------------------------


@pytest.mark.parametrize("value", ["not-a-uuid", "", None, 12345, [], {}, GOOD_UUID[:-1]])
def test_valid_uuid_rejects_junk(value):
    assert _valid_uuid(value) is None


def test_valid_uuid_echoes_a_real_uuid():
    assert _valid_uuid(GOOD_UUID) == GOOD_UUID
