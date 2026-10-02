# Full-stack agentic chatbot

Two deployed chatbots backed by real LangGraph agents — one that asks permission before
it acts, one that plans a job and delegates it to a team of subagents.

Streaming, human approval, conversation branching, and rejoining a run after a reload.
Nothing is mocked: every pause is a real graph interrupt, every branch a real
checkpoint, every subagent a real nested run on the server.

**Live:** [https://fullstack-agent-ui.vercel.app](https://fullstack-agent-ui.vercel.app)

## Architecture

Two processes, deployed separately, that only talk over HTTP.

```
Browser                         never holds a key, never leaves the origin
   │  /api/langgraph/...
   ▼
packages/web    Next.js 16 on Vercel
                routes the two chats, and proxies every agent call,
                injecting the LangSmith key server-side
   │  https://<id>.us.langgraph.app      (http://127.0.0.1:2024 locally)
   ▼
packages/agent  Python on LangSmith Deployment
                LangGraph server: two graphs, threads, checkpoints,
                managed Postgres + Redis
   ▼
Anthropic API
```

**Next.js does two jobs:** it serves the pages, and it proxies every agent call so the
API key stays server-side and the browser only ever talks to its own origin.

**One agent deployment serves both chats.** LangSmith owns the checkpointer, so threads,  
branches and pending approvals live in its managed Postgres — which is why a run  
survives a closed tab.

## What is built

### `/approve` — one agent, one gated tool

The agent proposes sending an email and stops. You approve, edit or reject it.


| Capability         | What it does                                                                  |
| ------------------ | ----------------------------------------------------------------------------- |
| Interrupt / resume | The agent pauses before a sensitive tool; the card survives a reload          |
| Branching          | Edit or Retry any message, with a `‹ 1/2 ›` switcher between branches         |
| Rejoin             | Reload or navigate away and come back to the same conversation, still running |
| Stop               | Cancels the run server-side, not just the spinner                             |
| Tool-call cards    | Arguments and results, attached to the turn that made the call                |




### `/orchestrate` — a deep agent that plans, delegates and writes code

A Sonnet supervisor writes a plan, hands topics to Haiku workers, and delegates coding to
a subagent with **a real Linux machine**. Every file write and every shell command stops
for approval, wherever it happens — including inside a worker.

| Capability | What it does |
|---|---|
| Plan panel | The agent's live todo list, from `TodoListMiddleware` |
| Subagent cards | One per delegation, attached to the turn that delegated it; expand to watch that worker's own messages, tools and reasoning stream |
| Reasoning traces | Extended thinking rendered for the supervisor and every worker |
| Sandbox | A per-conversation machine. The coder reads, edits and runs commands on it; nothing is shared between conversations |
| Approval on `execute` | A shell command is shown to you before it runs. Nothing else in the app has a shell to gate |
| File tree and diffs | The workspace as the agent changes it, with a source-control view of what this run touched |
| Approval, nested | A worker's `write_file` raises a card on the page and resumes correctly |

The page is a two-column chat until a conversation needs code, then becomes a
three-column IDE — a code pane that sits empty takes the width the conversation needs.

## Why it holds up

Every behaviour above is server state, not UI state. Approvals are LangGraph interrupts
answered by id, branches are real checkpoints, a run keeps going on the server while
nobody is watching, and the diff is a git commit on the sandbox rather than a copy the
browser is holding — so a reload cannot lose it.

That last one is the rule the rest follows from: anything the page has to *remember* is
something a reload can take away. The parts that took the most care — resolving several
pending approvals without ever running an action the user did not click, and keeping
per-worker streams subscribed only while their card is open — are written up with the
measurements behind them in `docs/`.

## Stack


|           |                                                                             |
| --------- | --------------------------------------------------------------------------- |
| Frontend  | Next.js 16 (App Router), React 19, TypeScript 5.9, Tailwind v4              |
| Agent SDK | `@langchain/react` `useStream` + selector hooks, `@langchain/langgraph-sdk` |
| Agents    | Python 3.12, LangGraph, LangChain, `deepagents` 0.7                         |
| Models    | Claude Sonnet 5 (supervisor, adaptive thinking), Claude Haiku 4.5 (workers) |
| Sandbox   | LangSmith Sandboxes — one Linux machine per conversation, 10 min idle / 1 hour to delete |
| Hosting   | Vercel (web) + LangSmith Deployment (agent), both redeploy on push          |
| Tooling   | uv (Python), pnpm, Make                                                     |




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


| Command          | Runs                                                 |
| ---------------- | ---------------------------------------------------- |
| `make dev-next`  | agent + Next.js app — **this is the project**        |
| `make dev-agent` | LangGraph server only, port 2024                     |
| `make dev-web`   | Next.js only, port 4200                              |
| `make typecheck` | `tsc --noEmit` — the only automated gate             |
| `make dev`       | agent + the old Vite app, port 4100 (reference only) |




## Layout


| Path                | What                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `packages/web`      | **The app.** Next.js 16 App Router, Tailwind v4                                                     |
| `packages/agent`    | The Python graphs — a uv project. `langgraph.json` registers `human_in_the_loop` and `orchestrator` |
| `packages/frontend` | The original Vite app, kept as a reference. Not part of the system                                  |




## Troubleshooting

- **The UI behaves unlike the Python code.** If port 2024 is taken, `langgraph dev`
quietly starts on a random port while the app keeps talking to 2024. Check with
`lsof -nP -iTCP:2024 -sTCP:LISTEN`.
- `pnpm` **fails with** `URL.canParse is not a function`**.** Node older than 22. Run
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

