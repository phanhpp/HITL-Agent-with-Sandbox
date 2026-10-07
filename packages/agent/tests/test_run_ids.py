"""The middleware that pairs each answer with the run that produced it.

The important test here is `test_records_the_trace_root_not_the_hooks_own_span`. That bug
shipped, returned 200, and showed a score in LangSmith — against a node called
`RecordRunIdMiddleware.after_agent` instead of the answer. Nothing failed; it was only
visible if you checked *which* run got the score.
"""

from types import SimpleNamespace
from uuid import UUID

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from agents import run_ids
from agents.run_ids import _answer_message_id, record_run_id

ROOT = UUID("11111111-1111-1111-1111-111111111111")
HOOK_SPAN = UUID("22222222-2222-2222-2222-222222222222")


def fake_run_tree(id_=HOOK_SPAN, trace_id=ROOT):
    """Mimics what `get_current_run_tree()` returns INSIDE an after_agent hook.

    `id` is the hook's own child span and `trace_id` is the turn. They differ, which is
    the whole point — the two are equal only for a root run, and a hook is never one.
    """
    return SimpleNamespace(id=id_, trace_id=trace_id)


# --- _answer_message_id ------------------------------------------------------


def test_picks_the_last_ai_message_with_text():
    messages = [
        HumanMessage(content="hi", id="h1"),
        AIMessage(content="first", id="a1"),
        HumanMessage(content="again", id="h2"),
        AIMessage(content="second", id="a2"),
    ]
    assert _answer_message_id(messages) == "a2"


def test_skips_trailing_tool_messages():
    """The final message is often a tool result, which is not the answer."""
    messages = [
        AIMessage(content="here you go", id="a1"),
        ToolMessage(content="{}", id="t1", tool_call_id="c1"),
    ]
    assert _answer_message_id(messages) == "a1"


def test_ignores_an_ai_message_with_no_text():
    """A tool-call-only message carries no answer to rate."""
    assert _answer_message_id([AIMessage(content="", id="a1")]) is None


def test_empty_history_is_none():
    assert _answer_message_id([]) is None


# --- the hook ----------------------------------------------------------------


async def test_records_the_trace_root_not_the_hooks_own_span(monkeypatch):
    """REGRESSION. Recording `run_tree.id` files the vote against a middleware node."""
    monkeypatch.setattr(run_ids, "get_current_run_tree", fake_run_tree)

    update = await record_run_id.aafter_agent(
        {"messages": [AIMessage(content="Blue", id="a1")]}, None
    )

    assert update == {"answer_runs": [{"message_id": "a1", "run_id": str(ROOT)}]}
    assert str(HOOK_SPAN) not in str(update), "recorded the hook's own span"


async def test_records_nothing_when_tracing_is_off(monkeypatch):
    """`get_current_run_tree()` is None with tracing off. The chat must not break."""
    monkeypatch.setattr(run_ids, "get_current_run_tree", lambda: None)

    update = await record_run_id.aafter_agent(
        {"messages": [AIMessage(content="Blue", id="a1")]}, None
    )
    assert update is None


async def test_records_nothing_without_an_answer(monkeypatch):
    monkeypatch.setattr(run_ids, "get_current_run_tree", fake_run_tree)

    update = await record_run_id.aafter_agent({"messages": []}, None)
    assert update is None


@pytest.mark.parametrize("attr", ["state_schema", "aafter_agent"])
def test_decoration_produced_a_middleware(attr):
    """`@after_agent` turns the function into a middleware INSTANCE.

    Pinned because it is surprising: `record_run_id` is not callable, and the graph needs
    both the declared state schema and the async hook to exist.
    """
    assert hasattr(record_run_id, attr)


def test_state_schema_declares_the_key():
    assert "answer_runs" in run_ids.AnswerRunState.__annotations__
