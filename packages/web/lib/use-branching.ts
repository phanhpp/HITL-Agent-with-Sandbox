"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChannel, type AnyStream } from "@langchain/react";
import { getBranchContext } from "@langchain/langgraph-sdk/ui";
import { coerceMessageLikeToMessage, type BaseMessageLike } from "@langchain/core/messages";
import type { BaseMessage } from "langchain";
import type { ThreadState } from "@langchain/langgraph-sdk";

/**
 * Conversation branching: Edit and Retry, plus the data a branch switcher needs.
 *
 * Replaces lib/use-checkpoints.ts, which derived fork points by counting messages —
 * a heuristic with two failure modes (off by one, and ties when several checkpoints
 * hold the same count). Every ThreadState carries `parent_checkpoint`, so the exact
 * pointer was available all along.
 *
 * A hook rather than a context provider: the reference implementation uses a provider
 * because ITS provider owns useStream and MessageRow sits two levels below with no
 * stream prop. Here ApproveChat owns the stream and already passes it down one level,
 * so context would be ceremony. See docs/BUILD.md.
 *
 * Three sources, same as the reference:
 *   getHistory()                      official, persisted — refreshed when a run ENDS
 *   useChannel(["checkpoints"])       live checkpoint ids while the agent is typing
 *   (messages come from the caller's stream)
 */

type HistoryState = ThreadState<Record<string, unknown>>;

/** One `checkpoints` channel event. Not in the default stream modes. */
interface CheckpointsEvent {
  method: "checkpoints";
  params: { data?: { id?: string; parent_id?: string } };
}

export interface BranchInfo {
  /** Checkpoint just before this message. Pass to submit as `forkFrom`. */
  parentCheckpointId?: string;
  /** Branch this message sits on, per getBranchContext. */
  branch?: string;
  /** Every sibling lineage at this fork. Length > 1 means show a switcher. */
  siblingBranches?: string[];
}

export function useBranching(stream: AnyStream, threadId: string | null) {
  const [history, setHistory] = useState<HistoryState[]>([]);
  const [activeBranch, setActiveBranch] = useState("");

  // Live checkpoint ids. getHistory only refreshes when a run ends, so without this
  // the branch tree is stale for the whole duration of a response.
  const checkpointEvents = useChannel(stream, ["checkpoints"], undefined, {
    replay: false,
  }) as unknown as CheckpointsEvent[];

  const refreshHistory = useCallback(async () => {
    if (!threadId) {
      setHistory([]);
      return;
    }
    try {
      const states = await stream.client.threads.getHistory(threadId, { limit: 100 });
      setHistory(states as HistoryState[]);
    } catch {
      setHistory([]);
    }
  }, [stream.client, threadId]);

  // Edge-triggered: fire when a run ENDS, not on mount and not per streamed token.
  const wasLoading = useRef(false);
  useEffect(() => {
    if (wasLoading.current && !stream.isLoading) void refreshHistory();
    wasLoading.current = stream.isLoading;
  }, [stream.isLoading, refreshHistory]);

  // Load once when the thread is first known (rejoin, reload).
  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  /**
   * Official history plus synthetic states for checkpoints seen on the wire but not
   * yet saved. Synthetic states carry only ids and empty messages — enough for the
   * tree builder, and skipped when reading messages back out.
   */
  const checkpointHistory = useMemo(() => {
    const byId = new Map<string, HistoryState>();
    for (const state of history) {
      const id = state.checkpoint?.checkpoint_id;
      if (id) byId.set(id, state);
    }

    const synthetic: HistoryState[] = [];
    for (const event of checkpointEvents) {
      const id = event?.params?.data?.id;
      if (typeof id !== "string" || byId.has(id)) continue;
      const parentId = event.params?.data?.parent_id;
      const blank = { thread_id: "", checkpoint_ns: "", checkpoint_id: "" };
      const state = {
        values: {},
        next: [],
        checkpoint: { ...blank, checkpoint_id: id },
        metadata: undefined,
        created_at: undefined,
        parent_checkpoint:
          typeof parentId === "string" ? { ...blank, checkpoint_id: parentId } : undefined,
        tasks: [],
      } as unknown as HistoryState;
      byId.set(id, state);
      synthetic.unshift(state);
    }

    return [...synthetic, ...history];
  }, [checkpointEvents, history]);

  /** Pure function over the checkpoint list — fetches nothing. */
  const branchContext = useMemo(
    () => getBranchContext(activeBranch, checkpointHistory),
    [activeBranch, checkpointHistory],
  );

  /** Tip of the branch on screen. New messages anchor here, or they jump to "latest". */
  const branchTipCheckpointId = branchContext.threadHead?.checkpoint?.checkpoint_id;

  /**
   * message id -> fork point and branch info.
   *
   * For each message, find the oldest state whose values.messages contains it — the
   * state where it first appears — and take that state's parent_checkpoint. That is
   * the exact checkpoint from just before the message existed.
   */
  const metadataByMessageId = useMemo(() => {
    const result = new Map<string, BranchInfo>();
    const seenSiblingSets = new Set<string>();

    for (let i = history.length - 1; i >= 0; i -= 1) {
      const state = history[i];
      const values = state.values as { messages?: { id?: string }[] } | undefined;
      for (const message of values?.messages ?? []) {
        const id = message?.id;
        if (!id || result.has(id)) continue;

        const parentCheckpointId = state.parent_checkpoint?.checkpoint_id;
        if (!parentCheckpointId) continue;

        const checkpointId = state.checkpoint?.checkpoint_id;
        const branchData = checkpointId
          ? branchContext.branchByCheckpoint[checkpointId]
          : undefined;

        // One switcher per fork, not one per message sharing that fork.
        let siblingBranches = branchData?.branchOptions;
        const key = siblingBranches?.join(",");
        if (key) {
          if (seenSiblingSets.has(key)) siblingBranches = undefined;
          else seenSiblingSets.add(key);
        }

        result.set(id, { parentCheckpointId, branch: branchData?.branch, siblingBranches });
      }
    }

    return result;
  }, [history, branchContext.branchByCheckpoint]);

  const metadataFor = useCallback(
    (messageId: string | undefined): BranchInfo => metadataByMessageId.get(messageId ?? "") ?? {},
    [metadataByMessageId],
  );

  /**
   * Messages on the active branch, rebuilt from checkpoint history.
   *
   * Without this, switching branches changes `activeBranch` but the transcript still
   * shows whatever the stream last delivered — the switcher moves and nothing else
   * does. Observed before this was added.
   *
   * Takes the LAST checkpoint that actually holds messages: synthetic states carry
   * empty values and must be skipped.
   */
  const branchMessages = useMemo<BaseMessage[]>(() => {
    const flat = branchContext.flatHistory;
    for (let i = flat.length - 1; i >= 0; i -= 1) {
      const values = flat[i]?.values as { messages?: unknown } | undefined;
      const raw = values?.messages;
      if (!Array.isArray(raw) || raw.length === 0) continue;
      // getHistory stores content as the raw block array, which coerce accepts as-is.
      return raw.map((m) => coerceMessageLikeToMessage(m as BaseMessageLike));
    }
    return [];
  }, [branchContext.flatHistory]);

  const switchBranch = useCallback((branch: string) => {
    setActiveBranch(branch === "main" ? "" : branch);
  }, []);

  return {
    /**
     * What to render. Live messages while streaming — branch history lags until the
     * next refresh, and using it mid-run would freeze the transcript.
     */
    selectMessages: (streamMessages: BaseMessage[]) =>
      stream.isLoading || branchMessages.length === 0 ? streamMessages : branchMessages,
    /** Branch info for one message. */
    metadataFor,
    /** Pass as `forkFrom` on a NEW message so it stays on the viewed branch. */
    branchTipCheckpointId,
    activeBranch,
    switchBranch,
    refreshHistory,
  };
}
