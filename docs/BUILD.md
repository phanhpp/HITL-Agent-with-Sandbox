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

## 8. Branching: Edit, Retry, and the branch switcher

**Files:** `lib/use-branching.ts`, `components/BranchSwitcher.tsx`,
`components/ForkControls.tsx` — `GUIDE.md` 8.1, plus the official `branching-chat`
pattern

Edit and Retry both re-run the graph from a point in the past:

- **Edit** — change your message, re-run from just before it.
- **Retry** — re-run the same turn unchanged.

Each needs exactly one input: **the id of the checkpoint to restart from**. Everything
below exists to produce that id, and then to make a forked thread navigable.

### 8.1 Why `parentCheckpointId` is undefined

`GUIDE.md` 8.1 reads the fork point straight off the message:

```ts
useMessageMetadata(stream, msg.id)?.parentCheckpointId
```

Here that is `undefined` for **every** message, so both buttons sit permanently
disabled with nothing in the console.

It is not a missing checkpointer — checkpoints exist, and `getHistory()` returns 15 of
them for a thread with one fork. The cause is narrower:

- `useStream` can only fill that field when a message arrives **paired with a checkpoint
  envelope**.
- Pairing comes from the `checkpoints` stream channel.
- `checkpoints` is **not in the default stream modes**, so it never arrives.

Two ways out: subscribe to the channel, or read the checkpoints yourself. This repo does
both, because they are good at different things.

### 8.2 Three sources, and why each one is needed

| Source | Gives | Updates |
|---|---|---|
| `stream.messages` | the text on screen | every streamed token |
| `threads.getHistory()` | full states, each with `parent_checkpoint` | only when we ask |
| `useChannel(["checkpoints"])` | ids of checkpoints being written **right now** | during a run |

Why not `getHistory()` alone:

- It is the **only** source carrying `parent_checkpoint`, so the fork point must come
  from it.
- But refetching per token would be a request per token.
- So it is refreshed **when a run ends** — which leaves the whole duration of a reply
  with a stale tree.

Why not the channel alone:

- Channel events carry `{ id, parent_id }` and nothing else. No messages, no state.
- Enough to know a fork happened; not enough to render it.

They cover each other's gap. The channel is the live edge, history is the durable truth.

```ts
// lib/use-branching.ts:52 — the channel is opt-in; this is the subscription
const checkpointEvents = useChannel(stream, ["checkpoints"], undefined, {
  replay: false,          // ids already in getHistory would arrive twice
});
```

```ts
// lib/use-branching.ts:70 — edge-triggered: fire when a run ENDS, not per token
const wasLoading = useRef(false);
useEffect(() => {
  if (wasLoading.current && !stream.isLoading) void refreshHistory();
  wasLoading.current = stream.isLoading;
}, [stream.isLoading, refreshHistory]);
```

`stream.isLoading` in a dependency array is the trick: compare it to its previous value
and you get a "run finished" event out of a boolean.

### 8.3 Merging the two into one checkpoint list

`getBranchContext` takes **one array**. So the channel's live ids have to be folded into
the list `getHistory()` returned. Four steps, all in `lib/use-branching.ts:86`.

**Step 1 — index what history already knows, by checkpoint id.**

```ts
const byId = new Map<string, HistoryState>();
for (const state of history) {
  const id = state.checkpoint?.checkpoint_id;
  if (id) byId.set(id, state);
}
```

**Step 2 — walk the channel events and skip anything already indexed.** This is the
whole dedupe; it is why the same checkpoint never appears twice.

```ts
for (const event of checkpointEvents) {
  const id = event?.params?.data?.id;
  if (typeof id !== "string" || byId.has(id)) continue;     // history wins
```

**Step 3 — a genuinely new id becomes a state built from the event alone.** The event
carries `{ id, parent_id }` and nothing else, so that is all there is to work with:

```ts
  const state = {
    values: {},                                              // no messages exist yet
    checkpoint:        { ...blank, checkpoint_id: id },
    parent_checkpoint: { ...blank, checkpoint_id: parentId },
    next: [], tasks: [],
  } as unknown as HistoryState;
  byId.set(id, state);
  synthetic.unshift(state);                                  // see ordering below
}
```

**Step 4 — concatenate, synthetic first.**

```ts
return [...synthetic, ...history];
```

#### Worked through one run

`getHistory()` was last fetched when the previous run ended. It returns **newest first**:

```
…06cdd9   parent …e7ce15   real   2 messages
…e7ce15   parent …946419   real   1 message
…946419   parent —         real   0 messages
```

The agent is now typing, and two `checkpoints` events have arrived on the wire, in the
order the server wrote them:

```
{ id: …347745, parent_id: …06cdd9 }        ← written first
{ id: …21d0aa, parent_id: …347745 }        ← written second
```

Neither id is in `byId`, so both become synthetic states. `unshift` puts each new one at
the front, which flips the wire order into newest-first — the same order `getHistory()`
uses. That is why step 4 can just concatenate:

```
…21d0aa   parent …347745   synthetic   values: {}
…347745   parent …06cdd9   synthetic   values: {}       ← joins here
…06cdd9   parent …e7ce15   real        2 messages
…e7ce15   parent …946419   real        1 message
…946419   parent —         real        0 messages
```

The merge works because of that middle line: the synthetic chain's oldest `parent_id`
(`…06cdd9`) is a checkpoint history already has. Parent pointers link the two halves
into one unbroken chain, and `getBranchContext` walks it without knowing or caring which
states came from where.

#### It heals itself when the run ends

`refreshHistory()` fires on the falling edge of `isLoading` (§8.2), and `…347745` and
`…21d0aa` come back as **real** states, this time with messages. On the next render
`byId.has(id)` is true for both, step 2 skips them, and the synthetic copies vanish.

So a synthetic state exists only in the window between "the server wrote this
checkpoint" and "we refetched history", which is exactly the window the channel exists
to cover.

#### Two consequences of `values: {}`

- **Fine for the tree.** `getBranchContext` reads only `checkpoint` and
  `parent_checkpoint`, so a fork shows up the moment it is written.
- **Not fine for messages.** Anything reading messages back out has to skip these, which
  is why `branchMessages` scans for the last state with a **non-empty** `messages` array
  rather than simply taking `threadHead` (`lib/use-branching.ts:181`). Taking the tip
  blindly would blank the transcript mid-run.

### 8.4 Where the fork point actually comes from

For each message, find the **oldest state whose `values.messages` contains it** — the
state where that message first appears. That state's `parent_checkpoint` is the
checkpoint from just *before* the message existed, which is precisely what `forkFrom`
wants.

```ts
// lib/use-branching.ts:132 — getHistory is newest-first, so iterate backwards
for (let i = history.length - 1; i >= 0; i -= 1) {
  const state = history[i];
  for (const message of state.values?.messages ?? []) {
    if (!message.id || result.has(message.id)) continue;   // oldest wins
    const parentCheckpointId = state.parent_checkpoint?.checkpoint_id;
    ...
  }
}
```

Worked through a real thread:

| checkpoint | parent | messages in that state |
|---|---|---|
| `…946419` | — | 0 |
| `…e7ce15` | `…946419` | 1 — the human message |
| `…06cdd9` | `…e7ce15` | 2 — human + AI reply |

- The AI reply first appears in `…06cdd9`.
- `…06cdd9.parent_checkpoint` is `…e7ce15` — the state holding only the question.
- Retry on that reply submits `forkFrom: "…e7ce15"`, and the server re-runs the model
  from there.

An earlier version of this file matched on message **count** instead. That is a
heuristic: it needs an off-by-one rule (message #3 is index 2, so look for the
checkpoint with 2 messages) *and* a tie-break (several checkpoints share a count within
one step, and the newest is the right one). Both fail silently — wrong turn re-run, no
error. The real pointer was in the payload the whole time.

### 8.5 `getBranchContext` — flat list to tree

```ts
// lib/use-branching.ts:117
const branchContext = useMemo(
  () => getBranchContext(activeBranch, checkpointHistory),
  [activeBranch, checkpointHistory],
);
```

From `@langchain/langgraph-sdk/ui`. **Pure** — it fetches nothing, it only reshapes the
array you hand it. `activeBranch` is a path string like `"<id>>…"`; `""` means "the
default lineage".

| Return | What it is | Used for | Where |
|---|---|---|---|
| `flatHistory` | states on the active branch, **oldest first** | rebuilding the transcript | `:181` |
| `threadHead` | `flatHistory.at(-1)` — the branch tip | anchoring new messages | `:123` |
| `branchByCheckpoint` | `checkpoint → { branch, branchOptions }` | the switcher | `:148` |
| `branchTree` | the whole fork tree | unused here | — |

`branchOptions` is the list of sibling lineages at that fork. `length > 1` is the entire
condition for showing a switcher, which is why `BranchSwitcher` returns `null` otherwise
(`components/BranchSwitcher.tsx:23`) and an unforked thread shows no control at all.

### 8.6 One switcher per fork, not one per message

Every message downstream of a fork shares the same `branchOptions`, so rendering the
control per message stacks duplicates. Dedupe on the option list
(`lib/use-branching.ts:153`):

```ts
const key = siblingBranches?.join(",");
if (key) {
  if (seenSiblingSets.has(key)) siblingBranches = undefined;   // already drawn
  else seenSiblingSets.add(key);
}
```

`ApproveChat.tsx:227` then renders `{switcher}` above both human and AI bubbles, and it
appears exactly once — at the fork.

### 8.7 Which messages to display

This is the step that is easy to skip, and skipping it makes branching look broken:
`stream.messages` is a **single lineage** — whatever was streamed last — and it does not
follow `activeBranch`. Clicking the switcher then moves the control and nothing else.

```ts
// lib/use-branching.ts:202
selectMessages: (streamMessages) =>
  stream.isLoading || branchMessages.length === 0 ? streamMessages : branchMessages,
```

- **While a run is in flight** — `stream.messages`, so tokens appear as they arrive.
- **When idle** — messages read back out of the active branch's newest state.

Both halves matter. Using branch history mid-run would freeze the transcript until the
next refresh; using `stream.messages` when idle is the bug above.

`ApproveChat.tsx:58` is the single call site: `const messages = branching.selectMessages(stream.messages)`.

### 8.8 Anchoring new messages to the branch on screen

`submit(input)` with no options appends to the thread's **latest** checkpoint. So
viewing an older branch and typing silently moves the turn to the newest branch instead.

```tsx
// ApproveChat.tsx:104
const tip = branching.branchTipCheckpointId;     // = threadHead's checkpoint id
void stream.submit(
  { messages: [new HumanMessage(text)] },
  tip != null ? { forkFrom: tip } : undefined,
);
```

Verified: on a branch whose story had a dog chasing squirrels, asking "what was the dog
chasing?" answered *squirrels* — the sibling branch's story has no chasing in it, so the
answer proves which lineage the model was given.

### 8.9 A fork branches, it does not delete

`submit(input, { forkFrom })` moves the thread to a new branch. The old messages stay in
`getHistory()`; they only stop appearing in `/state`.

A consequence worth knowing before debugging it: **`/state` and the UI can legitimately
disagree.** `/state` returns the thread head; the UI shows the branch you are on. Dump
the history tree before assuming the client is stale — this looks exactly like a stale
client and is not one.

Deriving the transcript from branch history also retired the workaround that used to
live here: a `reconnect()` remount after every fork, which existed only to stop the
replaced reply lingering below the new one. The view now matches the server by itself.
The remount survives for Stop (§7), where the client really does hold state the server
has discarded.

### 8.10 Known rough edge

Reloading lands on the SDK's default branch, not the one you were viewing —
`activeBranch` is component state and nothing persists it. The official pattern behaves
the same way. Nothing is lost; the switcher gets you back.

---

## 9. File map

| File | Lines | Role |
|---|---|---|
| `app/api/langgraph/[...path]/route.ts` | 114 | The proxy (§2) |
| `app/layout.tsx` | 36 | Nav + `h-dvh flex flex-col` shell |
| `app/approve/page.tsx` | 11 | Server wrapper, exports `metadata` |
| `features/approve/ApproveClient.tsx` | 23 | `dynamic(ssr:false)` boundary (§3) |
| `features/approve/ApproveChat.tsx` | 313 | The page: `useStream`, messages, cards |
| `components/ChatShell.tsx` | 138 | Thread id, rejoin, remount (§4) |
| `components/ApprovalCard.tsx` | 302 | Approve / edit / reject UI |
| `components/ToolCallCard.tsx` | 58 | Tool call + result (§6) |
| `components/ForkControls.tsx` | 154 | Edit / Retry buttons + editor (§8) |
| `lib/use-hitl.ts` | 117 | Decisions, both interrupt locations (§5) |
| `lib/use-stop-run.ts` | 75 | Real cancel + close the turn (§7) |
| `lib/use-branching.ts` | 212 | History → fork points, branch tree (§8) |
| `components/BranchSwitcher.tsx` | 50 | `‹ Branch 1/2 ›` control (§8) |
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
