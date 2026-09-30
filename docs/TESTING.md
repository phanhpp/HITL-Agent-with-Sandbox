# Manual test checklist — packages/web

There is no automated test suite yet, and every case below exists because it was a
real bug found by using the app. Run these after touching the chat surface.

Start both servers: `make dev-next` (agent :2024, web :4200), then open
`http://localhost:4200/approve`.

A one-line automated gate, worth running first every time:

```bash
cd packages/web && pnpm exec tsc --noEmit
```

---

## 1. HITL — approve, edit, reject

| Step | Expect |
| --- | --- |
| Click the preset prompt | Reply streams, then an approval card |
| **Approve** | Tool card shows `send_email` → `finished`, `"status": "sent"` |
| New thread, then **Edit** → change recipient → Save & Approve | Agent reports **your** values and does not re-send its own |
| New thread, then **Reject** with a reason | Tool did not run, reason surfaced, agent asks what to change |

While a card is pending, the composer must be **disabled** with the placeholder
"Please approve or reject the pending action...".

## 2. Approval card placement

*Was broken: cards rendered in a block after the whole message list, so they always
sat at the thread bottom and detached from the turn being reviewed.*

| Step | Expect |
| --- | --- |
| Trigger an approval | Card sits **directly under the reply that proposed it** |
| **Retry** that turn | Card reappears under the *new* reply, not at the bottom |
| Scroll up so the reviewed turn is off-screen | Card stays with its turn, not pinned to the end |

## 3. Rejoin (GUIDE.md 8.3)

*Was broken twice: thread id held in component state, then read asynchronously.*

| Step | Expect |
| --- | --- |
| Send a message, **reload** | Conversation returns |
| Navigate to `/` and back | Conversation returns |
| **Leave** | Chat replaced by a Rejoin panel |
| **Rejoin** | Same conversation returns |
| Trigger an approval, **Leave** while pending, Rejoin | Approval card still there |
| **New conversation** | Clears, and stays clear across a reload |

## 4. Stop

*Was broken: `stream.stop()` sends no cancel on this transport, so it only detached the
client while the agent kept generating.*

| Step | Expect |
| --- | --- |
| Ask for something long ("explain h3 indexing in 400 words"), click stop mid-stream | Text **stops growing**, cut off mid-sentence |
| Same, but click stop before any text appears | Under your message: `No reply — the agent was stopped` + **Run again** |
| Click **Run again** | Answer appears under that message, not at the bottom |
| Nothing running | Stop button is **absent**, not greyed |

Verify server-side that a cancel actually goes out — the bug was silent:

```bash
grep -i cancel /tmp/agent-dev.log | tail -3
```

## 5. Branching — Edit and Retry (GUIDE.md 8.1)

*Was broken: fork id came from `useMessageMetadata(...).parentCheckpointId`, which is
undefined for every message here, so both buttons stayed disabled.*

| Step | Expect |
| --- | --- |
| Hover a reply → **Retry** | Enabled, and re-runs that turn |
| Hover your own message → **Edit** → change text → Save & re-run | Re-runs from that point with the new text |
| While the agent is generating | Both disabled |

**Do not test with "pick a random number".** The model returns the same number on
repeated calls regardless of our code — verified with four direct model calls, no graph
involved (`537`, `537`, `537`, `737`). Use "write a one-sentence story about a cat",
where phrasing must differ.

To confirm a fork re-ran rather than replayed, check the checkpoint count grows:

```bash
curl -s -X POST localhost:2024/threads/<id>/history \
  -H 'content-type: application/json' -d '{"limit":100}' | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))'
```

## 6. Layout

*Was broken: `main` was not a flex container, so nothing scrolled.*

| Step | Expect |
| --- | --- |
| Send enough messages to overflow | Message area scrolls, nav stays put |
| Scroll up mid-response | **Not** yanked back to the bottom by the next token |
| Return to the bottom | Autoscroll resumes |

## 7. Contrast

*Was broken: `bg-primary-dark text-text` — both `#030710` in light mode, so the Rejoin
button was black on black.*

Check every button is readable in light mode, which is the default since nothing sets
the `.dark` class.

---

## Secrets check before any deploy

```bash
cd packages/web && ./node_modules/.bin/next build
grep -rl 'SENTINEL_OR_YOUR_KEY' .next/static/ || echo "clean"
```

Only `NEXT_PUBLIC_*` vars are inlined, so `LANGSMITH_API_KEY` should appear nowhere.
