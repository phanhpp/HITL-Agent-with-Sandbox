# How packages/web works

A walkthrough of what was built and why, in the style of `GUIDE.md`. Section numbers
here are referenced from code comments.

Code blocks carry a `// file:line` comment. Paths are relative to `packages/web/`.

`GUIDE.md` teaches `@langchain/react` in the abstract. This teaches **this app**: which
file does what, and the reasoning behind each decision. Where the two disagree, this one
reflects what actually runs — see `docs/LESSONS.md` for why.

---

## Contents

1. [The two processes](#1-the-two-processes)
2. [The proxy](#2-the-proxy)
3. [Anatomy of a page](#3-anatomy-of-a-page)
4. [Rejoin: surviving reload](#4-rejoin-surviving-reload)
5. [Human in the loop](#5-human-in-the-loop)
6. [Tool-call cards](#6-tool-call-cards)
7. [Stop](#7-stop)
8. [Branching: Edit and Retry](#8-branching-edit-and-retry)
9. [File map](#9-file-map)
10. [Running and testing](#10-running-and-testing)

---

## 1. The two processes

Two servers. They only talk over HTTP.

| | Port | What it is |
|---|---|---|
| `packages/agent` | 2024 | Python. The LangGraph server: graphs, threads, checkpoints |
| `packages/web` | 4200 | Next.js. The UI and its API routes |

```
browser ──▶ Next.js (4200) ──▶ LangGraph (2024) ──▶ Anthropic
```

`packages/frontend` (Vite, port 4100) is the original app, kept as a reference. It is
not part of this.

Start both: `make dev-next`.

---

## 2. The proxy

**File:** `app/api/langgraph/[...path]/route.ts`

The browser never talks to the agent server directly. Every call goes through a Next.js
route handler first.

### What a rewrite is, and why we did not use one

A **rewrite** is a forwarding rule in `next.config.ts`. No code runs — Next matches the
URL, fetches the destination, and returns the response as-is:

```ts
// next.config.ts — NOT what this app does. Shown for contrast.
async rewrites() {
  return [{ source: "/api/langgraph/:path*", destination: "http://127.0.0.1:2024/:path*" }];
}
```

That is the whole feature. It is the direct equivalent of the Vite dev proxy, and it
works fine locally.

It breaks in production: a hosted agent needs an `X-Api-Key` header, and **a rewrite
cannot add one** — there is nowhere to put logic.

A **route handler** (`route.ts`) is a function that receives the request and returns a
response, so it can.

| | Rewrite | Route handler |
|---|---|---|
| Lives in | `next.config.ts` | `app/…/route.ts` |
| Runs code | no | yes |
| Add auth headers | **no** | yes |
| Read `process.env` per request | no | yes |
| Inspect or shape the response | no | yes |
| Cost | one config line | ~100 lines |

Pick a rewrite when you only need forwarding. Anything conditional needs a handler.

So the key lives in `process.env` on the server and never enters the browser bundle:

```ts
// route.ts:70-71
const apiKey = process.env.LANGSMITH_API_KEY;
if (apiKey) headers.set("X-Api-Key", apiKey);   // only when set
```

The `if` matters: locally there is no key, and `langgraph dev` needs none. Same file,
both environments.

### How the path is rebuilt

`[...path]` is a catch-all segment. It captures everything after `/api/langgraph` as an
array:

| Browser requests | `params.path` | Forwarded to |
|---|---|---|
| `/api/langgraph/threads/abc/state` | `["threads","abc","state"]` | `$AGENT_SERVER_URL/threads/abc/state` |

```ts
// route.ts:55-57
const { path } = await ctx.params;              // a Promise in Next 15+
const upstreamUrl = `${base}/${path.join("/")}${req.nextUrl.search}`;
```

That `join("/")` is what strips the `/api/langgraph` prefix — the same job the Vite
proxy does with an explicit rewrite rule.

### Keeping the stream flowing

**Nothing here defines SSE.** The Python agent server does. Ask `/runs/stream` directly
on port 2024 and it already answers:

```
content-type: text/event-stream; charset=utf-8
cache-control: no-store
x-accel-buffering: no
```

The SDK's default transport asks for that; LangGraph produces it. The proxy's only job
is **not to break it** — and creating a new `Response` is exactly where it could:

```ts
// route.ts:117-118, 122
responseHeaders.set("cache-control", "no-cache, no-transform");
responseHeaders.set("x-accel-buffering", "no"); // stop nginx-style batching
return new Response(upstream.body, { … });      // pass the stream, do not await it
```

Plus `duplex: "half"` when forwarding a request body, and forwarding `last-event-id` so
a dropped stream can resume.

### The method exports are the registration

```ts
// route.ts:135-140
export const GET = proxy;
export const POST = proxy;
// PUT, PATCH, DELETE, OPTIONS …
```

An unexported verb returns 405. All six are needed because the SDK uses several.

---

## 3. Anatomy of a page

Four layers. Each exists for one reason.

```
app/approve/page.tsx          server component — exports metadata
  └─ ApproveClient.tsx        "use client" — holds dynamic(ssr:false)
       └─ ChatShell.tsx       owns threadId. NEVER unmounts.
            └─ ApproveChat.tsx   owns useStream. Rebuilt on demand.
```

**Why `ApproveClient` exists.** `ChatShell` reads `localStorage` synchronously, which is
illegal during SSR. `dynamic(() => import(…), { ssr: false })` stops it rendering on the
server — and that call must itself live in a client component, so it needs its own file.

**Why the shell and the chat are separate.** This is `GUIDE.md` 8.3's shape, and both
halves matter:

- `ChatShell` holds `threadId` and never unmounts, so the id survives everything.
- `ApproveChat` holds `useStream` and is disposable — rebuilding it re-reads the thread.

```tsx
// ChatShell.tsx:128 — reconnect() at :61 bumps mountKey
<Fragment key={mountKey}>{renderChat({ threadId, onThreadId, onLeave, reconnect })}</Fragment>
```

Bumping `mountKey` throws the chat away and builds a fresh one. That is the **only** way
to make `useStream` re-read the server, since it exposes no re-hydrate.

**Never key that on `threadId`.** It goes `null → id` on the first submit, so the chat
would rebuild mid-run and lose the stream. This shipped as a bug: the server had a full
reply, the UI showed nothing.

---

## 4. Rejoin: surviving reload

**File:** `components/ChatShell.tsx` — `GUIDE.md` 8.3

A run continues on the server after you close the tab. Losing the thread id means losing
a conversation that still exists. So the id is stored:

```tsx
// ChatShell.tsx:50-57
const [threadId, setThreadId] = useState<string | null>(() => {
  try { return localStorage.getItem(storageKey); } catch { return null; }
});
```

Read **synchronously in the initializer**, not in an effect. In an effect, the first
render has `threadId = null`, and the conversation is gone after a reload. This is only
legal because of the `ssr: false` in §3.

`useStream` then re-hydrates from `thread.getState()` when handed an existing id — you
get the messages back without fetching anything yourself.

One storage key per page (`"thread:approve"`), so pages keep separate conversations.

### Four controls, four different effects

| Control | What it does to the thread |
|---|---|
| **Stop** | Cancels the active run. Thread and messages stay. |
| **Leave** | Detaches the browser, run **keeps going**. `stop({ cancel: false })`. |
| **Rejoin** | Rebuilds the chat with the same id. Reconnects. |
| **New conversation** | Clears the stored id. Abandons the thread. |

---

## 5. Human in the loop

**Files:** `lib/use-hitl.ts`, `components/ApprovalCard.tsx` — `GUIDE.md` 7.3

The Python side pauses before `send_email`:

```python
# packages/agent/agents/human_in_the_loop.py:17-24
middleware=[HumanInTheLoopMiddleware(interrupt_on={"send_email": {...}})]
```

The frontend sees that as `stream.interrupt`, renders a card, and sends a decision back.

### One decision per action, positionally aligned

```ts
// use-hitl.ts:89 (approve), :96 (reject), :107 (edit)
{ decisions: requests.map(() => ({ type: "approve" })) }
```

The fan-out is deliberate and easy to "fix" wrongly:

- **Reject** rejects *every* action.
- **Edit** approves all the others.

### Two places an interrupt can live

| Where it fires | Where to read it |
|---|---|
| Root agent | `stream.interrupt` |
| Inside a subagent | `stream.getThread()?.interrupts` — **not** `stream.interrupt` |

`use-hitl.ts` handles both, so a page never has to know. Several at once need one
`respondAll({ [id]: decision })` — a second `respond` fails, because the first already
started a new run.

The subagent branch is written from the types and is **unverified** until
`/orchestrate` exists to raise one.

### Cards attach to their own turn

Rendering the cards after the message list puts them at the bottom, which is only right
while the reviewed turn is last. Fork, or send another message, and the card detaches
from the call it is reviewing. So the page finds the message whose `tool_calls` match the
pending action and renders the card there, with a bottom fallback so an unmatched
interrupt is never unanswerable.

---

## 6. Tool-call cards

**File:** `components/ToolCallCard.tsx` — `GUIDE.md` 7.1

`stream.toolCalls` is a flat list for the whole thread, so each message filters its own:

```ts
// ApproveChat.tsx:228-231
const ids = new Set((message.tool_calls ?? []).map((tc) => tc.id));
stream.toolCalls.filter((tc) => ids.has(tc.callId));
```

**Key by `callId`, never by array index.** A call mutates in place, `running` →
`finished`, so an index key makes React reuse the wrong card when several are in flight.

---

## 7. Stop

**File:** `lib/use-stop-run.ts`

Two problems, both found by testing rather than reading.

### `stream.stop()` sends no cancel

Its implementation only cancels when an internal `#activeRunId` is set, and that never
happens on this transport. It silently becomes `disconnect()`: the browser detaches
while the agent keeps generating.

Found by checking the **server** log — clicking Stop produced zero `/cancel` requests.

So the run is found and cancelled directly:

```ts
// use-stop-run.ts:46-50
const runs = await client.runs.list(threadId, { limit: 10 });
const active = runs.find((r) => r.status === "pending" || r.status === "running");
if (active) await client.runs.cancel(threadId, active.run_id, /* wait */ true, "interrupt");
```

`wait: true` means "stopped" is not reported before the server has acted.

### A cancelled turn poisons the next one

`interrupt` keeps the run's writes — *including the human message that started it*. Stop
before the model replies and the thread holds a dangling question. The next turn then
hands the model `[human, human]` and it answers the **older** one.

Reproduced: ask "h3 indexing in 300 words", stop before any reply, send "hey", and the
agent explains H3.

`rollback` avoids that but deletes the user's own question. So instead the turn is
**closed**:

```ts
// use-stop-run.ts:55-63
const last = (await client.threads.getState(threadId)).values?.messages?.at(-1);
if (last?.type === "human") {
  await client.threads.updateState(threadId, {
    values: { messages: [{ type: "ai", content: "_(stopped by the user)_" }] },
  });
}
```

The question stays, a partial reply is kept, and the model sees a completed turn.

Read the **server** state to decide — after a cancel the client still holds whatever it
streamed.

### What Stop cannot do

Cancel cannot undo a run that already finished. On a two-second reply, Stop is a no-op
by the time you can click it. It earns its place where runs take minutes.

---

## 8. Branching: Edit and Retry

**Files:** `lib/use-checkpoints.ts`, `components/ForkControls.tsx` — `GUIDE.md` 8.1

Both re-run the graph from a point in the past:

- **Edit** — change your message, re-run from just before it.
- **Retry** — re-run the same turn unchanged.

Both need one thing: the checkpoint id to restart from.

### Where the id comes from

`GUIDE.md` uses `useMessageMetadata(…).parentCheckpointId`. **That is undefined here for
every message**, which silently disables both buttons.

Not a missing checkpointer — checkpoints exist. The stream simply never says which
checkpoint each message belongs to; its events carry no `checkpoint_id` at all.

So the id comes from the thread's timeline instead:

```
checkpoint_id     #msgs  next step
…eff1fa1fe0a4         4  done
…f3238d77dc57         3  model
…365493e02c1d         2  __start__
…260a0fc879f5         0  __start__     ← oldest
```

To re-run **message #3**: find the checkpoint where the thread had exactly **2**
messages — the state just before it existed — and pass that id as `forkFrom`.

### A fork branches, it does not delete

`submit(input, { forkFrom })` moves the thread to a new branch. The old messages stay in
`getHistory()`; they just stop appearing in `/state`.

Verified: after forking, `/state` had 2 messages while history still held all 10
checkpoints including the dropped branch. That history is what a `< 1/2 >` switcher
would read — v1 ships none.

### The client does not notice

After a fork the server holds one branch, but the browser keeps the messages it already
streamed, so the replaced reply lingers. The page rebuilds the chat once the run
finishes:

```tsx
// ApproveChat.tsx:113-118
useEffect(() => {
  if (forkPending && !isLoading) { setForkPending(false); reconnect(); }
}, [forkPending, isLoading, reconnect]);
```

Waiting for `isLoading` to fall matters — rebuilding mid-stream would drop the run.

---

## 9. File map

| File | Lines | Role |
|---|---|---|
| `app/api/langgraph/[...path]/route.ts` | 114 | The proxy (§2) |
| `app/layout.tsx` | 36 | Nav + `h-dvh flex flex-col` shell |
| `app/approve/page.tsx` | 11 | Server wrapper, exports `metadata` |
| `features/approve/ApproveClient.tsx` | 23 | `dynamic(ssr:false)` boundary (§3) |
| `features/approve/ApproveChat.tsx` | 310 | The page: `useStream`, messages, cards |
| `components/ChatShell.tsx` | 138 | Thread id, rejoin, remount (§4) |
| `components/ApprovalCard.tsx` | 302 | Approve / edit / reject UI |
| `components/ToolCallCard.tsx` | 58 | Tool call + result (§6) |
| `components/ForkControls.tsx` | 152 | Edit / Retry buttons + editor (§8) |
| `lib/use-hitl.ts` | 117 | Decisions, both interrupt locations (§5) |
| `lib/use-stop-run.ts` | 75 | Real cancel + close the turn (§7) |
| `lib/use-checkpoints.ts` | 75 | History → fork points (§8) |
| `lib/agent.ts` | 41 | SSR-safe URL, graph names |
| `lib/state.ts` | 45 | `AgentState` for `useStream<T>` |

Everything under `components/chat/` and `components/cards/` was copied from
`packages/frontend` with `"use client"` added where needed.

---

## 10. Running and testing

```bash
make dev-next        # agent :2024 + web :4200
make typecheck       # the only automated gate
```

`docs/TESTING.md` is the manual checklist. Every case in it exists because it was a real
bug.

Two habits that found things a checklist did not:

**Check the server, not the client.** When Stop appeared broken, `grep -i cancel` on the
agent log showed zero requests — that is what identified the SDK gap. `/threads/{id}/state`
is truth; `threads/search` returns a stale snapshot.

**Drive the real UI.** Browser automation found a regression in ten minutes that a
written checklist had missed for hours: every new conversation rendered zero messages
while the server held a full reply.

---

## Deferred: rejoin polish

Our rejoin works, but the official `join-rejoin` pattern does three things we do not.
Recorded here in case we want them later — none is required for anything else.

**1. Keep the transcript visible while disconnected.** Ours blanks the screen and shows
only a Rejoin button, so the conversation appears to vanish at the exact moment the agent
is still working. Theirs snapshots the messages first and renders them read-only:

```tsx
const handleDisconnect = (messages) => {
  setFrozenMessages(messages);   // capture before the stream dies
  setConnected(false);
};
// then: <MessageList messages={frozenMessages} /> + a banner
//       "Stream disconnected — agent may still be running"
```

Wrinkle: `ChatShell` outlives the stream, so the messages have to be passed up —
`onLeave(messages)` rather than `onLeave()`. An upward pass, but unavoidable here; the
official pattern does the same.

**2. A connection indicator** — a green/red dot with `Connected` / `Disconnected` in the
header bar that already exists.

**3. Show Leave only while `isLoading`.** Leaving when nothing is running does nothing
useful — "New conversation" is the action wanted then. Same reasoning already applied to
Stop.

**What we already match:** synchronous storage read, `key={mountKey}` remount on rejoin,
shell owns `threadId` while the child owns `useStream`, New conversation clears storage.

**What we deliberately do differently:** we use `localStorage` (survives tab close) where
they use `sessionStorage`; and we keep Leave inside the chat rather than using their
`onControlsChange` effect to hoist controls into the header.

Reference: `/Users/dangphuonganh/dev/join-rejoin/packages/frontend/src/patterns/join-rejoin/preview.tsx`

---

## Not built yet

- `GUIDE.md` 8.2 — message queue
- `GUIDE.md` 8.4 — time travel UI (the data is already fetched in §8)
- `/orchestrate` — deep agent, subagent cards, sandbox panel
- Deployment to Vercel + LangSmith
