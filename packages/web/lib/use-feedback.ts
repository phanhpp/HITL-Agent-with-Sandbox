"use client";

/*
 * Thumbs up/down on an answer, recorded against the LangSmith run that produced it.
 *
 * The run ids are not something the browser can work out. They are written into graph
 * state by the agent as each turn ends (packages/agent/agents/feedback.py), which is
 * what makes the controls survive a reload and what pins the vote to the run that
 * actually wrote the answer — a turn that pauses for approval is several runs, and only
 * the resumed one produces the text being rated.
 *
 * So this hook does two small things: look up the run for a message, and POST the vote.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { resolveAgentUrl } from "@/lib/agent";
import type { AnswerRun } from "@/lib/state";

/* A vote is live state, not graph state: it is in flight, landed, or it failed. */
export type VoteStatus = "pending" | "sent" | "failed";

export interface Vote {
  score: 0 | 1;
  status: VoteStatus;
}

export interface Feedback {
  /** The run that produced this message, or undefined if it cannot be rated. */
  runFor: (messageId: string | undefined) => AnswerRun | undefined;
  /** This session's vote on a message, for rendering the row's state. */
  voteFor: (messageId: string | undefined) => Vote | undefined;
  vote: (messageId: string, score: 0 | 1, comment?: string) => void;
}

/* Matches the other fetches in this package: these are live writes and reads, never
   something a cache should answer. */
const NO_STORE: RequestInit = { cache: "no-store" };

/* Module-level, not a `= []` default argument. A default literal is a NEW array every
   render, which would change the memo's dependency every render, rebuild the run map,
   and re-fire the vote fetch in a loop on any page that omits the argument. */
const NO_RUNS: AnswerRun[] = [];

export function useFeedback(
  stream: { values?: { answer_runs?: AnswerRun[] } },
  threadId: string | null,
  /**
   * Runs from every branch, via useBranching. `stream.values` only ever describes the
   * branch tip, so without this the thumbs vanish when you switch back to an older
   * branch — the transcript shows one branch while the values describe another.
   */
  branchRuns: AnswerRun[] = NO_RUNS,
): Feedback {
  const [base] = useState(resolveAgentUrl);
  const [votes, setVotes] = useState<Record<string, Vote>>({});

  const runs = useMemo(() => {
    const byMessage = new Map<string, AnswerRun>();
    /* Insertion order matters: a resumed run can record the same message again, and the
       later entry is the one that finished the turn. Branch history first, so a live
       value for the same message wins. */
    for (const run of [...branchRuns, ...(stream.values?.answer_runs ?? [])]) {
      if (run?.message_id) byMessage.set(run.message_id, run);
    }
    return byMessage;
  }, [stream.values?.answer_runs, branchRuns]);

  /*
   * Votes already in LangSmith. Without this a reload shows the buttons unvoted, and
   * clicking again writes a second row on the same run.
   *
   * Only fills messages with no local vote: ingestion is backgrounded, so a fetch right
   * after voting can legitimately not see it yet, and overwriting would flip a "sent"
   * button back to empty.
   */
  useEffect(() => {
    const ids = [...runs.values()].map((r) => r.run_id);
    if (!threadId || ids.length === 0) return;
    let cancelled = false;

    void fetch(
      `${base}/feedback/${encodeURIComponent(threadId)}/votes?run_ids=${ids.join(",")}`,
      NO_STORE,
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { votes?: Record<string, { score: 0 | 1 }> } | null) => {
        if (cancelled || !data?.votes) return;
        setVotes((current) => {
          const next = { ...current };
          for (const [messageId, run] of runs) {
            const recorded = data.votes?.[run.run_id];
            if (recorded && !next[messageId]) {
              next[messageId] = { score: recorded.score, status: "sent" };
            }
          }
          return next;
        });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [base, threadId, runs]);

  const runFor = useCallback(
    (messageId: string | undefined) => (messageId ? runs.get(messageId) : undefined),
    [runs],
  );

  const voteFor = useCallback(
    (messageId: string | undefined) => (messageId ? votes[messageId] : undefined),
    [votes],
  );

  const vote = useCallback(
    (messageId: string, score: 0 | 1, comment?: string) => {
      const run = runs.get(messageId);
      if (!run || !threadId) return;

      setVotes((current) => ({ ...current, [messageId]: { score, status: "pending" } }));

      void fetch(`${base}/feedback/${encodeURIComponent(threadId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message_id: messageId,
          run_id: run.run_id,
          score,
          comment,
        }),
        ...NO_STORE,
      })
        .then((res) => {
          /* Checking res.ok matters: a rejected vote still resolves the promise, and
             without this a 400 would read as recorded. */
          setVotes((current) => ({
            ...current,
            [messageId]: { score, status: res.ok ? "sent" : "failed" },
          }));
        })
        .catch(() => {
          /* Unlike the file panel, this does not swallow the error. A vote that
             silently disappears is worse than one that visibly did not take, so the row
             shows it and the user can click again. */
          setVotes((current) => ({ ...current, [messageId]: { score, status: "failed" } }));
        });
    },
    [base, runs, threadId],
  );

  return { runFor, voteFor, vote };
}
