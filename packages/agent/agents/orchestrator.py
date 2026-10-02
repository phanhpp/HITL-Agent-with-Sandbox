"""Deep agent for /orchestrate: plans, delegates, and synthesises.

A GRAPH FACTORY, not a module-level graph. LangGraph calls `agent(config)` once per
run, which is the only way to give the thread its own sandbox (phase 3): a module-level
graph is built once at import, so every thread would share one sandbox. The factory
shape is here from the start precisely because retrofitting it later means rewriting
the entry point and the deployment config.

Architecture (docs/deepagent-guide.md section 9):

    supervisor      Sonnet + thinking    StateBackend, TodoListMiddleware
    |- researcher   Haiku  + thinking    dict subagent, inherits the backend
    |- analyst      Haiku  + thinking    dict subagent, inherits the backend
    \\- coder       phase 3              CompiledSubAgent, its own sandbox backend

Two subagent forms because they do different jobs. A dict subagent can set its own
`model` but has no `backend` key, so the coder — the only one needing a shell — has to
be a CompiledSubAgent wrapping an agent built with its own backend.
"""

import os

from langchain.agents.middleware import TodoListMiddleware
from langchain.chat_models import init_chat_model
from langchain_core.runnables import RunnableConfig
from deepagents import CompiledSubAgent, create_deep_agent
from deepagents.backends import StateBackend

from agents.prompts import (
    ANALYST_PROMPT,
    CODER_PROMPT,
    RESEARCHER_PROMPT,
    SUPERVISOR_PROMPT,
)
from agents.sandbox import get_or_create_sandbox_for_thread

# Extended thinking is on for every model so the UI can render reasoning blocks.
#
# The two models take DIFFERENT thinking config, and each is spelled out rather than
# inferred from the model name: the real boundary ("pre-4.7" vs "4.6+" vs "4.7+") does
# not line up cleanly with any substring, so guessing it would silently misclassify the
# next model we add.
#
# Getting it wrong fails in two ways, one loud and one silent:
#   - classic form on an adaptive model -> hard 400, `"thinking.type.enabled" is not
#     supported for this model`
#   - adaptive without `display: "summarized"` -> the default is "omitted", so NO
#     reasoning blocks come back and the ThinkingBubble silently never appears
# Both confirmed by probe, as is the fact that all three configs below yield
# `contentBlocks` of `['reasoning', 'text']`.

# Overridable from the environment so a test run does not have to cost what a real one
# does. Set ORCHESTRATE_CODER_MODEL=anthropic:claude-haiku-4-5 to exercise the whole
# delegation path cheaply; the defaults are what the deployment uses.
SUPERVISOR_MODEL = os.getenv("ORCHESTRATE_SUPERVISOR_MODEL", "anthropic:claude-sonnet-5")
WORKER_MODEL = os.getenv("ORCHESTRATE_WORKER_MODEL", "anthropic:claude-haiku-4-5")
# The coder writes multi-file code and drives a shell, which Haiku struggles with.
# Sonnet rather than Opus because this runs behind a public link.
CODER_MODEL = os.getenv("ORCHESTRATE_CODER_MODEL", "anthropic:claude-sonnet-5")

# Thinking config is per MODEL FAMILY, not per role, so an override must not keep the
# role's original config. Sonnet 5 and Opus 4.7+ take the adaptive form; everything
# earlier takes a token budget and rejects `adaptive` with a hard 400.
_ADAPTIVE_THINKING = {"type": "adaptive", "display": "summarized"}
_BUDGET_THINKING = {"type": "enabled", "budget_tokens": 2000}


def _thinking_for(model: str) -> dict:
    """Pick the thinking config a model will actually accept."""
    return _BUDGET_THINKING if "haiku" in model else _ADAPTIVE_THINKING


def _supervisor_model():
    """Sonnet 5 by default: adaptive thinking, `summarized` to actually receive it."""
    return init_chat_model(
        SUPERVISOR_MODEL,
        thinking=_thinking_for(SUPERVISOR_MODEL),
        max_tokens=8000,
    )


def _worker_model():
    """Haiku 4.5 by default: budget thinking. `max_tokens` must exceed `budget_tokens`."""
    return init_chat_model(
        WORKER_MODEL,
        thinking=_thinking_for(WORKER_MODEL),
        max_tokens=8000,
    )


def _coder_model():
    """Sonnet 5 by default, with room for whole files."""
    return init_chat_model(
        CODER_MODEL,
        thinking=_thinking_for(CODER_MODEL),
        max_tokens=16000,
    )


def _subagent(name: str, description: str, system_prompt: str) -> dict:
    """A dict subagent. Inherits the supervisor's backend and its `interrupt_on`."""
    return {
        "name": name,
        "description": description,
        "system_prompt": system_prompt,
        "model": _worker_model(),
    }


async def agent(config: RunnableConfig):
    """Build the supervisor for one run. `config` carries the thread id."""
    configurable = config.get("configurable") or {}
    thread_id = configurable.get("thread_id")
    if not thread_id:
        raise RuntimeError("No thread_id available; this agent must run on a thread")

    subagents = [
        _subagent(
            "researcher",
            "Research one topic at a time. Give it a single, specific topic.",
            RESEARCHER_PROMPT,
        ),
        _subagent(
            "analyst",
            "Turn research findings into three ranked insights.",
            ANALYST_PROMPT,
        ),
    ]

    # A CompiledSubAgent, i.e. a separate compiled graph rather than a dict. It carries
    # its OWN interrupt_on, which a dict subagent cannot. In phase 3 this becomes the
    # sandbox-backed coder; for now it shares the supervisor's StateBackend so the
    # nested-interrupt path can be exercised without a sandbox.
    scribe = create_deep_agent(
        model=_worker_model(),
        system_prompt=(
            "You write files. When asked to save something, call write_file immediately "
            "with the exact path you were given. Do not ask questions."
        ),
        # On the inner agent, NOT on CompiledSubAgent: that TypedDict is only
        # {name, description, runnable, mode}, so an interrupt_on passed there is
        # silently ignored.
        interrupt_on={"write_file": True, "edit_file": True},
    )
    subagents.append(
        CompiledSubAgent(
            name="scribe",
            description="Saves text to a file. Give it the exact path and the content.",
            runnable=scribe,
        )
    )

    # The coder: the only subagent with a real machine, and the only one that can run
    # a shell command. It is a CompiledSubAgent because a dict subagent has no
    # `backend` key — a different model can be set on a dict, a different filesystem
    # cannot.
    #
    # Creating the sandbox is deferred until the graph is built for this thread, which
    # is the whole reason this module exposes a factory rather than a module-level
    # graph: one sandbox per conversation, not one shared by everybody.
    coder = create_deep_agent(
        model=_coder_model(),
        backend=await get_or_create_sandbox_for_thread(thread_id),
        system_prompt=CODER_PROMPT,
        # On the INNER agent, not on CompiledSubAgent: that TypedDict is only
        # {name, description, runnable, mode}, so an interrupt_on passed there is
        # silently ignored.
        #
        # `execute` is gated here and nowhere else — the supervisor's StateBackend has
        # no such tool. This is the approval that matters: a shell command on a real
        # machine, shown to the user before it runs.
        interrupt_on={"execute": True, "write_file": True, "edit_file": True},
    )
    subagents.append(
        CompiledSubAgent(
            name="coder",
            description=(
                "Writes and runs code on a real machine with a shell. Use it for "
                "anything that needs editing a project or running tests. Give it the "
                "task in plain words; the project lives in /workspace."
            ),
            runnable=coder,
        )
    )

    return create_deep_agent(
        model=_supervisor_model(),
        # Thread-scoped, and shared with the dict subagents: a file one of them writes
        # stays readable by the supervisor. Files live in graph state, so the UI reads
        # them from stream.values.files with no HTTP route.
        backend=StateBackend(),
        # Planning is opt-in as of 0.7. Without this there is no write_todos tool and
        # stream.values.todos never appears. Verified by probe.
        middleware=[TodoListMiddleware()],
        system_prompt=SUPERVISOR_PROMPT,
        subagents=subagents,
        # Mutating tools only. Gating ls/read_file/glob/grep would stop the run on
        # every read and make the page unusable. Dict subagents inherit this.
        interrupt_on={"write_file": True, "edit_file": True, "delete": True},
        # No checkpointer= and no store=: langgraph-api owns both. Passing a
        # checkpointer makes `langgraph dev` refuse to start (docs/LESSONS.md).
    ).with_config({"recursion_limit": 200})
