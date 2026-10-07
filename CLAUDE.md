# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
make install        # uv sync in packages/agent, pnpm install the frontends
make dev-next       # agent (:2024) + Next.js (:4200) together
make dev-agent      # LangGraph dev server only
make test           # 78 pytest + 29 vitest, ~2s, no API key
make test-e2e       # 8 Playwright tests vs a fake agent; builds first
make typecheck
```

**What Make is, and is not.** It is a cross-package convenience layer, used **only
locally**. It is not a build system and plays no part in either deployment — Vercel builds
`packages/web`, LangSmith builds `packages/agent`, and neither needs a command that spans
both.

Only three targets do something you cannot type as easily yourself, and all three span
both packages: `dev-next` (two servers in parallel), `install`, and `test`. Everything
else is already a one-liner in the right directory:

```bash
cd packages/web   && pnpm run test        # same as make test-web
cd packages/agent && uv run --group test pytest -q
```

**CI does not use Make**, deliberately. Each job sets `working-directory` to one package,
so it is already inside the package and has no cross-package problem to solve. A workflow
that spells out its commands is also easier to debug than one hiding them behind a target.

Dropping the Makefile would cost exactly one thing: starting both dev servers with a
single command. The rest you would type.

Tests are documented in `docs/TESTING.md` (untracked) — what is automated, what still has
to be checked by hand, and why.

The agent reads its secrets from `packages/agent/.env` (set by `"env": ".env"` in `langgraph.json`), not from a root `.env`. `ANTHROPIC_API_KEY` is required; `LANGSMITH_API_KEY` is required too once `/orchestrate` delegates to the coder, because the sandbox API authenticates with the same key as LangSmith Deployments.

`ORCHESTRATE_SUPERVISOR_MODEL`, `ORCHESTRATE_WORKER_MODEL` and `ORCHESTRATE_CODER_MODEL` override the models. Set the coder to `anthropic:claude-haiku-4-5` to exercise the whole delegation path cheaply. The thinking config follows the model, not the role — overriding to Haiku and keeping the adaptive form is a hard 400.

Node 22+ is needed (`.nvmrc` says 24). On this machine, use an arm64 Node build: the installed Vite bundler binding is arm64-only and x64 Node fails with "Cannot find native binding".

## Architecture

Two separate processes that only talk over HTTP:

- **`packages/agent`**: Python. `langgraph.json` registers two graphs — `human_in_the_loop` → `agents/human_in_the_loop.py:agent` (`create_agent` + `HumanInTheLoopMiddleware`) and `orchestrator` → `agents/orchestrator.py:agent`, a deep agent. It also registers `"http": {"app": "./http_app.py:app"}`, extra routes served alongside the graphs. Tools live in `tools/`; imports like `from tools.email import ...` work because `langgraph.json` puts `.` on the path.

  `orchestrator` is an **async graph factory**, not a module-level graph, because each thread gets its own sandbox (`agents/sandbox.py`). Changing that shape changes the entry point and the deployment, so do not flatten it back.
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

`docs/BUILD.md` is a walkthrough of how it works, section by section, in `GUIDE.md`'s style. Read it before changing the chat surface — most of what looks arbitrary there is load-bearing.

- `app/api/langgraph/[...path]/route.ts` proxies every agent call and injects `X-Api-Key` from `AGENT_SERVER_URL`/`LANGSMITH_API_KEY`. A `next.config` rewrite cannot add headers, which is why this is a route handler. The key is only set when present, so `langgraph dev` works locally with no key.
- **Height chain.** `body` is `h-dvh flex flex-col`, `main` is `flex-1 min-h-0 flex flex-col`, and pages pass `embedded` to `ChatContainer`. `main` must stay a flex container: `flex-1` means nothing to a child of a block element, and the symptom is silent — the chat grows past the viewport and nothing scrolls.
- **Thread ids must be persisted.** `components/ChatShell.tsx` owns this; pages receive `threadId` as a prop. A run continues server-side after you navigate away, so dropping the id discards a live conversation. It reads `localStorage` in a **synchronous `useState` initializer**, which is safe only because the page is loaded through `dynamic(..., { ssr: false })` — see `features/*/\*Client.tsx`. (An older note here described an effect-based `usePersistedThreadId` hook; that file does not exist and the rule is the opposite.)
- `lib/state.ts` declares only what the UI renders. `create_agent` supplies langchain's `AgentState`; middleware adds more keys, which the server will list at `GET /assistants/<assistant_id>/schemas` if you need them.
- Interrupt payloads are snake_case over raw HTTP (`action_requests`, `edited_action`) and camelCase through `useStream`. Components read camelCase; `curl` tests must use snake_case.

### The sandbox (`/orchestrate`'s coder)

`agents/sandbox.py` is the only provider-specific file. One function,
`get_or_create_sandbox_for_thread`, owns the whole choice: swapping LangSmith for
Daytona is a rewrite of that body and nothing else.

- **One machine per thread**, named `orchestrate-{thread_id}`. TTLs are 600s idle /
  3600s delete; the platform's deletion default is ~14 days, which on a public link
  would keep a machine per visitor for a fortnight.
- **No status check and no start call.** A stopped sandbox restarts itself on the next
  operation in about two seconds, so asking first is a round trip that changes nothing.
- **The workspace is a git repository.** `ensure_git_baseline` commits it at seed time,
  and that commit is what the file panel diffs against. This is load-bearing: a baseline
  kept in page state dies on reload, and the page then adopts the already-edited files
  as the "before" and shows no changes at all, silently. Never move it back into React.
- **`http_app.py` serves the panel**: `/sandbox/{thread_id}/tree`, `/file` (with
  `?rev=baseline` for the left-hand side of a diff), `/changes`, and `POST /baseline`.
  Three rules there, each with a reason in the file: `shlex.quote` every path that
  reaches a shell, reject anything outside `WORKDIR`, and never create a sandbox on a
  GET — the official reference does, which lets anyone spend money by guessing ids.
- **Count round trips.** Each `execute` costs about a second. `/changes` answers in one
  shell invocation; it used to take five and the panel visibly lagged.
- `langgraph dev` **rejects blocking calls** in async handlers, so the sync SDK client
  goes through `asyncio.to_thread`. A Starlette `TestClient` will not reproduce it.

### packages/frontend (Vite, reference only)

- `@langchain/playground-agents` is not a real package: `src/agents-types.d.ts` declares it with `any` types so `useStream<typeof humanInTheLoopAgent>` compiles. Message state is not type-checked against the Python graph.
- Shared chat UI (bubbles, input, markdown, cards) is re-exported from `src/components/playground.ts`.
- Thread state is held by the dev server in memory and saved to `packages/agent/.langgraph_api/`. Inspect it with `curl localhost:2024/threads/<id>/state`.

## GUIDE.md

`GUIDE.md` is a long beginner's guide to `@langchain/react` and LangGraph frontend patterns (streaming, HITL, branching, time travel, deep agents), with section numbers used as references. Its examples name a `simple_agent` graph that does not exist in this repo.

For the actual Next.js + Python architecture going forward, Vite is irrelevant. It's just a leftover reference copy sitting in the repo, not a moving part of the system you're building.