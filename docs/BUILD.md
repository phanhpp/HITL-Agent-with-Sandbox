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
9. [The sandbox panel](#9-the-sandbox-panel-orchestrate)
10. [File map](#10-file-map)
11. [Running and testing](#11-running-and-testing)

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

### The stream says an interrupt happened, never that it stopped mattering

`stream.interrupt` resets to null *"as the agent resumes streaming"*. A resume is
`submit(null, { command: { resume } })`. **A fork is `submit(undefined, { forkFrom })`,
which is not a resume** — so after Edit or Retry the stream keeps an interrupt the
thread has no task for, and a dead approval card locks the composer until a reload.

Measured at the same instant:

| Server `/threads/{id}/state` | UI |
|---|---|
| `next: []`, `tasks: []` — nothing pending | "Review Required", composer locked |

A reload cleared it, which is the clue: `useStream` rehydrates the interrupt from the
**thread checkpoint**, and the checkpoint had none.

So the checkpoint decides *whether* an approval is pending; the stream only supplies
*what* it contains. `getHistory()` already carries it on `tasks[].interrupts`, so this
costs no extra request — and it is branch-aware, which `stream.interrupt` is not:

```ts
// lib/use-branching.ts — threadHead is the tip of the branch on screen
const pendingOnBranch = (branchContext.threadHead?.tasks ?? [])
  .some((task) => (task?.interrupts?.length ?? 0) > 0);

const approvalPending: boolean | null = forkInFlight
  ? false                                 // a fork replays decisions already made
  : stream.isLoading || !historyFresh
    ? null                                // live run: do not second-guess the stream
    : pendingOnBranch;                    // idle: the checkpoint is the truth
```

The three states are the whole design. `false` only once we have actually checked;
`null` means "do not suppress", so a freshly raised approval is never hidden.

`forkInFlight` earns its place: gating on the checkpoint alone still flashed the card
for ~4s, because during the run the verdict is `null`. An interrupt the forked run
genuinely raises still appears — pausing *is* a run end, which triggers the refresh that
lifts the suppression.

This also fixed a second bug: the card followed the stream, not the branch, so switching
to a branch where an approval really was pending showed nothing.

### How `useBranching` and `useHitl` work together

Think of `useBranching` as the **database manager** and `useHitl` as the **UI card
renderer**.

The problem they solve between them:

- `useHitl` knows how to render the Approve / Reject card. But it gets its information
  from `useStream`, which has a terrible memory — it gets stuck remembering old
  approvals from minutes ago.
- `useBranching` reads the official checkpoint history. It knows with certainty whether
  a real approval is waiting **right now, on the active branch**.

So `ApproveChat` chains them rather than letting `useHitl` guess:

```
               ┌──────────────────────────────┐
               │         useBranching         │
               │  (reads checkpoint history)  │
               └──────────────┬───────────────┘
                              │ one signal:
                              │ approvalPending (true / false / null)
                              ▼
               ┌──────────────────────────────┐
               │           useHitl            │
               │     (renders the UI card)    │
               └──────────────────────────────┘
```

**Step 1 — `useBranching` evaluates the checkpoint.** It looks at the snapshot at the tip
of the branch on screen (`threadHead`) and sets one flag:

| `approvalPending` | Meaning |
|---|---|
| `false` | Checked, or a fork is running: there is **no** pending approval. Overrule the stream. |
| `true` | The checkpoint confirms an approval **is** waiting. |
| `null` | Don't second-guess the stream — either the agent is typing live, **or** history has not caught up yet. |

That third row is why a genuinely new approval is never hidden: until a refresh has
actually landed, the hook refuses to claim there is nothing pending.

**Step 2 — `useHitl` uses the flag as an on/off switch.** It still takes the card's
*contents* from the stream, but checks the flag before rendering:

```ts
// lib/use-hitl.ts
const stale = approvalPending === false;
const requests      = stale ? [] : (request?.actionRequests ?? []);
const reviewConfigs = stale ? [] : (request?.reviewConfigs  ?? []);
```

In one sentence: **`useBranching` is a light switch, and `useHitl` only turns the
"Review Required" card on when the switch is flipped.**

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
`components/ForkControls.tsx` — `GUIDE.md` 8.1

Edit re-runs from just before your message; Retry re-runs the same turn. Both need one
thing: **the checkpoint id to restart from**.

### 8.1 Where checkpoints come from

`GUIDE.md` reads `useMessageMetadata(…)?.parentCheckpointId`. It is `undefined` for
every message here, so both buttons sit disabled. Not a missing checkpointer —
`checkpoints` is a stream channel that is **not in the default stream modes**, so no
message ever arrives paired with one.

| Source | Gives | Updates |
|---|---|---|
| `threads.getHistory()` | full states, each with `parent_checkpoint` | only when we ask |
| `useChannel(["checkpoints"])` | live ids, `{ id, parent_id }` only | during a run |

Both are needed. History is the only source with `parent_checkpoint`, but refetching per
token would be a request per token — so it refreshes **when a run ends**
(`lib/use-branching.ts:70`), which leaves a whole reply's worth of staleness. The
channel (`:52`) covers that window.

### 8.2 Merging live events into history

`getBranchContext()` takes **one list, newest first**. Live ids become temporary
**synthetic states** and are merged with the server's records — `lib/use-branching.ts:86`:

```
┌───────────────────────────────────────────────────────────┐
│ 1. Index server history in a Map, keyed by checkpoint_id  │
└─────────────────────────────┬─────────────────────────────┘
┌─────────────────────────────▼─────────────────────────────┐
│ 2. Loop channel events. Skip any id already in the Map    │
└─────────────────────────────┬─────────────────────────────┘
┌─────────────────────────────▼─────────────────────────────┐
│ 3. Turn each new id into a bare state: ids only, values:{}│
│    unshift it, so live stays newest-first like history    │
└─────────────────────────────┬─────────────────────────────┘
┌─────────────────────────────▼─────────────────────────────┐
│ 4. return [...synthetic, ...history]                      │
└───────────────────────────────────────────────────────────┘
```

```
[LIVE SYNTHETIC]  cp_21d0aa ──► parent: cp_347745   values: {}
[LIVE SYNTHETIC]  cp_347745 ──► parent: cp_06cdd9   values: {}    ← joins here
[SERVER HISTORY]  cp_06cdd9 ──► parent: cp_e7ce15   2 messages
[SERVER HISTORY]  cp_e7ce15 ──► parent: cp_946419   1 message
[SERVER HISTORY]  cp_946419 ──► parent: NONE        0 messages
```

The halves are not matched by position or time. They join because the oldest synthetic
state's `parent_id` is a checkpoint history already holds — parent pointers make it one
chain.

**Self-healing.** When the run ends, `refreshHistory()` returns those ids as real states
with messages; step 2 then skips them and the synthetic copies vanish.

**Why `values: {}` is fine, and where it isn't.** The tree builder reads only
`checkpoint` and `parent_checkpoint`, so a switcher appears while the agent is still
typing. But anything reading messages must skip them — `branchMessages` scans back for
the newest state with a **non-empty** `messages` array (`:181`), or the transcript
blanks mid-run.

### 8.3 How fork points are derived

1. Walk history **oldest → newest** for the first snapshot the message appears in.
   `getHistory()` is newest-first, so that means iterating from the end of the array
   (`lib/use-branching.ts:132`).
2. Read that snapshot's `parent_checkpoint.checkpoint_id`.
3. That parent is the conversation **just before the message existed**.

```
Snapshot      Parent        Messages in snapshot
──────────    ──────────    ────────────────────────────────
cp_946419     (none)        0  — thread created
cp_e7ce15     cp_946419     1  — human prompt
cp_06cdd9     cp_e7ce15     2  — human prompt + AI reply
```

The AI reply first appears in `cp_06cdd9`, whose parent is `cp_e7ce15` — the state
holding only the question. Retry submits `forkFrom: "cp_e7ce15"`.

This replaced counting messages to guess the fork point, which needed an off-by-one rule
*and* a tie-break, and failed silently when either was wrong.

### 8.4 What `getBranchContext` gives back

Pure function, fetches nothing (`lib/use-branching.ts:117`). `activeBranch` is the only
input that changes the result.

| Return | What it is | Feeds |
|---|---|---|
| `flatHistory` | active branch's states, oldest first | the transcript (`:181`) |
| `threadHead` | `flatHistory.at(-1)`, the branch tip | `forkFrom` on new messages (`:123`) |
| `branchByCheckpoint` | `checkpoint → { branch, branchOptions }` | the switcher (`:148`) |

`branchOptions.length > 1` is the entire condition for showing `‹ Branch 1/2 ›`, so an
unforked thread renders no control (`BranchSwitcher.tsx:23`). Every message below a fork
shares the same options, so they are deduped to one switcher per fork (`:153`).

### 8.5 Two things that break silently

**The transcript must follow the branch.** `stream.messages` is whatever was streamed
last and does not track `activeBranch` — skip this and the switcher moves while the text
does not:

```ts
// lib/use-branching.ts:202 — live while running, branch history when idle
stream.isLoading || branchMessages.length === 0 ? streamMessages : branchMessages
```

**New messages must anchor to the branch on screen.** `submit(input)` appends to the
thread's *latest* checkpoint, so typing on an older branch jumps the turn to the newest
one. Pass the tip (`ApproveChat.tsx:104`):

```tsx
void stream.submit({ messages: [new HumanMessage(text)] }, { forkFrom: tip });
```

Verified: on a branch whose dog chased squirrels, "what was the dog chasing?" answered
*squirrels* — the sibling branch's story has no chasing in it.

### 8.6 Why the transcript flashed during a fork

Retry made the message list jump four times in 100ms, collapsing from 1026 to 307
characters before refilling. Three separate causes, found by sampling the DOM every
16ms:

| Cause | Fix |
|---|---|
| `isLoading` flickers true -> false -> true as a fork starts, because an interrupt is a terminal phase. The plain falling edge fired mid-fork and cleared state the transcript needed. | Wait `RUN_END_SETTLE_MS` for the signal to settle before treating a run as finished. |
| A fork makes `useStream` rebuild its list from the fork point, so `stream.messages` briefly holds **one** message. | Capture the fork point's messages as a floor and render those until the stream passes it. Checked **before** `isLoading`, which is false for part of that window. |
| At run end the transcript swapped to branch history before the refresh landed, showing the branch just left — measured as `2027 -> 1273 -> 1232`. | `historyFresh`: hold the stream's messages until a refresh lands. |

Result on a plain chat thread: the transcript holds steady through the first second,
where it previously changed four times.

The reference pattern cannot help here — its graph has no interrupts, so it never sees
the `isLoading` flicker. Confirmed by running the same Retry on a thread with no tool
call, where the transcript never collapsed at all.

### 8.6 Three things worth knowing

- **A fork branches, it does not delete.** Old messages stay in `getHistory()`, they
  only leave `/state`.
- **`/state` and the UI can legitimately disagree.** `/state` is the thread head, the UI
  is the branch you are on. Dump the history tree before assuming a stale client.
- **Reload lands on the SDK's default branch**, not the one you were viewing —
  `activeBranch` is component state and nothing persists it. The official pattern does
  the same. The switcher gets you back.

Deriving the transcript from branch history also retired the `reconnect()` remount after
a fork. It survives for Stop (§7), where the client really does hold state the server
has discarded.

---

## 9. The sandbox panel (`/orchestrate`)

The coder subagent writes to a real machine, not to graph state, so its files cannot be
read from `stream.values`. Three things follow from that, and each is the answer to a
bug that was watched happening.

### The diff baseline belongs on the machine

The obvious design is to keep a copy of every file in the page and compare. Don't. That
copy lives in React state, so it dies on reload — and the failure is silent in the worst
way: the page re-reads the files, has nothing to compare against, adopts the **already
edited** versions as the "before", and shows no changes at all.

The sandbox commits its workspace at seed time instead (`ensure_git_baseline`). The page
remembers nothing and asks:

| Question | Route |
|---|---|
| what changed? | `GET /sandbox/{id}/changes` — `git diff --numstat HEAD` + untracked |
| what did this file look like before? | `GET /sandbox/{id}/file?rev=baseline` — `git show HEAD:<path>` |
| make this the new before | `POST /sandbox/{id}/baseline`, on submit |

A commit cannot be lost by a browser, and git gets created and deleted files right,
which comparing two maps of contents does badly.

### Watch the subagent's stream, not the root one

`stream.messages` is the **root** conversation. It contains the supervisor's "delegate
this" call and nothing else about it — the coder's actual `edit_file` happens inside the
subagent, in its own namespace, and never appears there. Watch only the root list and
the panel never moves.

To see the coder's own tool calls you ask for that namespace:

```tsx
const toolCalls = useToolCalls(stream, subagent);
```

`useToolCalls` opens a subscription to that one subagent and keeps it open for as long
as the component calling it stays mounted. `SandboxWatcher` exists to be that component.

**And that is still not enough on its own.** The subscription only delivers events from
the moment it opens, and it cannot open until the subagent has been *discovered* — the
component is not rendered before then. On a short run the coder is discovered and
finished almost at once, so the subscription starts after everything already happened
and receives nothing at all. Measured: a 17.9s run edited a file on disk, the agent
reported success, and the watcher saw zero events.

So the refresh has two triggers, and they cover different cases:

| Trigger | Covers |
|---|---|
| `useToolCalls(stream, subagent)` | updates *during* long work, file by file |
| the subagent's `status` changing | everything else — it is a plain value on a snapshot, so there is no subscription to start too late |

### Count round trips, on both sides

Each `execute` into a sandbox costs roughly a second. `/changes` answers every question
in one shell invocation; asking five separately made the panel appear five seconds late.

On the client, the tree and the change list are fetched **in parallel**, and a file's
contents only when it is opened. An earlier version downloaded the whole workspace on
mount — needed only so the browser could diff, which it no longer does — and that is
what made returning to the page slow.

Three smaller things that cost time to find: repeated GETs to an unchanging URL are
served from the browser cache, so every sandbox read passes `cache: "no-store"`;
`langgraph dev` rejects blocking calls inside async handlers, so the sync SDK client goes
through `asyncio.to_thread`; and `@pierre/diffs` renders into a **shadow root**, so
`innerHTML` looks empty when the component is working perfectly.

---

## 10. File map

| File | Lines | Role |
|---|---|---|
| `app/api/langgraph/[...path]/route.ts` | 114 | The proxy (§2) |
| `app/layout.tsx` | 36 | Nav + `h-dvh flex flex-col` shell |
| `app/approve/page.tsx` | 11 | Server wrapper, exports `metadata` |
| `features/approve/ApproveClient.tsx` | 23 | `dynamic(ssr:false)` boundary (§3) |
| `features/approve/ApproveChat.tsx` | 321 | The page: `useStream`, messages, cards |
| `components/ChatShell.tsx` | 138 | Thread id, rejoin, remount (§4) |
| `components/ApprovalCard.tsx` | 302 | Approve / edit / reject UI |
| `components/ToolCallCard.tsx` | 58 | Tool call + result (§6) |
| `components/ForkControls.tsx` | 154 | Edit / Retry buttons + editor (§8) |
| `lib/use-hitl.ts` | 129 | Decisions, both interrupt locations (§5) |
| `lib/use-stop-run.ts` | 75 | Real cancel + close the turn (§7) |
| `lib/use-branching.ts` | 393 | History → fork points, branch tree (§8) |
| `components/BranchSwitcher.tsx` | 50 | `‹ Branch 1/2 ›` control (§8) |
| `lib/agent.ts` | 41 | SSR-safe URL, graph names |
| `lib/state.ts` | 45 | `AgentState` for `useStream<T>` |
| `features/orchestrate/OrchestrateChat.tsx` | — | The deep-agent page, and the layout switch (§9) |
| `lib/use-sandbox-files.ts` | — | Tree, changes and contents over HTTP (§9) |
| `components/panels/SandboxTree.tsx` | — | The workspace tree, expansion lifted out of the rows |
| `components/panels/CodeViewer.tsx` | — | Code / diff tabs, `@pierre/diffs`, lazy-loaded |
| `components/panels/ChangedFiles.tsx` | — | `M`/`A`/`D` with git's own line counts |
| `components/layout/IdeView.tsx` | — | Three columns; the middle one only when a file is open |
| `lib/use-color-scheme.ts` | — | Shiki needs a theme *name*, so it cannot use `dark:` |

Everything under `components/chat/` and `components/cards/` was copied from
`packages/frontend` with `"use client"` added where needed.

---

## 11. Running and testing

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
