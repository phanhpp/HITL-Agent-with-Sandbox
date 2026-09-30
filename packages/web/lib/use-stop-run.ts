"use client";

import { useCallback, useState } from "react";
import type { AnyStream } from "@langchain/react";

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
 * `action: "interrupt"` keeps whatever the model already produced; "rollback" would
 * discard the run's writes instead. Note neither can remove a reply from a run that
 * already finished — there is nothing left to cancel by then.
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
        await stream.client.runs.cancel(threadId, active.run_id, true, "interrupt");
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
