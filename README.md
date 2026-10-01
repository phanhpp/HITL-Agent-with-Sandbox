# Agent UI patterns

A chat interface over a real LangGraph agent: streaming, human approval, conversation
branching, and rejoining a run after a reload. Nothing is mocked — every pause is a
real graph interrupt, every branch a real checkpoint.

Built as a worked example of the frontend problems an agent UI actually has.

## What is built

**`/approve`** — the agent proposes sending an email and stops. You approve, edit or
reject it.

| Capability | What it does |
|---|---|
| Interrupt / resume | The agent pauses before a sensitive tool; the card survives a reload |
| Branching | Edit or Retry any message, with a `‹ 1/2 ›` switcher between branches |
| Rejoin | Reload or navigate away and come back to the same conversation, still running |
| Stop | Cancels the run server-side, not just the spinner |
| Tool-call cards | Arguments and results, attached to the turn that made the call |

`/orchestrate` (deep agent, subagent cards, sandbox) is planned, not built.

## Two processes

They only talk over HTTP.

```
Browser
   │  same-origin: /api/langgraph/...
   ▼
packages/web   Next.js 16 — pages + a proxy route that injects the API key
   │  http://127.0.0.1:2024  (local)  |  https://<id>.us.langgraph.app  (deployed)
   ▼
packages/agent  Python — LangGraph server: graphs, threads, checkpoints
   ▼
Anthropic API
```

The proxy is a route handler rather than a `next.config` rewrite because a rewrite
cannot add headers, so the LangSmith key would have to reach the browser.

## Quickstart

Needs Node 22+ (`.nvmrc` says 24), pnpm, Python 3.11+, GNU Make, and an
[Anthropic API key](https://console.anthropic.com/).

```bash
cp .env.example packages/agent/.env     # then add ANTHROPIC_API_KEY
make install                            # .venv + pnpm install
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
| `packages/agent` | The Python graph. `langgraph.json` registers `human_in_the_loop` |
| `packages/frontend` | The original Vite app, kept as a reference. Not part of the system |

## Troubleshooting

- **The UI behaves unlike the Python code.** If port 2024 is taken, `langgraph dev`
  quietly starts on a random port while the app keeps talking to 2024. Check with
  `lsof -nP -iTCP:2024 -sTCP:LISTEN`.
- **`pnpm` fails with `URL.canParse is not a function`.** Node older than 22. Run
  `nvm use` in the repo root, in each new terminal.
- **`make install` cannot find Python.** Needs 3.11+ as `python3.12`/`python3.11` on
  `PATH`, or Homebrew `python@3.12`. If `.venv` was built with the wrong one,
  `rm -rf .venv && make install`.
- **Inspect server state directly.** `curl localhost:2024/threads/<id>/state` is the
  truth; `threads/search` returns a stale snapshot.
