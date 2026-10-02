"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AnyStream } from "@langchain/react";
import type { ActionRequest, HITLRequest, HITLResponse, ReviewConfig } from "langchain";
import { normalizeHitlInterruptPayload } from "@langchain/langgraph-sdk/ui";

/**
 * Human-in-the-loop decisions, shared by every page.
 *
 * THE RULE THAT SHAPES THIS FILE: a run can pause on SEVERAL interrupts at once, and
 * each one must be shown and answered separately.
 *
 * Two parallel subagents each calling write_file produce two independent interrupts.
 * The SDK is explicit that `stream.interrupt` is only for the simple case — it is
 * documented as "convenience alias for interrupts[0] ... when only one is pending".
 * Reading it unconditionally produced a measured failure: with /a.md and /b.md both
 * pending, the UI rendered ONE card showing /b.md, and approving it wrote /a.md — the
 * action the user never saw. An approval gate that can do that is worse than none.
 *
 * So: read `stream.interrupts` (plural), render one card per interrupt, and answer by
 * id. Each interrupt also gets its OWN decisions array, because that array is
 * positional and two interrupts can carry different numbers of actions.
 */

/** One pending interrupt, with everything a card needs to render and answer it. */
export interface HitlGroup {
  /** Interrupt id, used to answer this one specifically. */
  id: string;
  /** The actions awaiting review in this interrupt. */
  requests: ActionRequest[];
  /** Positionally aligned with `requests`. */
  reviewConfigs: ReviewConfig[];
}

export interface HitlState {
  /** One entry per pending interrupt. Empty when nothing is pending. */
  groups: HitlGroup[];
  /** True while a decision is in flight; hide the cards so they cannot be double-sent. */
  isProcessing: boolean;
  approve: (groupId: string) => void;
  reject: (groupId: string, index: number, reason: string) => void;
  edit: (groupId: string, index: number, editedArgs: Record<string, unknown>) => void;
}

/**
 * Read an interrupt payload in whatever casing it arrived in.
 *
 * Entries on `stream.interrupts` are already camelCase — the SDK runs this same
 * normaliser on the way in. Calling it again is idempotent and cheap, and it keeps this
 * hook correct if it is ever pointed at a raw payload: over plain HTTP the Python server
 * sends `action_requests` / `review_configs`. The SDK's version also covers two aliases
 * a hand-rolled one misses: `name` <-> `action_name`, `allowedDecisions` <->
 * `allowed_decisions`.
 */
/** Stable identity, so resetting to "nothing answered" never re-renders needlessly. */
const EMPTY_IDS: ReadonlySet<string> = new Set();

function normalized(payload: unknown): HITLRequest | undefined {
  if (!payload) return undefined;
  return normalizeHitlInterruptPayload(payload) as HITLRequest;
}

export function useHitl(
  stream: AnyStream,
  /**
   * Checkpoint-backed verdict on whether an approval is really pending.
   * `false` suppresses a retained interrupt the server has moved past (see
   * lib/use-branching.ts). `null`/omitted trusts the stream.
   */
  approvalPending?: boolean | null,
): HitlState {
  const [isProcessing, setIsProcessing] = useState(false);

  /*
   * Every pending interrupt — and `stream.interrupts` is the only list to read.
   *
   * Despite its "root" naming it mirrors EVERY namespace, so a subagent pause is in
   * here too (verified in the browser), and each entry carries `namespace` for resume.
   * More importantly it is reconciled against server truth: seeded on hydration from
   * `tasks[].interrupts`, so it survives a reload; tombstoned when answered; and
   * replayed-but-resolved events are filtered out.
   *
   * `getThread()?.interrupts` looks like a richer alternative and is not. It is an
   * append-only log of what THIS socket witnessed — nothing seeds it from thread state,
   * so after a reload it is empty. It also pushes interrupts the list above deliberately
   * withholds while the SDK works out, against server state, whether a replayed event is
   * live. Reading it as a fallback therefore only ever adds cards that may already be
   * resolved.
   *
   * It needs one correction though, which `answeredIds` below supplies.
   */
  const groups = useMemo<HitlGroup[]>(() => {
    const stale = approvalPending === false;
    if (stale) return [];

    return (stream.interrupts ?? [])
      .map((entry) => {
        const req = normalized(entry.value);
        return {
          id: String(entry.id ?? ""),
          requests: req?.actionRequests ?? [],
          reviewConfigs: req?.reviewConfigs ?? [],
        };
      })
      .filter((g) => g.id !== "" && g.requests.length > 0);
  }, [stream, approvalPending]);

  /*
   * Interrupts the server has already executed, which the list above still reports.
   *
   * When two interrupts open in the SAME step and you answer one, that step cannot
   * finish until the rest are answered, so the checkpoint keeps every task — the
   * answered one included, still carrying its interrupt. In-session the SDK remembers
   * which ids it answered, but that memory is in-process: reload the page and the
   * answered card renders again, over an action that already ran.
   *
   * The server does distinguish them. A task that ran has a `result` (the tool's
   * output); one still waiting has `result: null`. Correlating by anything else is not
   * possible — an ActionRequest is `{name, args, description?}` with no tool-call id, so
   * the interrupt id against `tasks[]` is the only join there is.
   *
   * Filtering only ever REMOVES cards, and `result` is monotonic once set, so a reply
   * that arrives late can hide a card that should already be gone but can never hide a
   * live one.
   */
  const pendingKey = groups.map((g) => g.id).join("|");
  const [answeredIds, setAnsweredIds] = useState<ReadonlySet<string>>(EMPTY_IDS);

  useEffect(() => {
    const threadId = stream.threadId;
    if (!pendingKey || !threadId) {
      setAnsweredIds(EMPTY_IDS);
      return;
    }
    let cancelled = false;
    void stream.client.threads
      .getState(threadId)
      .then((state) => {
        if (cancelled) return;
        const done = new Set<string>();
        for (const task of state.tasks ?? []) {
          if (task.result == null) continue;
          for (const entry of task.interrupts ?? []) if (entry.id) done.add(entry.id);
        }
        setAnsweredIds(done);
      })
      // A failed check must not hide a live approval; leave the cards alone.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pendingKey, stream]);

  const visible = useMemo(
    () => (answeredIds.size === 0 ? groups : groups.filter((g) => !answeredIds.has(g.id))),
    [groups, answeredIds],
  );

  /**
   * Answer ONE interrupt, leaving the others pending.
   *
   * Always `respondAll` keyed by id, never a bare `respond()`. A bare respond targets
   * "the newest unresolved" interrupt, which is not necessarily the card the user
   * clicked — that is exactly how approving /b.md wrote /a.md.
   *
   * No `namespace` is passed and none is needed: the SDK resolves it from the id, which
   * is why a subagent's interrupt resumes correctly from here (also verified).
   */
  const send = useCallback(
    async (groupId: string, build: (actions: ActionRequest[]) => HITLResponse) => {
      const group = groups.find((g) => g.id === groupId);
      if (!group) return;
      setIsProcessing(true);
      try {
        await stream.respondAll({ [group.id]: build(group.requests) });
      } finally {
        setIsProcessing(false);
      }
    },
    [groups, stream],
  );

  /*
   * The fan-out below is deliberate and easy to "fix" wrongly, and it applies WITHIN
   * one interrupt:
   *   REJECT rejects every action in that interrupt.
   *   EDIT approves all the others in that interrupt.
   * Other pending interrupts are untouched — they keep their own cards.
   */
  const approve = useCallback(
    (groupId: string) =>
      void send(groupId, (actions) => ({
        decisions: actions.map(() => ({ type: "approve" as const })),
      })),
    [send],
  );

  const reject = useCallback(
    (groupId: string, index: number, reason: string) =>
      void send(groupId, (actions) => ({
        decisions: actions.map((_, i) => ({
          type: "reject" as const,
          message: i === index ? reason || "User rejected" : "Rejected along with other actions",
        })),
      })),
    [send],
  );

  const edit = useCallback(
    (groupId: string, index: number, editedArgs: Record<string, unknown>) =>
      void send(groupId, (actions) => ({
        decisions: actions.map((_, i) =>
          i === index && actions[index]
            ? {
                type: "edit" as const,
                editedAction: { name: actions[index].name, args: editedArgs },
              }
            : { type: "approve" as const },
        ),
      })),
    [send],
  );

  return { groups: visible, isProcessing, approve, reject, edit };
}
