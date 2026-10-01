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

/** How long isLoading must stay false before a run counts as finished. */
const RUN_END_SETTLE_MS = 250;

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

  /**
   * False from the moment a run starts until the refresh that follows it lands.
   *
   * Without this the transcript swaps to branch history the instant a run ends, while
   * that history still describes the PREVIOUS branch — so a forked reply appears, then
   * the old one flashes back, then the new one returns. Measured at 2027 -> 1273 -> 1232
   * characters on a retry.
   */
  const [historyFresh, setHistoryFresh] = useState(true);

  // Live checkpoint ids. getHistory only refreshes when a run ends, so without this
  // the branch tree is stale for the whole duration of a response.
  const checkpointEvents = useChannel(stream, ["checkpoints"], undefined, {
    replay: false,
  }) as unknown as CheckpointsEvent[];

  /**
   * Newest checkpoint id seen on the wire. `replay: false` means the event buffer can
   * clear before the next history refresh, so the id is kept in a ref.
   */
  const lastStreamCheckpointId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const id = latestCheckpointId(checkpointEvents);
    if (id) lastStreamCheckpointId.current = id;
  }, [checkpointEvents]);

  /** Set when a fork starts: the next refresh moves the view onto the new branch. */
  const selectForkHead = useRef(false);

  /**
   * True from the moment a fork is submitted until the refresh that follows it.
   *
   * A fork REPLAYS the branch, so every interrupt the stream emits during that window
   * is a re-run of a decision already made. Trusting the stream there flashed a dead
   * approval card for ~4s. An interrupt the forked run genuinely raises still appears:
   * it pauses the run, which triggers the refresh, which clears this flag.
   */
  const [forkInFlight, setForkInFlight] = useState(false);

  /**
   * Messages as they stood at the fork point.
   *
   * Starting a fork run makes useStream rebuild its list from that checkpoint, so
   * `stream.messages` collapses to a handful of entries for ~50ms before refilling.
   * Rendering that directly makes the whole transcript flash. The state at the fork
   * point is the part that cannot change, so hold it until the stream passes it.
   */
  const [forkPrefix, setForkPrefix] = useState<BaseMessage[] | null>(null);

  const markFork = useCallback(
    (forkFromId: string) => {
      selectForkHead.current = true;
      setForkInFlight(true);
      const state = history.find((h) => h.checkpoint?.checkpoint_id === forkFromId);
      const raw = (state?.values as { messages?: unknown } | undefined)?.messages;
      setForkPrefix(
        Array.isArray(raw) ? raw.map((m) => coerceMessageLikeToMessage(m as BaseMessageLike)) : null,
      );
    },
    [history],
  );

  const refreshHistory = useCallback(async () => {
    if (!threadId) {
      setHistory([]);
      return;
    }
    try {
      const states = (await stream.client.threads.getHistory(threadId, {
        limit: 100,
      })) as HistoryState[];
      setHistory(states);
      setHistoryFresh(true);
      setForkInFlight(false);

      // A fork creates a lineage that `activeBranch` does not name. Left alone, the old
      // path no longer matches a fork item and getBranchView falls back to a different
      // sibling — the transcript jumps to the wrong branch for a frame. Follow the fork.
      if (selectForkHead.current) {
        selectForkHead.current = false;
        const target =
          lastStreamCheckpointId.current ?? latestCheckpointId(checkpointEvents) ?? undefined;
        lastStreamCheckpointId.current = undefined;
        const branch = findBranchForCheckpoint(target, states);
        if (branch != null) setActiveBranch(branch);
      }
    } catch {
      setHistory([]);
    }
  }, [stream.client, threadId, checkpointEvents]);

  /**
   * Fire when a run ENDS — not on mount, not per streamed token.
   *
   * `isLoading` flickers true -> false -> true while a fork run starts up, so a plain
   * falling edge fires mid-fork: it cleared forkPrefix and refreshed history at the one
   * moment the transcript needed them. Wait for the signal to settle instead.
   */
  const refreshRef = useRef(refreshHistory);
  useEffect(() => {
    refreshRef.current = refreshHistory;
  }, [refreshHistory]);

  const wasLoading = useRef(false);
  useEffect(() => {
    if (stream.isLoading) {
      wasLoading.current = true;
      setHistoryFresh(false);
      return;
    }
    if (!wasLoading.current) return;

    const timer = setTimeout(() => {
      wasLoading.current = false;
      setForkPrefix(null);
      void refreshRef.current();
    }, RUN_END_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [stream.isLoading]);

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
   * Whether an approval is pending ON THE BRANCH IN VIEW, read from the checkpoint.
   *
   * The docs say `stream.interrupt` resets to null "as the agent resumes streaming".
   * A fork is not a resume, so after Edit or Retry the stream keeps an interrupt the
   * server has no task for: an approval card renders and locks the composer over
   * nothing, until a reload rehydrates from the checkpoint and clears it.
   *
   * The checkpoint is the documented home of an interrupt, and getHistory already
   * carries it on `tasks[].interrupts` -- so this costs no extra request, and it is
   * branch-aware, which `stream.interrupt` is not.
   */
  const pendingOnBranch = useMemo(() => {
    const tasks = branchContext.threadHead?.tasks;
    if (!Array.isArray(tasks)) return false;
    return tasks.some((task) => (task?.interrupts?.length ?? 0) > 0);
  }, [branchContext.threadHead]);

  /**
   * null means "do not second-guess the stream": a live run, or history that has not
   * caught up yet. Suppressing then would hide a genuine, freshly raised approval.
   */
  const approvalPending: boolean | null = forkInFlight
    ? false
    : stream.isLoading || !historyFresh
      ? null
      : pendingOnBranch;

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
    selectMessages: (streamMessages: BaseMessage[]) => {
      // Floor first: isLoading is false for part of the fork, so gating on it would let
      // the collapsed list through exactly when the prefix exists to prevent it.
      if (forkPrefix && streamMessages.length < forkPrefix.length) return forkPrefix;
      if (stream.isLoading) return streamMessages;
      // History still describes the branch we just left; keep what the stream delivered.
      if (!historyFresh) return streamMessages;
      return branchMessages.length === 0 ? streamMessages : branchMessages;
    },
    /** Branch info for one message. */
    metadataFor,
    /** Pass as `forkFrom` on a NEW message so it stays on the viewed branch. */
    branchTipCheckpointId,
    activeBranch,
    switchBranch,
    refreshHistory,
    /** false = the branch tip has no interrupt, so any retained one is stale. */
    approvalPending,
    /** Call right before submitting a fork so the view follows the new branch. */
    markFork,
  };
}

/** Newest checkpoint id in a batch of channel events. */
function latestCheckpointId(events: CheckpointsEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const id = events[i]?.params?.data?.id;
    if (typeof id === "string") return id;
  }
  return undefined;
}

/**
 * Which branch path contains a checkpoint.
 *
 * getBranchContext only reports checkpoints on the branch it was asked about, so this
 * walks outwards: start at the default branch, and queue every sibling it names until
 * the checkpoint turns up.
 */
function findBranchForCheckpoint(
  checkpointId: string | undefined,
  history: HistoryState[],
): string | undefined {
  if (!checkpointId) return undefined;

  const queue = [""];
  const seen = new Set(queue);

  while (queue.length > 0) {
    const branch = queue.shift()!;
    const { branchByCheckpoint } = getBranchContext(branch, history);

    const found = branchByCheckpoint[checkpointId];
    if (found != null) return found.branch ?? branch;

    for (const data of Object.values(branchByCheckpoint)) {
      for (const option of data.branchOptions ?? []) {
        if (!seen.has(option)) {
          seen.add(option);
          queue.push(option);
        }
      }
    }
  }

  return undefined;
}
