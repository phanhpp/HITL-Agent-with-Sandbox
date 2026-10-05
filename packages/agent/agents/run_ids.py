"""Records which LangSmith run produced which answer, so the UI can rate it.

A thumbs up/down has to name a run. The run id lives in the tracing context, which
exists only *inside* the graph — not in `http_app.py` (a route runs outside any run) and
not in the browser. So the agent writes it down as the turn ends.

It goes into GRAPH STATE rather than a stream event, for two reasons:

  - It survives reload and reopening an old thread. Held in the browser, the ids vanish
    on refresh and older messages are left with a thumbs control that has nothing to
    send. In state they are checkpointed with the thread and come back with the
    messages.
  - It pairs the vote with the right run when one turn spans several. The run that
    pauses for approval never finishes; the resumed run produces the answer. Recording
    the pair at END means the vote lands on the run that actually wrote the text being
    rated, instead of whichever run the browser guessed from ordering.

Registered on the OUTER graph of each agent only. `scribe` and `coder` are
CompiledSubAgents — separate compiled graphs, used as provided, with their own state —
so they cannot write here, and neither can the non-fork dict subagents.
"""

import operator
from typing import Annotated, Any

# typing_extensions, not typing: pydantic builds a schema from these and refuses
# `typing.TypedDict` on Python < 3.12. langgraph.json targets 3.12, but the local venv
# is 3.11, so this is the portable choice and it is what langchain itself uses.
from typing_extensions import TypedDict

from langchain.agents.middleware import AgentState, after_agent
from langchain_core.messages import AIMessage
from langsmith.run_helpers import get_current_run_tree


class AnswerRun(TypedDict):
    """One answer and the run that produced it."""

    message_id: str
    run_id: str


class AnswerRunState(AgentState):
    """Adds the run log to whatever state the agent already has.

    `operator.add` so each turn appends. The agent's own base state is merged last and
    wins any field conflict, so extending `AgentState` here is also safe for the deep
    agent, whose base is `DeepAgentState`.
    """

    answer_runs: Annotated[list[AnswerRun], operator.add]


def _answer_message_id(messages: list) -> str | None:
    """The id of the message the user would be rating: the last AI message with text.

    Scans backwards because the final message can be a tool result. A message carrying
    only tool calls is skipped — there is no answer there to judge yet.
    """
    for message in reversed(messages):
        if isinstance(message, AIMessage) and message.text and message.id:
            return message.id
    return None


@after_agent(state_schema=AnswerRunState, name="RecordRunIdMiddleware")
async def record_run_id(state: AnswerRunState, runtime) -> dict[str, Any] | None:
    """Pair the finished run with the answer it produced.

    `after_agent` runs once per invocation, at the graph's END node — unlike
    `after_model`, which would fire on every model call and record the same turn several
    times.

    Async on purpose. The run tree is a contextvar, so the hook has to run in the same
    task as the run; a sync hook handed to a worker thread is not guaranteed to see it.
    """
    run_tree = get_current_run_tree()
    if run_tree is None:
        # Tracing is off. There is no run to attach feedback to, so record nothing and
        # let the chat carry on exactly as before.
        return None

    message_id = _answer_message_id(state["messages"])
    if message_id is None:
        return None

    # `trace_id`, NOT `run_tree.id`. Inside this hook the current run is the hook's own
    # child span — LangSmith names it "RecordRunIdMiddleware.after_agent" — so rating
    # `run_tree.id` would attach every vote to a middleware node instead of the answer.
    # `trace_id` is the root run of the turn (verified: parent_run_id is None, named
    # after the graph), which is what "rate this answer" means.
    return {
        "answer_runs": [
            {
                "message_id": message_id,
                "run_id": str(run_tree.trace_id),
            }
        ]
    }
