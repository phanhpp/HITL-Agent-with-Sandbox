"use client";

import { useCallback, useState } from "react";
import type { AnyStream } from "@langchain/react";
import { AIMessage } from "langchain";

/**
 * Actually stop the agent.
 *
 * `stream.stop()` does not work on this transport. Its implementation
 * (langgraph-sdk/dist/stream/controller.js:911) is:
 *
 *     if (options?.cancel ?? true) {
 *       const runId = this.#activeRunId;
 *       if (threadId != null && runId != null) try {
 *         await client.runs.cancel(threadId, runId);
 *       } catch {}
 *     }
 *     await this.#submitter.stop();
 *
 * `#activeRunId` is only set by an internal `notifyCreated`, which does not fire on
 * the protocol transport this app uses (`POST /commands` + `/stream/events` rather
 * than `/runs/stream`). So the guard fails, no cancel request is ever sent, and
 * stop() silently degrades to disconnect(): the browser detaches while the agent
 * keeps generating. Verified by grepping the agent server's log — clicking Stop
 * produced zero `/runs/{id}/cancel` requests.
 *
 * So we find the run ourselves and cancel it, then detach locally.
 *
 * `wait: true` means we do not report "stopped" before the server has acted.
 *
 * The cancel ACTION is chosen per case, because the wrong one causes a real bug:
 *
 *   "interrupt" keeps the run's writes — including the human message that started it.
 *   If the model had not replied yet, that leaves an orphaned question in the thread,
 *   and the NEXT turn answers the orphan instead of the new message. Reproduced: ask
 *   "h3 indexing in 300 words", stop before any reply, send "hey" — and the agent
 *   explains H3, because the model is handed [human, human] and picks the substantive
 *   one.
 *
 *   "rollback" discards the run's writes, so the orphan disappears and the thread is
 *   clean. But it would also throw away a half-written reply.
 *
 * So: rollback when nothing was produced, interrupt when there is a partial reply worth
 * keeping. Neither can remove a reply from a run that already finished — there is
 * nothing left to cancel by then.
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
        // Is there already a reply worth keeping? Read the client's view: the last
        // message being an AI message with text means the model produced something.
        const last = stream.messages.at(-1);
        const hasPartialReply =
          last !== undefined && AIMessage.isInstance(last) && last.text.trim().length > 0;

        await stream.client.runs.cancel(
          threadId,
          active.run_id,
          true,
          hasPartialReply ? "interrupt" : "rollback",
        );
      }
    } catch {
      // Already finished, or the run vanished. Detaching below is still correct.
    } finally {
      // cancel: false — we just cancelled it ourselves; this only detaches the client.
      await stream.stop({ cancel: false });
      setIsStopping(false);
    }
  }, [stream, threadId, isStopping]);

  return { stopRun, isStopping };
}
