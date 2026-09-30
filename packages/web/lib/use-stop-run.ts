"use client";

import { useCallback, useState } from "react";
import type { AnyStream } from "@langchain/react";

/** Written into the thread to close a turn the user stopped before any reply. */
export const STOPPED_MARKER = "_(stopped by the user)_";

/**
 * Actually stop the agent.
 *
 * Two problems, both verified against the running server.
 *
 * 1. `stream.stop()` sends no cancel on this transport. Its implementation
 *    (langgraph-sdk/dist/stream/controller.js:911) only cancels when an internal
 *    `#activeRunId` is set, and that is populated by a `notifyCreated` which does not
 *    fire on the protocol transport this app uses (`POST /commands` + `/stream/events`
 *    rather than `/runs/stream`). So the guard fails, no request goes out, and stop()
 *    silently degrades to disconnect(): the browser detaches while the agent keeps
 *    generating. Confirmed by grepping the agent log — clicking Stop produced zero
 *    `/runs/{id}/cancel` requests. So we find the run and cancel it ourselves.
 *
 * 2. A cancelled turn can poison the next one. `action: "interrupt"` keeps the run's
 *    writes, including the human message that started it. Stop before the model replies
 *    and the thread holds a dangling question — the next turn then hands the model
 *    `[human, human]` and it answers the DANGLING one. Reproduced: ask "h3 indexing in
 *    300 words", stop before any reply, send "hey", and the agent explains H3.
 *
 *    `action: "rollback"` avoids that but deletes the user's own question, which reads
 *    as losing their input. So instead we keep "interrupt" and close the turn with a
 *    short assistant message. The question stays visible, a partial reply is kept, and
 *    the model sees a completed turn so it answers the next request. Verified: the
 *    thread reads human / "(stopped by the user)" / human "hey" / "Hey! How can I help",
 *    which is the wanted behaviour.
 *
 * Note neither action can remove a reply from a run that already FINISHED — there is
 * nothing left to cancel by then, so on a fast reply Stop is a no-op.
 */
export function useStopRun(stream: AnyStream, threadId: string | null) {
  const [isStopping, setIsStopping] = useState(false);

  const stopRun = useCallback(async () => {
    if (!threadId || isStopping) return;
    setIsStopping(true);
    try {
      const runs = await stream.client.runs.list(threadId, { limit: 10 });
      const active = runs.find((r) => r.status === "pending" || r.status === "running");
      if (active) {
        // wait: true so we do not report "stopped" before the server has acted.
        await stream.client.runs.cancel(threadId, active.run_id, true, "interrupt");
      }

      // Did the stop leave a question with no answer? Read the server, not the client:
      // the client still holds whatever it streamed before the cancel landed.
      const state = await stream.client.threads.getState(threadId);
      const messages = (state.values as { messages?: { type?: string }[] })?.messages ?? [];
      const last = messages.at(-1);

      if (last?.type === "human") {
        // Close the turn so the next request is the one the model answers.
        await stream.client.threads.updateState(threadId, {
          values: { messages: [{ type: "ai", content: STOPPED_MARKER }] },
        });
      }
    } catch {
      // Run already finished, or the thread vanished. Detaching below is still right.
    } finally {
      // cancel: false — we already cancelled; this only detaches the client.
      await stream.stop({ cancel: false });
      setIsStopping(false);
    }
  }, [stream, threadId, isStopping]);

  return { stopRun, isStopping };
}
