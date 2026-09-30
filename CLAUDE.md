# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All run from the repo root (there is no root `package.json`; the Makefile drives everything):

```bash
make install        # create .venv (Python 3.11+), pip install agent deps, pnpm install frontend
make dev            # agent (port 2024) + frontend (port 4100) together
make dev-agent      # LangGraph dev server only: .venv/bin/python -m langgraph_cli dev --port 2024
make dev-frontend   # Vite only
```

Typecheck the frontend with `cd packages/frontend && pnpm exec tsc --noEmit`. It currently fails on a TypeScript 6 deprecation of `baseUrl` in `tsconfig.json`, not on app code. There are no tests or linters.

The agent reads its secrets from `packages/agent/.env` (set by `"env": ".env"` in `langgraph.json`), not from a root `.env`. `ANTHROPIC_API_KEY` is required.

Node 22+ is needed (`.nvmrc` says 24). On this machine, use an arm64 Node build: the installed Vite bundler binding is arm64-only and x64 Node fails with "Cannot find native binding".

## Architecture

Two separate processes that only talk over HTTP:

- **`packages/agent`**: Python. `langgraph.json` registers graph `human_in_the_loop` → `agents/human_in_the_loop.py:agent`, built with `create_agent` + `HumanInTheLoopMiddleware`. Tools live in `tools/`; imports like `from tools.email import ...` work because `langgraph.json` puts `.` on the path.
- **`packages/frontend`**: Vite + React 19, using `useStream` from `@langchain/react`. Vite proxies `/api/langgraph/*` to `127.0.0.1:2024`, and the app always calls that same-origin URL (`src/agent-config.ts`; `?agentServer=<url>` overrides it). `SLUG_TO_ASSISTANT` maps a frontend pattern to a graph name, so a new graph needs an entry in both `langgraph.json` and there.

If port 2024 is already taken, `langgraph dev` quietly starts on a random port, and the frontend keeps talking to whatever holds 2024. Check `lsof -nP -iTCP:2024 -sTCP:LISTEN` when the UI behaves unlike the Python code.

### Human-in-the-loop flow

1. The model proposes a `send_email` call; the middleware interrupts before running it.
2. `src/patterns/human-in-the-loop/preview.tsx` reads `stream.interrupt.value` as a `HITLRequest` and renders `ApprovalCard` per action.
3. The user's choice goes back via `stream.respond({ decisions: [...] })`, with one decision per action request (`approve`, `edit` with `editedAction`, or `reject` with `message`).
4. On `edit`, the AI message keeps the model's original arguments; LangChain prepends a "human reviewer replaced this tool call" note to the tool result with the arguments that actually ran. The system prompt in `human_in_the_loop.py` exists because without it the model re-issues the original call after an edit. Keep it if you change the model or the prompt.

`tools/email.py` is a stub: it sends nothing and returns fake `"status": "sent"` JSON.

### packages/web (Next.js)

The app under active development. Run it with `make dev-next` (agent :2024 + Next :4200).

- `app/api/langgraph/[...path]/route.ts` proxies every agent call and injects `X-Api-Key` from `AGENT_SERVER_URL`/`LANGSMITH_API_KEY`. A `next.config` rewrite cannot add headers, which is why this is a route handler. The key is only set when present, so `langgraph dev` works locally with no key.
- **Height chain.** `body` is `h-dvh flex flex-col`, `main` is `flex-1 min-h-0 flex flex-col`, and pages pass `embedded` to `ChatContainer`. `main` must stay a flex container: `flex-1` means nothing to a child of a block element, and the symptom is silent — the chat grows past the viewport and nothing scrolls.
- **Thread ids must be persisted** (`GUIDE.md` 8.3). Use `usePersistedThreadId("thread:<page>")` from `lib/use-persisted-thread.ts`. A run continues server-side after you navigate away, so dropping the id discards a live conversation. Two rules, both load-bearing: the hook reads `localStorage` in an effect, never a `useState` initializer (a `"use client"` component is still server-rendered, where `localStorage` does not exist); and the component that reads storage must **not** render the one owning `useStream` until the id is resolved — `useStream` assigns an id and calls `onThreadId` on mount, overwriting the stored value. Hence the outer/inner split in `features/approve/ApproveChat.tsx`.
- `lib/state.ts` declares only what the UI renders. `create_agent` supplies langchain's `AgentState`; middleware adds more keys, which the server will list at `GET /assistants/<assistant_id>/schemas` if you need them.
- Interrupt payloads are snake_case over raw HTTP (`action_requests`, `edited_action`) and camelCase through `useStream`. Components read camelCase; `curl` tests must use snake_case.

### packages/frontend (Vite, reference only)

- `@langchain/playground-agents` is not a real package: `src/agents-types.d.ts` declares it with `any` types so `useStream<typeof humanInTheLoopAgent>` compiles. Message state is not type-checked against the Python graph.
- Shared chat UI (bubbles, input, markdown, cards) is re-exported from `src/components/playground.ts`.
- Thread state is held by the dev server in memory and saved to `packages/agent/.langgraph_api/`. Inspect it with `curl localhost:2024/threads/<id>/state`.

## GUIDE.md

`GUIDE.md` is a long beginner's guide to `@langchain/react` and LangGraph frontend patterns (streaming, HITL, branching, time travel, deep agents), with section numbers used as references. Its examples name a `simple_agent` graph that does not exist in this repo.

For the actual Next.js + Python architecture going forward, Vite is irrelevant. It's just a leftover reference copy sitting in the repo, not a moving part of the system you're building.