"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AnyStream } from "@langchain/react";
import type { ActionRequest, Decision, HITLRequest, ReviewConfig } from "langchain";
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
 * So: read `stream.interrupts` (plural), render one card per ACTION, and answer each
 * interrupt by id.
 *
 * AND THE SECOND SHAPE, which the first fix missed. Those two situations are different:
 *
 *   two subagents, one gated tool each   -> 2 interrupts x 1 action
 *   one agent, two gated calls at once   -> 1 interrupt  x 2 actions
 *
 * Both render two cards, but an interrupt can only be answered ONCE, with one decision
 * per action, all together. So a click on one card of a two-action interrupt cannot be
 * sent on its own. Approving the whole group on the first click is what this hook used
 * to do, and it ran an action the user never approved.
 *
 * Instead each click is STAGED against its action, and the response goes out when every
 * action in that interrupt has a decision. A one-action interrupt — the common case —
 * still sends on the first click, because one click completes it.
 */

/** One pending interrupt, with everything its cards need to render and answer it. */
export interface HitlGroup {
  /** Interrupt id, used to answer this one specifically. */
  id: string;
  /** The actions awaiting review in this interrupt. */
  requests: ActionRequest[];
  /** Positionally aligned with `requests`. */
  reviewConfigs: ReviewConfig[];
  /**
   * What the user has decided so far, positionally aligned with `requests`.
   * `undefined` means still waiting on that card. Only ever non-empty while an
   * interrupt carries more than one action — otherwise the first click sends.
   */
  decisions: (Decision["type"] | undefined)[];
}

export interface HitlState {
  /** One entry per pending interrupt. Empty when nothing is pending. */
  groups: HitlGroup[];
  /** True while a decision is in flight; hide the cards so they cannot be double-sent. */
  isProcessing: boolean;
  approve: (groupId: string, index: number) => void;
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

/** A pending interrupt before the user's staged decisions are attached. */
type PendingInterrupt = Omit<HitlGroup, "decisions">;

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
  const groups = useMemo<PendingInterrupt[]>(() => {
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

  /**
   * One decision per card, held until the whole interrupt can be answered.
   *
   * Keyed by interrupt id; each array lines up with that interrupt's `requests`.
   * A slot stays `undefined` until its card is clicked.
   */
  const [staged, setStaged] = useState<Record<string, (Decision | undefined)[]>>({});

  /**
   * Record one card's decision, and send as soon as its interrupt is fully decided.
   *
   * Always `respondAll` keyed by id, never a bare `respond()`. A bare respond targets
   * "the newest unresolved" interrupt, which is not necessarily the card the user
   * clicked — that is exactly how approving /b.md wrote /a.md.
   *
   * No `namespace` is passed and none is needed: the SDK resolves it from the id, which
   * is why a subagent's interrupt resumes correctly from here (also verified).
   */
  const decide = useCallback(
    (groupId: string, index: number, decision: Decision) => {
      const group = groups.find((g) => g.id === groupId);
      if (!group || index < 0 || index >= group.requests.length) return;

      /* `Array.from`, never `arr.length = n`: setting `length` leaves sparse HOLES, and
         `some`/`every` skip holes — so the "anything still undecided?" test below would
         report false on the first click and send a malformed decisions array. */
      const held = staged[groupId] ?? [];
      const next = Array.from<unknown, Decision | undefined>(
        { length: group.requests.length },
        (_, i) => held[i],
      );
      next[index] = decision;

      // Still waiting on a sibling card: hold this one and leave the run paused.
      if (next.some((d) => d === undefined)) {
        setStaged((s) => ({ ...s, [groupId]: next }));
        return;
      }

      setStaged(({ [groupId]: _answered, ...rest }) => rest);
      setIsProcessing(true);
      void stream
        .respondAll({ [groupId]: { decisions: next as Decision[] } })
        .finally(() => setIsProcessing(false));
    },
    [groups, staged, stream],
  );

  /**
   * What each card shows, with the decisions made so far attached.
   *
   * A decided card has to look decided — otherwise a two-action interrupt reads as a
   * dead button: the user clicks Approve, nothing is sent (correctly, the sibling is
   * undecided), and the page appears to have ignored them.
   */
  const visible = useMemo<HitlGroup[]>(
    () =>
      groups
        .filter((g) => !answeredIds.has(g.id))
        .map((g) => ({
          ...g,
          decisions: g.requests.map((_, i) => staged[g.id]?.[i]?.type),
        })),
    [groups, answeredIds, staged],
  );

  const approve = useCallback(
    (groupId: string, index: number) => decide(groupId, index, { type: "approve" }),
    [decide],
  );

  const reject = useCallback(
    (groupId: string, index: number, reason: string) =>
      decide(groupId, index, { type: "reject", message: reason || "User rejected" }),
    [decide],
  );

  const edit = useCallback(
    (groupId: string, index: number, editedArgs: Record<string, unknown>) => {
      const action = groups.find((g) => g.id === groupId)?.requests[index];
      if (!action) return;
      decide(groupId, index, {
        type: "edit",
        editedAction: { name: action.name, args: editedArgs },
      });
    },
    [decide, groups],
  );

  return { groups: visible, isProcessing, approve, reject, edit };
}
