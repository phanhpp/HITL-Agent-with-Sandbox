"use client";

import { useEffect, useState } from "react";
import type { AnyStream } from "@langchain/react";
import type { ThreadState } from "@langchain/langgraph-sdk";

/**
 * The thread's checkpoints, oldest first. Basis for time travel (GUIDE.md 8.4) and
 * for branching (8.1).
 *
 * Why not per-message metadata: `useMessageMetadata(...).parentCheckpointId` is
 * documented as undefined "when the message was observed without a paired checkpoint
 * envelope", and in this setup it is undefined for every message — so gating fork
 * buttons on it disabled them permanently. History is authoritative and always
 * present: `POST /threads/{id}/history` returns one entry per graph step with its
 * checkpoint id.
 */
export function useCheckpoints(stream: AnyStream, threadId: string | null) {
  const [checkpoints, setCheckpoints] = useState<ThreadState[]>([]);

  useEffect(() => {
    if (!threadId) {
      setCheckpoints([]);
      return;
    }
    // Refresh when a run ENDS, not per streamed token: isLoading in the deps means
    // this fires twice per run (start and finish) rather than hundreds of times.
    if (stream.isLoading) return;

    let cancelled = false;
    stream.client.threads
      .getHistory(threadId, { limit: 100 })
      .then((states) => {
        // The API returns newest first; show and search oldest first.
        if (!cancelled) setCheckpoints([...states].reverse());
      })
      .catch(() => {
        if (!cancelled) setCheckpoints([]);
      });

    return () => {
      cancelled = true;
    };
  }, [threadId, stream.isLoading, stream.client]);

  return checkpoints;
}

/** Number of messages recorded at a checkpoint. */
function messageCount(cp: ThreadState): number {
  const values = cp.values as { messages?: unknown[] } | undefined;
  return values?.messages?.length ?? 0;
}

/**
 * The checkpoint id to fork from in order to re-run message `index`.
 *
 * A checkpoint holding exactly `index` messages is the state just BEFORE that
 * message existed, so resuming from it replays that turn. Returns undefined when no
 * such checkpoint exists (nothing to fork from).
 */
export function forkPointForMessage(
  checkpoints: ThreadState[],
  index: number,
): string | undefined {
  // Last match wins: several checkpoints can share a message count within one step,
  // and the latest is the closest point before the next message is written.
  let id: string | undefined;
  for (const cp of checkpoints) {
    if (messageCount(cp) === index) id = cp.checkpoint?.checkpoint_id ?? id;
  }
  return id;
}

export type { ThreadState };
