# Lessons

Things found by hitting them. Each cost time or produced a wrong first attempt.

All of these are already fixed in this repo — the point is not to rediscover them on the
next project. Most fail silently, which is why they cost time.

---

## Next.js

**`"use client"` still renders on the server.**
- It means "hydrate this", not "browser only".
- `window` / `localStorage` / `Date.now()` in a `useState` initializer runs during SSR.
- Guard: `if (typeof window === "undefined") return FALLBACK;`
- Or skip SSR entirely: `dynamic(() => import("./X"), { ssr: false })` — must be called from a client component.

**Only `NEXT_PUBLIC_*` reaches the browser.**
- Everything else is read from `process.env` at request time, never inlined.
- Verified: built with `LANGSMITH_API_KEY=SENTINEL_…`, found in zero files under `.next/`.
- Never prefix a secret with `NEXT_PUBLIC_`.

**A `next.config` rewrite cannot add headers.**
- A rewrite is a forwarding rule — `{ source, destination }` in config. No code runs.
- Fine for plain proxying. Cannot add auth, read env per request, or shape the response.
- Anything conditional needs a route handler (`route.ts`), which is a real function.

**Route handlers (Next 15+).**
- `params` is a Promise: `const { path } = await ctx.params`.
- Next 16 has a global `RouteContext<'/api/foo/[...path]'>` for typing it.
- Streaming: return `new Response(upstream.body, …)` without awaiting.
- Forward `last-event-id` so a dropped SSE stream can resume.
- Set `cache-control: no-transform` and `x-accel-buffering: no`.
- Streaming a request body needs `duplex: "half"`.

**Next edits your files.**
- Rewrites `tsconfig.json` on first boot (`jsx: "react-jsx"`, adds `.next/dev/types`).
- Generates `AGENTS.md` telling you to read `node_modules/next/dist/docs/`. Do it — that is how the `params` change was caught.

---

## React

**Hooks cannot go in a `.map()`.**
- Per-item hooks need a child component.

**No dependency array is sometimes correct.**
- Streamed tokens grow the last message's *text* while `messages.length` stays the same.
- Keying autoscroll on message count stops it mid-response.
- Real bug was different: it scrolled even when the user had scrolled up. Fixed with a "only if near the bottom" ref.

**A broken flex chain kills scrolling silently.**
- `flex-1` means nothing to a child of a **block** element.
- `main` needs `flex flex-col`, not just `flex-1 min-h-0`.
- No error, no console warning — the page just will not scroll.
- Debug: walk up and find the first ancestor that is not a flex parent.

**`useState(Date.now())` is a hydration bug.**
- Server and client run the initializer at different moments.
- Seed from a prop, set the clock in `useEffect`.

**Check token pairs before combining them.**
- `--color-primary-dark` and `--color-text` are both `#030710` in light mode.
- `bg-primary-dark text-text` = invisible button.
- Copy the pairing an existing component already uses.

**Hover controls need `group` on the wrapper.**
- `opacity-0 group-hover:opacity-100` does nothing without it.
- Add `focus-within:opacity-100` or they are keyboard-unreachable.

---

## LangChain / LangGraph

**`create_agent` returns a LangGraph graph.**
- `type(agent)` is `CompiledStateGraph`, a `Pregel` subclass.
- "We use langchain, not LangGraph" is not a real distinction.

**You do not declare agent state.**
- `create_agent` supplies `AgentState`; the only built-in field is `messages`.
- Middleware adds keys. deepagents' `DeepAgentState` extends it.
- Declare a TypeScript interface only for what the UI renders.

**The server reports the real schema.**
```bash
curl -s localhost:2024/assistants/search -X POST \
  -H 'content-type: application/json' -d '{"limit":10}'
curl -s localhost:2024/assistants/<id>/schemas | python3 -m json.tool
```
- Derived from Python type hints, includes middleware-added fields.
- Useful as a probe. Not worth generating types from unless the UI reads them.

**Who owns the checkpointer depends on who runs the graph.**

| How it runs | Checkpointer |
|---|---|
| `agent.invoke()` in your own script or API | **You pass one** — the case the docs show |
| `langgraph.json` + `langgraph-api` (`dev`, LangSmith, your own container) | **The server owns it** — pass none |

- Passing one anyway: local server **refuses to start**; deployed it is ignored.
- Self-hosting is not a reason to add one — set `POSTGRES_URI` instead.

**Raw HTTP is snake_case; `useStream` is camelCase.**
- Wire: `action_requests`, `review_configs`, `edited_action`.
- Components read camelCase. `curl` tests must use snake_case.

**`threads/search` returns a stale `values` snapshot.**
- Use `/threads/{id}/state` for truth.
- They disagreed mid-debugging and search sent me the wrong way.

**Trust the installed `.d.ts` over prose.**
- Changed under a guide one minor version old: `forkFrom` is a string, `SubmissionQueueEntry` uses `values`/`createdAt`, the field is `nodeName` not `nodeId`, `reconnectOnMount` is gone, adapter `threadId` became optional.

**Scoped selector hooks open ref-counted subscriptions.**
- `useMessages(stream, subagent)` subscribes while mounted.
- Mount them only when the card is open.

**`langgraph.json` can mount your own HTTP routes.**
- `"http": {"app": "./http_app.py:app"}`, and it ships inside the deployed image.

---

## Reasoning (extended thinking)

**The config depends on the model, and the wrong one fails two different ways.**

| Model | `thinking=` |
|---|---|
| Haiku 4.5, and anything pre-4.7 | `{"type": "enabled", "budget_tokens": 2000}` |
| Sonnet 5, Opus 4.7+, Opus 5, Opus 5.5 | `{"type": "adaptive", "display": "summarized"}` |

- **Loud failure:** the budget form on a new model is a hard 400 — *"thinking.type.enabled is not supported for this model"*. `budget_tokens` was removed there; use `output_config.effort` (or `reasoning_effort=`) to control effort instead.
- **Silent failure:** on adaptive models `display` defaults to **`"omitted"`**. Leave it out and the call succeeds, costs the same, and returns **no reasoning blocks at all** — the UI just never shows a thinking bubble.
- With the budget form, **`max_tokens` must exceed `budget_tokens`**.
- Opus 5 / Sonnet 5 have adaptive thinking **on by default**; `{"type": "disabled"}` turns it off (Opus 5: only at `"high"` effort or below; Opus 5.5: cannot be disabled at all).

**Do not infer the form from the model name.** The real boundary is "pre-4.7" vs "4.6+" vs "4.7+", which no substring matches cleanly — Opus 4.6 takes `adaptive` but not `summarized`. Spell each model out:

```python
def _supervisor_model():                       # Sonnet 5
    return init_chat_model("anthropic:claude-sonnet-5",
        thinking={"type": "adaptive", "display": "summarized"}, max_tokens=8000)

def _worker_model():                           # Haiku 4.5
    return init_chat_model("anthropic:claude-haiku-4-5",
        thinking={"type": "enabled", "budget_tokens": 2000}, max_tokens=8000)
```

**The block is named differently depending on where you read it.**

| Where | Type |
|---|---|
| raw `content` — the wire, `/threads/{id}/state` | `thinking` |
| normalized `contentBlocks` | **`reasoning`** |

- Filtering raw `content` for `"reasoning"` silently matches nothing. Read `contentBlocks`.
- **`message.text` EXCLUDES reasoning** — it keeps only `type: "text"` blocks. A component rendering `msg.text` drops the whole thought process with no error.
- `redacted_thinking` normalizes to `non_standard`, not `reasoning`, so it is filtered out. Render nothing rather than a "reasoning hidden" notice.

```ts
// one helper, because both traps live here — packages/web/lib/reasoning.ts
message.contentBlocks
  .filter((b) => b.type === "reasoning")
  .map((b) => b.reasoning)
  .join("");
```

**Verify with a probe, not the docs.** All of the above was settled by one call per config and printing `r.content_blocks` types — expect `['reasoning', 'text']`. It also works alongside tools and interrupts: a run paused on an approval, resumed, and wrote its file with reasoning intact.

---

## Chat UI

### The client's message list goes stale — and nothing can force a re-read

- Cancel, fork, or write state directly → server moves on, browser keeps what it streamed.
- No public re-hydrate. Only lever: remount the component owning `useStream` (`GUIDE.md` 8.3.5).

```tsx
<Fragment key={mountKey}>{renderChat(...)}</Fragment>   // bump mountKey to rebuild
```

- Call it **after** a stop, and after a fork finishes.
- **Never mid-stream.**
- **Never key on `threadId`** — it goes `null → id` on the first submit, so the chat rebuilds mid-run and the stream is lost. Symptom: server has the full reply, UI shows nothing.

### Stop

**`stream.stop()` may send no cancel at all.**
- It only cancels when an internal `#activeRunId` is set, which never happens on the `/commands` + `/stream/events` transport.
- It silently becomes `disconnect()`.

```ts
const runs = await client.runs.list(threadId, { limit: 10 });
const active = runs.find((r) => r.status === "pending" || r.status === "running");
if (active) await client.runs.cancel(threadId, active.run_id, /* wait */ true, "interrupt");
```

- **Diagnose on the server:** `grep -i cancel agent-dev.log`. Zero hits = nothing was sent.
- **Cancel cannot undo a finished run.** On a 2-second reply Stop is a no-op.
- `isLoading` = "generating right now", not "busy". It is false during an interrupt. Show Stop only while it is true.

**A cancelled turn poisons the next one.**
- `interrupt` keeps the human message that started the run.
- The model then gets `[human, human]` and answers the **older** one.
- Do not `rollback` — that deletes the user's own question.
- Close the turn instead:

```ts
const last = (await client.threads.getState(threadId)).values?.messages?.at(-1);
if (last?.type === "human") {
  await client.threads.updateState(threadId, {
    values: { messages: [{ type: "ai", content: "_(stopped by the user)_" }] },
  });
}
```

### Branching (Edit and Retry)

**What these do.** Both re-run the graph from a point in the past instead of continuing from the end.
- **Edit** — change your message, re-run from just before it.
- **Retry** — re-run the same turn unchanged.
- Both need one thing: the id of the checkpoint to restart from.

**`getHistory()` is the thread's timeline.** One entry per graph step, each with the full state at that moment:

```
checkpoint_id     #msgs  next step
…eff1fa1fe0a4         4  done
…b72b3f01fe21         4  HumanInTheLoopMiddleware.after_model
…f3238d77dc57         3  model
…365493e02c1d         2  __start__
…260a0fc879f5         0  __start__      ← oldest
```

**`parentCheckpointId` is undefined — the cause is the stream config, not a missing checkpointer.**
- Checkpoints exist: `getHistory()` returns 15 for a thread with one fork.
- `useStream` can only fill it when a message arrives **paired with a checkpoint envelope**.
- `checkpoints` is a protocol channel, and the **default stream modes do not subscribe to it** — so no pairing ever reaches the client.
- Symptom: Edit and Retry permanently disabled, nothing in the console.
- Fix: subscribe explicitly.

```ts
useChannel(stream, ["checkpoints"], undefined, { replay: false })
```

**The exact fork point is already in history — do not count messages.**
- Every `ThreadState` carries `parent_checkpoint`.
- For a message: find the oldest state whose `values.messages` contains it; that state's `parent_checkpoint.checkpoint_id` is the checkpoint from just before the message existed. Pass it as `forkFrom`.
- The earlier version of this file told you to match on message count instead. That needs an off-by-one rule *and* a tie-break, and both fail silently — wrong turn re-run, no error.

**`getBranchContext(activeBranch, history)`** — from `@langchain/langgraph-sdk/ui`. Pure function over the checkpoint list, fetches nothing.

| gives you | what it is |
|---|---|
| `flatHistory` | states on the active branch, **oldest first** |
| `threadHead` | `flatHistory.at(-1)` — the branch tip |
| `branchByCheckpoint` | checkpoint → `{ branch, branchOptions }`; `branchOptions.length > 1` means show a `‹ 1/2 ›` switcher |
| `branchTree` | the whole fork tree |

**Switching branches must change the transcript too.**
- `stream.messages` is a single lineage — whatever was streamed last. It does **not** follow `activeBranch`.
- Render `threadHead.values.messages` when idle; keep `stream.messages` while `isLoading`, or the transcript freezes mid-reply.
- Symptom when missed: the switcher moves and the text does not.

**Anchor new messages to the branch on screen.**
- `submit(input)` with no options appends to the thread's **latest** checkpoint.
- So viewing an older branch and sending silently jumps the turn to the newest one.
- Pass `{ forkFrom: threadHead.checkpoint.checkpoint_id }`.
- Verified: on a branch whose story had the dog chasing squirrels, "what was the dog chasing?" answered "squirrels" — the other branch had no chasing in it.

**Refresh history when a run ENDS, not per token.** Edge-trigger it:

```ts
const wasLoading = useRef(false);
useEffect(() => {
  if (wasLoading.current && !stream.isLoading) void refreshHistory();
  wasLoading.current = stream.isLoading;
}, [stream.isLoading, refreshHistory]);
```

**Deriving messages from history removes the remount-after-fork workaround.**
- Previously a fork left the replaced reply lingering below the new one, fixed by remounting the chat.
- Once the transcript comes from branch history, it already matches the server. Keep the remount for Stop only.

**Reload lands on the SDK's default branch**, not the one you were viewing — `activeBranch` is component state and nothing persists it. Shared with the official pattern.

Implemented in `packages/web/lib/use-branching.ts`.

**A fork branches, it does not delete.**
- `submit(input, { forkFrom })` moves the thread to a new branch.
- Old messages stay in `getHistory()`, they just stop appearing in `/state`.
- So `/state` and the UI can legitimately disagree: `/state` is the thread head, the UI is the branch you are on. Not a bug — check the history tree before chasing it.

**The same data gives you time travel (8.4) almost free.**
- List the checkpoints, show `cp.next.join(", ") || "done"` and the message count.
- Resume with `submit({}, { forkFrom: cp.checkpoint.checkpoint_id })` — note the id is nested under `cp.checkpoint`, not top level.
- Resuming re-runs every step after that checkpoint, LLM calls included, so results differ.

**Regenerate submits `undefined`, not `{}`.**

### Interrupts

**A stream tells you an interrupt happened, never that it stopped mattering.**
- `stream.interrupt` resets to null only on a **resume** — `submit(null, { command: { resume } })`.
- A fork is `submit(undefined, { forkFrom })`. Not a resume. The reset never fires.
- Symptom: after Edit or Retry a dead approval card renders and locks the composer, and only a reload clears it.
- The reload is the clue — `useStream` rehydrates the interrupt from the **thread checkpoint**.

**Diagnose it by asking the server:**

```bash
curl -s localhost:2024/threads/<id>/state | python3 -m json.tool | head -20
```

- `next: []` and `tasks: []` while the UI shows a card = the client is holding a ghost.

**The checkpoint is the authority; the stream is only the delivery.**
- `getHistory()` entries carry `tasks[].interrupts` — same payload as `/state`, so no extra request if you already fetch history.
- It is also **branch-aware**. `stream.interrupt` is not: switch to a branch with a real pending approval and nothing renders.
- Use it as a **gate**, not a source: history is snake_case (`action_requests`), the stream is camelCase. Gating needs no mapping.

**Make the verdict three-valued, not boolean.**

| Value | Meaning |
|---|---|
| `false` | checked, nothing pending — suppress the retained interrupt |
| `null` | live run, or history not caught up — **do not** suppress, or a fresh approval is hidden |
| `true` | the branch tip really has one |

- During a fork, force `false`: a fork replays decisions already made.
- A real interrupt the forked run raises still appears — pausing *is* a run end, which triggers the refresh that lifts the suppression.

**Two gated actions arrive in two different shapes, and both render two cards.**

| What the agent did | Interrupts | `action_requests` each |
|---|---|---|
| two subagents, one gated tool each | 2 | 1 |
| one agent, two gated calls in one message | **1** | **2** |

**Shape 1 — never read `stream.interrupt` (singular).**
- It is documented as an alias for `interrupts[0]`, "when only one is pending".
- Measured: `/a.md` and `/b.md` both pending → one card shown, for `/b.md` → approving it wrote `/a.md`.
- Fix: read `stream.interrupts`, one card per entry, answer with `respondAll({ [id]: response })`.
- One `respondAll`, never two `respond()` calls — the first resume starts a run, the second has nothing to answer.

**Shape 2 — one interrupt is answered ONCE, with one decision per action.**
- `decisions` is positional over that interrupt's `action_requests`; there is no way to answer action 0 and leave action 1 open.
- So filling the array from a single click approves actions the user never clicked. Measured: approving card 1 of 2 wrote both files.
- Fix: stage each card's decision, send when every action in that interrupt has one. A one-action interrupt still sends on the first click.
- A decided card must *look* decided, or the page reads as a dead button.
- `Array.from({length: n}, …)`, never `arr.length = n` — setting `length` leaves sparse holes and `some`/`every` skip holes, so "fully decided" reports true on the first click.

**Read `stream.interrupts`, not `getThread()?.interrupts`.**

| | `stream.interrupts` | `getThread()?.interrupts` |
|---|---|---|
| nested / subagent pauses | mirrored in (every namespace) | yes |
| `namespace` for resume | present | present |
| after reload | rebuilt from `tasks[].interrupts` | **empty** |
| replayed history on rejoin | parked until server state confirms | included raw |

- The naming misleads: "root" means the root *snapshot the hooks read*, not the root namespace.
- Using the thread log as a fallback can only add cards the SDK deliberately withheld.

**An answered interrupt reappears after a reload, if others from the same step are still pending.**
- The step cannot close, so the checkpoint keeps every task — including the answered one.
- The client's "already answered" set is in-memory and does not survive the reload.
- Harmless: answering again is a server-side no-op (state unchanged, no second write, no failed request), and the card then clears.
- The server can tell them apart: the answered task has a populated `result`, the waiting one has `result: null`.
- Fixed in `lib/use-hitl.ts`: on each change to the pending set, read `client.threads.getState(threadId)` and drop any group whose task has a `result`.
- Safe by construction — the filter only removes, and `result` never reverts, so a late or failed check can never hide a live card.

### Sandbox file panel

**A diff baseline kept in page state is lost on every reload — and fails silently.**
- The reference implementation remembers every file as it was, then compares. That copy lives in React state.
- On reload the page re-reads the files, has nothing to compare against, adopts the ALREADY EDITED versions as the "before", and shows no changes at all.
- Nothing errors. The panel just looks like the agent did nothing.
- Fix: `git init` + a commit in the workspace. `git diff --numstat HEAD` for what changed, `git show HEAD:<path>` for the "before". A commit on the machine cannot be lost by a browser.
- It also handles created and deleted files, which comparing two maps of contents does badly.

**A subagent's tool calls are NOT in `stream.messages`.**
- The root list has the supervisor's `task` call, not the coder's `edit_file`.
- `useToolCalls(stream, subagent)` is the namespaced view; `status === "finished"` means the result landed.
- But a selector subscription only sees calls that arrive after it mounts, and it cannot mount until the subagent is discovered. A short run finishes before it exists: measured 17.9s, file changed on disk, zero watcher events.
- So watch the subagent's `status` too — a snapshot needs no subscription, so timing cannot defeat it. Use both: status for correctness, the subscription for live updates during a long run.

**Repeated GETs to the same URL are served from the browser cache.**
- Live state read through an unchanging URL comes back stale behind a 200, with nothing to indicate why. `cache: "no-store"`.

**Each `execute` is a round trip of about a second, so count them.**
- Change detection asked five questions in five calls; coming back to the page took 5s before the panel appeared. One shell invocation with marker lines between the sections: 1.0s.
- Same rule on the client: fetch the tree and the change list in parallel, and file contents only when a file is opened. Downloading the whole workspace up front was only ever needed to diff in the browser.

**`langgraph dev` rejects blocking calls inside async handlers.**
- A sync SDK client in an async route raises `BlockingError`. `asyncio.to_thread`. A Starlette `TestClient` will not reproduce it.

**Pierre renders into a shadow root.**
- `element.innerHTML` is empty and the component looks broken; the content is in `element.shadowRoot`.

### Transitions during a fork

**`isLoading` flickers true → false → true when a fork starts**, because an interrupt is a terminal phase.
- A plain falling edge fires mid-fork and tears down state the UI still needs.
- Wait for it to settle (~250ms) before calling a run finished.

**A fork makes `useStream` rebuild its list from the fork point**, so `messages` briefly holds one entry.
- Rendering that collapses the whole transcript.
- The fork point's own messages cannot change — keep them as a floor until the stream passes it.
- Check the floor **before** `isLoading`, which is false for part of that window.

**Do not swap to history the instant a run ends.** It still describes the branch you left — measured as 2027 → 1273 → 1232 characters. Hold the streamed messages until the refresh lands.

**Measure it, do not eyeball it.** Hash the transcript every 16ms and record only changes:

```js
setInterval(() => {
  const t = document.querySelector('main').innerText;
  if (t !== last) samples.push({ ms: performance.now(), len: t.length });
}, 16);
```

- Counting size changes turns "feels laggy" into 4 jumps in 56ms, with timestamps.
- A truncated sample is a useless probe: slicing to 200 characters hid a branch switch entirely, because the branches differ further down.

### Placement

- **Anchor per-turn UI to its turn, not the thread bottom.**
- Approval cards rendered after the list look right only while the reviewed turn is last.
- Fork, or send another message, and the card detaches from the tool call it reviews.
- Match the pending action to its message. Keep a bottom fallback so an unmatched interrupt is never unanswerable.

### Controls

| Control | Effect on the thread |
|---|---|
| **Stop** | Cancels the active run. Thread and messages stay. |
| **Leave** | Detaches the client, run **keeps going**. `stop({ cancel: false })`. |
| **New conversation** | Abandons the thread. |
| **Reject** | Answers a pending approval. Not a cancel. |

- A control that cannot act should be **absent**, not disabled-and-silent.

---

## Testing

- **Drive the real UI.** A written checklist found nothing for hours.
- Ten minutes of browser automation found a shipped regression: every new conversation rendered zero messages while the server held a full reply.
- `curl` proves the API. Only the browser proves the app.
- **Pick a probe whose output must vary.** "Retry gives the same answer" looked like a broken fork — it was a bad test. Four direct model calls returned `537`, `537`, `537`, `737`. Use "write a one-sentence story", and confirm mechanically: a real re-run grows the checkpoint count.

---

## Tooling

- **A git repo at `$HOME` captures everything below it.** Check `git rev-parse --show-toplevel` before trusting `git status` in a new project.
- **macOS has no `timeout`.** Use `curl --max-time`.
- **A venv's `pip` can carry a stale shebang.** `python -m pip` always works.
