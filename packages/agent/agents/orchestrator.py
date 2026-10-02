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

from langchain.agents.middleware import TodoListMiddleware
from langchain.chat_models import init_chat_model
from langchain_core.runnables import RunnableConfig
from deepagents import CompiledSubAgent, create_deep_agent
from deepagents.backends import StateBackend

from agents.prompts import ANALYST_PROMPT, RESEARCHER_PROMPT, SUPERVISOR_PROMPT

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

SUPERVISOR_MODEL = "anthropic:claude-sonnet-5"
WORKER_MODEL = "anthropic:claude-haiku-4-5"


def _supervisor_model():
    """Sonnet 5: adaptive thinking, and `summarized` to actually receive it."""
    return init_chat_model(
        SUPERVISOR_MODEL,
        thinking={"type": "adaptive", "display": "summarized"},
        max_tokens=8000,
    )


def _worker_model():
    """Haiku 4.5: the pre-4.7 budget form. `max_tokens` must exceed `budget_tokens`."""
    return init_chat_model(
        WORKER_MODEL,
        thinking={"type": "enabled", "budget_tokens": 2000},
        max_tokens=8000,
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

    # Phase 3 inserts the sandbox-backed coder here:
    #
    #   from agents.sandbox import get_or_create_sandbox_for_thread
    #   coder = create_deep_agent(
    #       model=<coder model, its own thinking config>,
    #       backend=await get_or_create_sandbox_for_thread(thread_id),
    #       system_prompt=CODER_PROMPT,
    #       # On the INNER agent, not on CompiledSubAgent: that TypedDict has no
    #       # interrupt_on key, so passing it there is silently ignored. Verified to
    #       # still surface at the root tasks[] from here.
    #       interrupt_on={"execute": True, "write_file": True, "edit_file": True},
    #   )
    #   subagents.append(CompiledSubAgent(name="coder", description=..., runnable=coder))

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
