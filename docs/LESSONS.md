# Lessons

Things found by hitting them. Each cost time or produced a wrong first attempt.

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
- Need auth on the upstream? Use a route handler, not a rewrite.

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

### Branching

**Fork ids come from history, not message metadata.**
- The guide uses `useMessageMetadata(stream, id)?.parentCheckpointId`.
- It is documented as undefined "when the message was observed without a paired checkpoint envelope" — and here it is undefined for **every** message, reload or not.
- Result: every Edit/Retry button silently disabled, with nothing in the console.
- `threads.getHistory()` is authoritative and always populated.

```ts
const states = await client.threads.getHistory(threadId, { limit: 100 });
const checkpoints = [...states].reverse();          // API returns newest first

// The checkpoint holding exactly `i` messages is the state just BEFORE message `i`,
// so resuming from it replays that turn. Last match wins: several checkpoints can
// share a count within one step.
function forkPointForMessage(checkpoints, i) {
  let id;
  for (const cp of checkpoints) {
    if ((cp.values?.messages?.length ?? 0) === i) id = cp.checkpoint?.checkpoint_id ?? id;
  }
  return id;
}
```

- Fetch it **once per thread**, in an effect keyed on `[threadId, stream.isLoading, stream.client]` — `isLoading` in the deps means it refreshes when a run *ends*, not on every streamed token.

**A fork branches, it does not delete.**
- `submit(input, { forkFrom })` moves the thread to a new branch.
- Old messages stay in `getHistory()`, they just stop appearing in `/state`.
- Verified: after forking, `/state` had 2 messages while history still held all 10 checkpoints including the dropped branch.
- That history is also what a `< 1/2 >` branch switcher would read. v1 ships no built-in one.

**The same data gives you time travel (8.4) almost free.**
- List the checkpoints, show `cp.next.join(", ") || "done"` and the message count.
- Resume with `submit({}, { forkFrom: cp.checkpoint.checkpoint_id })` — note the id is nested under `cp.checkpoint`, not top level.
- Resuming re-runs every step after that checkpoint, LLM calls included, so results differ.

**Regenerate submits `undefined`, not `{}`.**

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
