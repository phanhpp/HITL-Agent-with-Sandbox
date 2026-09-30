# Lessons from porting a LangGraph UI to Next.js

Non-obvious things found by hitting them, not by reading about them. Each one cost
time or produced a wrong first attempt.

## Next.js

**A `"use client"` component is still rendered on the server.** The directive means
"hydrate this in the browser", not "run only in the browser". So `window`,
`localStorage` or `Date.now()` in a `useState` initializer still executes during
SSR. Guard it:

```ts
if (typeof window === "undefined") return FALLBACK;
```

This was the single hard blocker when porting from Vite, where
`agent-config.ts` read `window.location` at module scope.

**Only `NEXT_PUBLIC_*` env vars reach the browser.** Everything else is read from
`process.env` at request time and is never inlined. Verified by building with
`LANGSMITH_API_KEY=SENTINEL_…` and grepping: the value appeared in zero files under
`.next/`. Corollary: never prefix a secret with `NEXT_PUBLIC_`.

**A `next.config` rewrite cannot add headers.** If the upstream needs auth, you need
a route handler, not a rewrite. That is the entire reason
`app/api/langgraph/[...path]/route.ts` exists.

**Route handler `params` is a Promise** (Next 15+): `const { path } = await ctx.params`.
Next 16 also has a global `RouteContext<'/api/foo/[...path]'>` helper for typing it.

**Next ships its own docs inside the package** — `node_modules/next/dist/docs/` — and
writes an `AGENTS.md` telling you to read them because the installed version may
differ from what you remember. Reading them caught the `params` change above.

**Next rewrites your `tsconfig.json` on first boot**: sets `jsx: "react-jsx"` and
adds `.next/dev/types` to `include`. Let it.

**Streaming through a route handler**: return `new Response(upstream.body, …)`
without awaiting it, forward `last-event-id` so a dropped SSE stream can resume, and
set `cache-control: no-transform` plus `x-accel-buffering: no` so nothing batches
events. Forwarding a request body needs `duplex: "half"`.

## React

**Hooks cannot go inside a `.map()`.** Anything per-item that needs a hook — here
`useMessageMetadata(stream, message.id)` — has to become a child component.

**An effect with no dependency array is sometimes correct.** The instinct is to
narrow the deps. For a streaming chat, tokens grow the last message's *text* while
`messages.length` stays the same, so keying autoscroll on the message count stops it
mid-response. The real bug was different: it force-scrolled even when the user had
scrolled up. Fixed with a "only if already near the bottom" ref, keeping the
no-dep-array effect.

**A broken flex height chain kills scrolling silently.** `flex-1` means nothing to a
child of a block element. A layout of `body h-dvh flex flex-col` → `main flex-1
min-h-0` → `ChatContainer flex-1 min-h-0` looks right and does not work: `main` is a
block, so `ChatContainer` has no height bound, grows past the viewport, and the inner
`overflow-y-auto` never gets a constrained height to scroll within. No error, nothing
in the console — the page just will not scroll. `main` needs `flex flex-col` too.
When a scroll container does nothing, walk the chain upward and find the first
ancestor that is not a flex parent.

**`useState(Date.now())` is a hydration bug.** Server and client run the initializer
at different moments, so they render different values. Seed from a prop and set the
clock in `useEffect`.

## LangChain / LangGraph

**The server will tell you a graph's real state schema.** `GET /assistants/{id}/schemas`
is a standard endpoint, derived from the Python type hints, and includes fields that
middleware added:

```bash
curl -s localhost:2024/assistants/search -X POST \
  -H 'content-type: application/json' -d '{"limit":10}'
curl -s localhost:2024/assistants/<assistant_id>/schemas | python3 -m json.tool
```

Useful as a probe when you do not know what a middleware contributes. Not worth
generating types from unless the UI actually reads those fields.

**Raw HTTP is snake_case; `useStream` is camelCase.** The interrupt payload over the
wire is `action_requests` / `review_configs` / `allowed_decisions`, and a resume takes
`edited_action`. `useStream` converts both directions, so components read
`actionRequests` while `curl` tests must use snake_case. Confusing exactly once.

**You do not declare agent state.** `create_agent` supplies langchain's `AgentState`
(only built-in field: `messages`). Middleware adds keys to it; deepagents'
`DeepAgentState` extends it. Declare a TypeScript interface only for what the UI
renders.

**Persisting a thread id is not optional, and the order matters.** A run continues
server-side after the user navigates away or reloads, so holding the thread id in
component state throws away a live conversation. Store it (`localStorage`) and
remount with it — `useStream` rehydrates from `thread.getState()`, which it exposes
as `hydrationPromise` / `isThreadLoading`.

The subtle part is WHEN you read storage. Reading it in an effect leaves the first
render with `threadId = null`, and a reload then starts an empty conversation. The fix
is to read it **synchronously in the `useState` initializer**, as `GUIDE.md` 8.3 does —
which under Next means the component must never server-render, because `localStorage`
does not exist there:

```tsx
// PageClient.tsx — "use client"; dynamic() only works from a client component
const ChatShell = dynamic(() => import("@/components/ChatShell"), { ssr: false });

// ChatShell.tsx — now legal, because this never renders on the server
const [threadId, setThreadId] = useState(() => localStorage.getItem(key));
```

The other half of 8.3 is that the shell **never unmounts**: its `threadId` sits
untouched while the chat is left and rejoined, and only the child owning `useStream` is
torn down and rebuilt. Keying the child on the thread id is not the same thing.

(An earlier version of this note blamed `useStream` for overwriting the stored id on
mount. That was wrong — `GUIDE.md:2549` is explicit that mounting with `threadId: null`
is expected, and `onThreadId` fires when the *server* assigns an id, after a submit. The
defect was the asynchronous read.)

And when this breaks, check the client before the backend. `langgraph dev` and
LangSmith Deployment both supply a checkpointer, so server-side persistence already
works — confirmed by fetching `/threads/<id>/state` and getting the full message list
back from a graph that passes no `InMemorySaver`. A graph you compile yourself is the
only case that needs one.

**Trust the installed `.d.ts` over any prose.** Written docs lag the package. Things
that had changed under a guide written one minor version earlier: `forkFrom` is a
plain string, `SubmissionQueueEntry` uses `values`/`createdAt` (not
`input`/`enqueuedAt`), the field is `nodeName` not `nodeId`, `reconnectOnMount` no
longer exists, and `HttpAgentServerAdapter`'s `threadId` became optional.

**Scoped selector hooks open ref-counted server subscriptions.**
`useMessages(stream, subagent)` subscribes while mounted, so a page of expanded
cards opens one each. Mount them only when the card is actually open.

**`create_agent` returns a LangGraph graph.** `type(agent)` is
`langgraph.graph.state.CompiledStateGraph`, a `Pregel` subclass. So "we're using
langchain, not LangGraph" is not a real distinction — langchain's agents *are*
LangGraph graphs, and anything `langgraph-api` does to a `Pregel` applies to them.

**Who owns the checkpointer depends on who runs the graph**, and the LangChain docs
only show one of the two cases.

| How the graph runs | Checkpointer |
| --- | --- |
| `agent.invoke()` in a script or your own FastAPI app | **You pass one.** No checkpointer, no memory — the case the docs show |
| Registered in `langgraph.json`, served by `langgraph-api` (`langgraph dev`, LangSmith Deployment, or your own `langgraph build` container) | **The server owns it.** Pass none |

Verified both directions: `human_in_the_loop.py` passes no `checkpointer=` and
`agent.checkpointer` is `None`, yet a served thread remembered a name across two
separate HTTP runs and `/threads/<id>/state` returned the full message list.

Passing one anyway is worse than redundant, per `langgraph_api/graph.py:819`: locally
the server **refuses to start** — "persistence is handled automatically by the
platform … and will be ignored when deployed" — and in a deployment it is silently
ignored.

**Self-hosting is not a reason to add one.** `langgraph build` ships the same
`langgraph-api` server, so it still manages checkpoints wherever it runs; point it at
your own database with the **`POSTGRES_URI`** env var. The graph stays identical
across `langgraph dev`, LangSmith and your own container. The lever is configuration,
not code.

**`langgraph.json` can mount your own HTTP routes**: `"http": {"app": "./http_app.py:app"}`.
That is how you expose something the graph protocol does not cover — a sandbox file
tree, for instance — and it ships inside the deployed image.

## Tooling

**A git repo at `$HOME` captures everything below it.** `hitl-py` had no `.git`, so
every `git` command there was operating on `/Users/<me>/.git` — a 5.7 GB repo of
unrelated files, which also happened to be corrupt. Check
`git rev-parse --show-toplevel` before trusting `git status` in a new project.

**macOS has no `timeout`.** Use `curl --max-time` instead.

**A venv's `pip` can carry a stale shebang** pointing at wherever it was created.
`python -m pip` always works.

## Chat interface patterns

Reusable decisions for any agent chat UI, with the mechanism behind each.

**`isLoading` means "generating right now", not "this thread is busy".** It is driven by
root lifecycle events: `running` → true, **every terminal phase** → false — and an
interrupt is a terminal phase. So during a pending approval `isLoading` is false. Do not
use it to mean "a run is in progress on this thread"; for that, check for an interrupt
or query the thread.

**Show Stop only while `isLoading`.** Three iterations landed here:

| Attempt | Result |
| --- | --- |
| Always mounted, `disabled={!isLoading}` | Reads as broken — clicking a greyed button does nothing and says nothing |
| Rendered only when `isLoading` | Correct, but flashes for ~2s on a fast agent |
| Always mounted + visible disabled style + `title` explaining | Honest, still barely usable on a fast page |

Conditional render is the right default: a control that cannot act should not be
present. It becomes genuinely useful on a page where runs last minutes. The alternative
worth considering is the conventional one — make the composer's Send button *become*
Stop while streaming, so it is always in the same place with no dead state.

**Stop does not un-send what the model already produced.** `stream.stop()` sets
`isLoading` false immediately client-side, then cancels server-side via
`runs.cancel(threadId, runId, wait?, action?)` — where `action` defaults to
`"interrupt"` and `wait` is not set. So the typing indicator vanishes at once while an
in-flight LLM call can still finish and write its result to the checkpoint. The reply
arriving after you pressed Stop is expected, not a bug. `action: "rollback"` discards
the run's writes instead, but `StreamStopOptions` only exposes `cancel?: boolean`, so
reaching it means calling `stream.client.runs.cancel(...)` directly with the run id.

**`stream.stop()` may not cancel anything — verify it does.** On the protocol transport
(`POST /commands` + `/stream/events`) the SDK's stop is:

```js
// langgraph-sdk/dist/stream/controller.js:911
if (options?.cancel ?? true) {
  const runId = this.#activeRunId;                       // undefined on this transport
  if (threadId != null && runId != null) try {
    await client.runs.cancel(threadId, runId);
  } catch {}                                             // failures are swallowed
}
await this.#submitter.stop();                             // only this actually runs
```

`#activeRunId` is set by an internal `notifyCreated` that does not fire here, so the
guard fails, **no cancel request is sent**, and `stop()` silently degrades to
`disconnect()`: the browser detaches while the agent keeps generating. The symptom is
exactly "the typing indicator disappears but the full reply still arrives".

Diagnose it by looking at the server log rather than the client — clicking Stop
produced zero `/runs/{id}/cancel` requests, which is what pinned it down:

```bash
grep -i cancel agent-dev.log
```

Work around it by finding the run yourself:

```ts
const runs = await stream.client.runs.list(threadId, { limit: 10 });
const active = runs.find((r) => r.status === "pending" || r.status === "running");
if (active) await stream.client.runs.cancel(threadId, active.run_id, true, "interrupt");
await stream.stop({ cancel: false });   // then just detach
```

`wait: true` means you do not report "stopped" before the server has acted.

**Cancel cannot undo a run that already finished.** Tested both actions against a
completed run: `interrupt` and `rollback` both leave the reply in the thread, because
there is nothing left to cancel. `rollback` only discards the writes of a run still in
progress. So on a page where replies take two seconds, Stop is almost never useful —
by the time the button is clickable the message is committed. It earns its place where
runs last minutes.

**Four controls that are easy to conflate.** Name them by what they do to the thread:

| Control | Effect |
| --- | --- |
| **Stop** | Cancels the active run. Thread and messages stay. |
| **Leave** | Detaches the client, run **keeps going**. Literally `stop({ cancel: false })`. |
| **New conversation** | Abandons the thread (clears the stored id). |
| **Reject** | Answers a pending approval. Not a cancel. |

**Edit-and-re-run, the way users expect it.** Every message carries the checkpoint from
just *before* it existed, as `useMessageMetadata(stream, id)?.parentCheckpointId`. To
edit: replace the bubble with a textarea, then
`stream.submit({ messages: [new HumanMessage(text)] }, { forkFrom })`. To regenerate an
answer: `stream.submit(undefined, { forkFrom })` — `undefined`, not `{}`. Gate both on
`!forkFrom || stream.isLoading`, because editing mid-stream races the run. Nothing is
deleted: the old branch stays in checkpoint history, so the thread becomes a tree.

**Attach an interrupt's UI to the turn it belongs to, not to the end of the thread.**
The easy version renders approval cards in one block after the message list:

```tsx
{messages.map(...)}
{pending && <ApprovalCards />}          // always at the bottom
```

That looks correct only while the reviewed turn happens to be the last one. Fork the
thread, or send another message, and the card detaches from the tool call it is actually
reviewing — it appears under an unrelated turn. Match the pending action to its message
and render it in place:

```tsx
const pendingIndex = useMemo(() => {
  if (!requests.length) return -1;
  const names = new Set(requests.map((r) => r.name));
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (AIMessage.isInstance(m) && (m.tool_calls ?? []).some((tc) => names.has(tc.name)))
      return i;
  }
  return -1;
}, [requests, messages]);
```

Keep a bottom fallback for `pendingIndex === -1`, or an interrupt that matches nothing
in view is swallowed and the user can never answer it. The same reasoning applies to
anything anchored to a turn — tool cards, subagent cards, a "stopped" marker: derive its
position from the message it describes, never from "latest".

**A stopped turn leaves a hole, so say so.** After a successful cancel the human message
persists with no reply after it. Render nothing and the thread silently shows a gap, and
the *next* answer looks like it arrived out of order — which reads as a message-ordering
bug rather than as a cancelled turn. Detect it (human message, no AI message following,
nothing running, no interrupt pending) and label it, with a "Run again" that forks from
that point.

**Pick a probe whose output must vary.** "Retry gives the same answer" looked like a
broken fork. It was a bad test: asking a model to "pick a random number" returns the
same number on repeated calls — four direct model calls with no graph gave `537`, `537`,
`537`, `737`. Use something whose phrasing must differ ("write a one-sentence story"),
and confirm mechanically rather than by eye — a real re-run grows the checkpoint count,
a replay does not.

**Hover controls need a `group` on the wrapper.** `opacity-0 group-hover:opacity-100`
does nothing unless an ancestor has `className="group"`. Add `focus-within:opacity-100`
too, or the buttons are unreachable by keyboard.

**Check token pairs before combining them.** A design system can define two tokens with
the same value in one theme. Here `--color-primary-dark` and `--color-text` are both
`#030710` in light mode, so `bg-primary-dark text-text` rendered an invisible button.
Copy the pairing an existing component already uses rather than composing a new one.

**A control that cannot act should be absent or explained, never silently dead.** A
`disabled` button with `opacity-40` still looks clickable. Either do not render it, or
give it a visible disabled treatment plus a `title` saying which state would enable it.

See also, in the React section above: autoscroll that respects the user scrolling up,
and why per-message hooks need a child component.
