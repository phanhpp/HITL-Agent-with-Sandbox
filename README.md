# Full-stack agentic chatbot

Two deployed chatbots backed by real LangGraph agents — one that asks permission before
it acts, one that plans a job and delegates it to a team of subagents.

Streaming, human approval, conversation branching, and rejoining a run after a reload.
Nothing is mocked: every pause is a real graph interrupt, every branch a real
checkpoint, every subagent a real nested run on the server.

**Live:** https://fullstack-agent-ui.vercel.app

## What is built

### `/approve` — one agent, one gated tool

The agent proposes sending an email and stops. You approve, edit or reject it.

| Capability | What it does |
|---|---|
| Interrupt / resume | The agent pauses before a sensitive tool; the card survives a reload |
| Branching | Edit or Retry any message, with a `‹ 1/2 ›` switcher between branches |
| Rejoin | Reload or navigate away and come back to the same conversation, still running |
| Stop | Cancels the run server-side, not just the spinner |
| Tool-call cards | Arguments and results, attached to the turn that made the call |

### `/orchestrate` — a deep agent that plans and delegates

A Sonnet supervisor writes a plan, hands topics to Haiku workers, and synthesises what
comes back. File writes stop for approval wherever they happen — including inside a
worker.

| Capability | What it does |
|---|---|
| Plan panel | The agent's live todo list, from `TodoListMiddleware` |
| Subagent cards | One per delegation, attached to the turn that delegated it; expand to watch that worker's own messages, tools and reasoning stream |
| Reasoning traces | Extended thinking rendered for the supervisor and every worker |
| File panel | The agent's filesystem, read straight from graph state |
| Approval, nested | A worker's `write_file` raises a card on the page and resumes correctly |

Not built yet: a sandbox-backed coding subagent (`execute`, a real machine, a file
tree + diff panel). The graph is already an `async def agent(config)` factory and
`langgraph.json` already carries two graphs, so adding it is additive.

Branching is deliberately off on `/orchestrate`: the plan and file panels read
thread-level state, so forking makes them disagree with the transcript. Documented in
`docs/DEEP_GUIDE.md`.

### Human-in-the-loop, done properly

The approval gate is the part most worth reading. Two gated actions can reach the user
in two different shapes, both of which render two cards:

| What the agent did | Interrupts | Actions in each |
|---|---|---|
| two workers, one gated tool each | **2** | 1 |
| one agent, two gated calls in one message | **1** | **2** |

Each needs different handling, and getting either wrong runs an action the user never
approved — both failure modes were reproduced in a browser before being fixed. The hook
reads every pending interrupt, renders one card per action, holds each decision until
its interrupt is fully decided, and answers by interrupt id. See
`packages/web/lib/use-hitl.ts`, which is commented with the measurements rather than the
theory.

## Two processes

They only talk over HTTP.

```
Browser
   │  same-origin: /api/langgraph/...
   ▼
packages/web   Next.js 16 — pages + a proxy route that injects the API key
   │  http://127.0.0.1:2024  (local)  |  https://<id>.us.langgraph.app  (deployed)
   ▼
packages/agent  Python — LangGraph server: two graphs, threads, checkpoints
   ▼
Anthropic API
```

The proxy is a route handler rather than a `next.config` rewrite because a rewrite
cannot add headers, so the LangSmith key would have to reach the browser.

The frontend picks a graph per request with `assistantId`, so both pages are served by
one deployment.

## Stack

| | |
|---|---|
| Frontend | Next.js 16 (App Router), React 19, TypeScript 5.9, Tailwind v4 |
| Agent SDK | `@langchain/react` `useStream` + selector hooks, `@langchain/langgraph-sdk` |
| Agents | Python 3.12, LangGraph, LangChain, `deepagents` 0.7 |
| Models | Claude Sonnet 5 (supervisor, adaptive thinking), Claude Haiku 4.5 (workers) |
| Hosting | Vercel (web) + LangSmith Deployment (agent), both redeploy on push |
| Tooling | uv (Python), pnpm, Make |

## Quickstart

Needs Node 22+ (`.nvmrc` says 24), pnpm, [uv](https://docs.astral.sh/uv/), GNU Make,
and an [Anthropic API key](https://console.anthropic.com/). uv fetches the right Python
itself, so you do not need one installed.

```bash
cp .env.example packages/agent/.env     # then add ANTHROPIC_API_KEY
make install                            # uv sync + pnpm install
make dev-next                           # agent :2024 + Next.js :4200
```

Open [http://localhost:4200](http://localhost:4200).

`packages/web/.env.local` is optional locally — `AGENT_SERVER_URL` defaults are in
`.env.local.example`, and `langgraph dev` needs no API key.

| Command | Runs |
|---|---|
| `make dev-next` | agent + Next.js app — **this is the project** |
| `make dev-agent` | LangGraph server only, port 2024 |
| `make dev-web` | Next.js only, port 4200 |
| `make typecheck` | `tsc --noEmit` — the only automated gate |
| `make dev` | agent + the old Vite app, port 4100 (reference only) |

## Layout

| Path | What |
|---|---|
| `packages/web` | **The app.** Next.js 16 App Router, Tailwind v4 |
| `packages/agent` | The Python graphs — a uv project. `langgraph.json` registers `human_in_the_loop` and `orchestrator` |
| `packages/frontend` | The original Vite app, kept as a reference. Not part of the system |

## Troubleshooting

- **The UI behaves unlike the Python code.** If port 2024 is taken, `langgraph dev`
  quietly starts on a random port while the app keeps talking to 2024. Check with
  `lsof -nP -iTCP:2024 -sTCP:LISTEN`.
- **`pnpm` fails with `URL.canParse is not a function`.** Node older than 22. Run
  `nvm use` in the repo root, in each new terminal.
- **Agent dependencies look wrong.** They are pinned in `packages/agent/uv.lock`. Run
  `uv sync` from `packages/agent` to match it exactly, or `uv lock --upgrade` to move
  them deliberately.
- **No reasoning appears.** Extended thinking is model-dependent. Sonnet 5 takes
  `{"type": "adaptive", "display": "summarized"}`; without `display` the default is
  `"omitted"` and no reasoning blocks are returned at all — silently. Pre-4.7 models
  take `{"type": "enabled", "budget_tokens": N}` and reject the adaptive form with a 400.
- **Inspect server state directly.** `curl localhost:2024/threads/<id>/state` is the
  truth; `threads/search` returns a stale snapshot.
