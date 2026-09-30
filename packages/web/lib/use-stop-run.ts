"use client";

import { useCallback, useState } from "react";
import type { AnyStream } from "@langchain/react";
import { HumanMessage } from "langchain";

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
 * `action: "rollback"` — stop means undo the turn.
 *
 * The alternative, "interrupt", keeps the run's writes, INCLUDING the human message that
 * started the run. Stop before the model replies and that leaves an orphaned question in
 * the thread, and the next turn answers the orphan instead of the new message.
 * Reproduced: ask "h3 indexing in 300 words", stop before any reply, send "hey" — and
 * the agent explains H3, because the model is handed [human, human] and picks the
 * substantive one.
 *
 * Rollback discards the run's writes, so the thread goes back to how it was before you
 * asked — including your own question, which on its own feels like losing your input.
 *
 * So the question is captured here and handed back as `stoppedPrompt`, for the page to
 * render CLIENT-SIDE ONLY. That satisfies both halves of the problem: you still see what
 * you asked and can re-run it, while the model never sees it, because it is not in graph
 * state and cannot be read as an unanswered turn on the next request.
 *
 * Neither action can remove a reply from a run that already FINISHED — there is nothing
 * left to cancel by then.
 */
export function useStopRun(stream: AnyStream, threadId: string | null) {
  const [isStopping, setIsStopping] = useState(false);
  /** The question whose turn was rolled back, kept for display only. */
  const [stoppedPrompt, setStoppedPrompt] = useState<string | null>(null);

  const stopRun = useCallback(async () => {
    if (!threadId || isStopping) return;
    setIsStopping(true);

    // Capture before cancelling: rollback is about to remove it from the thread.
    const lastHuman = [...stream.messages].reverse().find((m) => HumanMessage.isInstance(m));
    const prompt = lastHuman?.text?.trim() || null;

    try {
      const runs = await stream.client.runs.list(threadId, { limit: 10 });
      const active = runs.find((r) => r.status === "pending" || r.status === "running");
      if (active) {
        await stream.client.runs.cancel(threadId, active.run_id, true, "rollback");
      }
    } catch {
      // Already finished, or the run vanished. Detaching below is still correct.
    } finally {
      // cancel: false — we just cancelled it ourselves; this only detaches the client.
      await stream.stop({ cancel: false });
      setStoppedPrompt(prompt);
      setIsStopping(false);
    }
  }, [stream, threadId, isStopping]);

  const clearStoppedPrompt = useCallback(() => setStoppedPrompt(null), []);

  return { stopRun, isStopping, stoppedPrompt, clearStoppedPrompt };
}
