# Deep Agents Frontend Guide

How to build a UI for a `create_deep_agent` graph with `@langchain/react` v1: the
coordinator transcript, subagent cards, a live todo list, and a sandbox file
browser.

Consolidated from the four pages in `docs/deepagent/`. Every type claim here was
checked against the packages installed in `packages/web`, not copied from the
docs — where the two disagree, the installed `.d.ts` wins and the disagreement is
called out.

Nothing in this guide is built yet. It is the reference for `/orchestrate`.

---

## Contents

1. [The shape of a deep agent run](#1-the-shape-of-a-deep-agent-run)
2. [What the stream gives you](#2-what-the-stream-gives-you)
3. [Subagents](#3-subagents)
4. [The todo list](#4-the-todo-list)
5. [The sandbox](#5-the-sandbox)
6. [What this repo already has](#6-what-this-repo-already-has)
7. [Unknowns to probe before building](#7-unknowns-to-probe-before-building)

---

## 1. The shape of a deep agent run

A deep agent is a **coordinator** that plans and delegates to **subagents**, each
running in its own namespace. The point of the UI is to make the delegation
visible — otherwise it is one opaque assistant bubble that takes two minutes.

```
coordinator          plans, calls task(), synthesises the answer
  ├── researcher     its own messages, tool calls, status
  └── analyst        same
```

The Python side is a list of dicts:

```python
from deepagents import create_deep_agent

agent = create_deep_agent(
    model="anthropic:claude-haiku-4-5",
    tools=[...],
    system_prompt="You are a coordinator. Plan, then delegate with task().",
    subagents=[
        {
            "name": "researcher",
            "description": "Research one topic at a time.",
            "system_prompt": "You are a great researcher.",
        },
    ],
)
```

Attaching one subagent auto-attaches `SubAgentMiddleware` and the `task` tool.

**The single most useful fact:** a subagent's `id` *is* the `task` tool-call id
that spawned it. That is what lets you render a subagent card underneath the
coordinator message that delegated the work, instead of in a disconnected list.

---

## 2. What the stream gives you

No special stream options. Point `useStream` at the deep agent as usual.

| Source | What it holds |
|---|---|
| `stream.messages` | the **coordinator's** messages only — not the subagents' |
| `stream.subagents` | `ReadonlyMap<string, SubagentDiscoverySnapshot>` |
| `stream.values.todos` | the todo list, **only** if planning is enabled |
| `useMessages(stream, subagent)` | that subagent's messages |
| `useToolCalls(stream, subagent)` | that subagent's tool calls |

The split matters: the coordinator's reasoning stays readable because the
specialists' token streams are not interleaved into it.

### Selector hooks are ref-counted subscriptions

Verified in `@langchain/react/dist/selectors.d.ts`:

> For any other namespace, the mount triggers a ref-counted `messages`
> subscription scoped to that namespace. Unmounting the last component that
> watches this namespace closes the subscription automatically.

So `useMessages(stream, subagent)` opens a live subscription **while mounted**.
Mount it in the *expanded body* of a card, not in the card wrapper, or every
subagent in the thread streams whether or not anyone is looking at it.

At the root (`useMessages(stream)` with no target) it just returns
`stream.messages` and opens nothing.

### Recursion limit

Deep agents default to 10,000, which the docs say is enough for most setups.
Override per submit if you nest deeply:

```ts
stream.submit(
  { messages: [{ type: "human", content: text }] },
  { config: { recursion_limit: 100 } },
);
```

---

## 3. Subagents

### The snapshot is discovery metadata, not content

`stream.subagents` holds **snapshots**: they say a subagent exists, where it sits
in the tree, and what state it is in. They do **not** carry its messages. For
those you pass the snapshot to a selector hook.

The real shape, from `@langchain/langgraph-sdk/dist/stream/types.d.ts`:

```ts
interface SubagentDiscoverySnapshot {
  readonly id: string;                 // the task tool-call id that created it
  readonly name: string;               // "researcher"
  readonly namespace: readonly string[];
  readonly parentId: string | null;    // null when spawned from the root
  readonly depth: number;              // root = 0
  readonly status: "running" | "complete" | "error";
  readonly taskInput: string | undefined;
  readonly output: unknown;            // NOT a string
  readonly error: string | undefined;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
}
```

**Two things the docs get wrong or omit.**

- Their `SubagentCard` writes `lastAIMessage?.text ?? subagent.output ?? ""` and
  renders the result as text. `output` is typed **`unknown`**, so that does not
  typecheck here and would render `[object Object]` if it were ever reached.
  Narrow it before display.
- The docs never mention `parentId`, `depth`, `taskInput`, `error`,
  `startedAt` or `completedAt`. Those are what you need for nested subagents, a
  duration readout, and showing *why* a subagent failed rather than a red dot.

`status` is exactly three values, so `=== "complete"` is safe, and there is **no
`"pending"`** — a subagent exists only once its `task` call starts.

### Attaching cards to the turn that spawned them

Because `subagent.id` is the tool-call id, the mapping is direct:

```tsx
const subagents = [...stream.subagents.values()];
const byCallId = new Map(subagents.map((s) => [s.id, s]));

// inside the message loop
const turnSubagents = AIMessage.isInstance(message)
  ? (message.tool_calls ?? [])
      .map((tc) => byCallId.get(tc.id ?? ""))
      .filter((s): s is SubagentDiscoverySnapshot => !!s)
  : [];
```

This is the same rule §7 of `docs/BUILD.md` already applies to approval cards:
**anchor per-turn UI to its turn, not the thread bottom.** It matters more here,
because a long run has several delegating turns.

### Progress

`status` is enough for a progress bar — no extra state:

```ts
const completed = subagents.filter((s) => s.status === "complete").length;
const percentage = subagents.length
  ? Math.round((completed / subagents.length) * 100)
  : 0;
```

---

## 4. The todo list

### Planning is opt-in

As of deepagents v0.7 the todo middleware is **not** on by default. Without it,
`stream.values.todos` is `undefined` — not `[]`. Enable it explicitly:

```python
from langchain.agents.middleware import TodoListMiddleware

agent = create_deep_agent(..., middleware=[TodoListMiddleware()])
```

That adds the `write_todos` tool and persists plan progress as state.

### The shape

Verified in `langchain/dist/agents/middleware/todoListMiddleware.d.ts`:

```ts
type Todo = {
  content: string;
  status: "pending" | "in_progress" | "completed";
};
```

Two consequences:

- **There is no `id`.** Key list items by index, and accept that reordering
  re-renders. Nothing else is available.
- **Three statuses**, and the agent moves each item
  `pending → in_progress → completed` as it works.

### Reading it

```ts
const todos = stream.values?.todos ?? [];
const completed = todos.filter((t) => t.status === "completed").length;
```

`?? []` is load-bearing — `undefined` is the normal state before the agent writes
a plan, and on any run where it decides planning is not worth it. The middleware
prompt explicitly tells the model to skip todos for simple requests, so **an
empty panel is a correct state, not a bug.** Design for it.

---

## 5. The sandbox

This is the heaviest of the four, and the one that needs backend work.

### The filesystem is not in graph state

With a sandbox backend, `read_file` / `write_file` / `edit_file` / `delete` /
`execute` are built by the sandbox on top of `execute()`, and the files live **in
the remote sandbox**. There is no `stream.values.files` to read.

So a file browser needs **two HTTP routes of your own**, mounted beside the graph
server via `langgraph.json`:

```json
{ "graphs": { ... }, "http": { "app": "./http_app.py:app" } }
```

They ship inside the deployed image.

### Sandboxes are keyed by thread

The documented default is **thread-scoped**: both the frontend and the custom API
server resolve the sandbox from the LangGraph thread id, stored on
`thread.metadata.sandbox_id`.

```
page load ──► POST /threads                 ──► threadId
           ──► GET /sandbox/:threadId/tree
                 └─► threads.get(threadId) → metadata.sandbox_id
                      ├─ missing  → create sandbox, threads.update(metadata)
                      └─ present  → connect to it
```

This pairs exactly with the rejoin work already built: persist the thread id and
a reload reconnects to the *same* sandbox, not a fresh one.

### Three states, not one

A sandbox is **running**, **stopped**, or **deleted**, and the panel has to say
which. An empty tree or a 500 for a stopped sandbox reads as a broken demo rather
than an expired one. `start_sandbox` can take up to 120s, so "stopped" needs its
own copy ("send a message to wake it"), not a spinner.

### The `path` query parameter is attacker-controlled

A `GET /sandbox/{thread}/file?path=…` route takes a path from the browser. Without
a containment check that is a directory-traversal read. The user's existing
`llm_wiki/src/tools/sandbox_tools.py` already has the guard to port.

### Refresh granularity

Refetch the **tree** after `execute` or `delete`; refetch a **single file** after
`write_file` / `edit_file`. And keep a `useRef(new Set())` of processed tool-call
ids — an effect keyed on `messages` re-runs per streamed token and twice more
under StrictMode.

---

## 6. What this repo already has

The `/orchestrate` page is less new code than it looks. Already built and tested:

| Need | Already have |
|---|---|
| Thread persistence, Leave / Rejoin | `components/ChatShell.tsx` |
| Approval cards for `execute` / `write_file` | `components/ApprovalCard.tsx` — renders arbitrary tool args |
| Decisions, both interrupt locations | `lib/use-hitl.ts` |
| Tool call + result rendering | `components/ToolCallCard.tsx` |
| Branching, branch switcher | `lib/use-branching.ts` |
| Real cancel | `lib/use-stop-run.ts` |
| Thinking display | `components/chat/Bubble.tsx:78` — unused, identical to the reference |
| Subagent card | `components/cards/SubAgentCard.tsx` — ported, **unused**, takes `{ stream, subagent }` |

`SubAgentCard` already calls `useMessages` / `useToolCalls`. Per §2 it must be
**split** so the body mounts only when expanded, or every subagent streams at
once.

---

## 7. Unknowns to probe before building

Each of these has burned time in this project when assumed. Probe, then build.

| Unknown | How to settle it |
|---|---|
| Does `interrupt_on` fire on `stream.interrupt` or `stream.getThread()?.interrupts`? | Raise one and look. `lib/use-hitl.ts` handles both, but the subagent branch is **written from types and never executed**. |
| Does `stream.values.todos` match the `Todo` shape at runtime? | `curl localhost:2024/threads/<id>/state` after a planning run. |
| What is the sandbox `files` shape, if any? | Same state dump. The docs say it is not in state — confirm for our backend. |
| Do subagents surface their own reasoning blocks? | Enable `thinking`, delegate, read `contentBlocks` on a subagent message. |
| Does thinking survive a HITL pause/resume with tools? | The Anthropic API constrains thinking + tool use; `langchain-anthropic` is meant to handle it. Unverified here. |
| Does `deepagents` break `/approve`? | It bumps `langchain-core` for both graphs in the shared `uv.lock`. Re-run the `/approve` flow after `uv add`. |

---

## Sources

`docs/deepagent/overview.md`, `subagent_streaming.md`, `todos.md`, `sandbox.md`.
Type claims verified against `@langchain/react` and `@langchain/langgraph-sdk` in
`packages/web/node_modules`, and `langchain`'s `todoListMiddleware.d.ts`.
