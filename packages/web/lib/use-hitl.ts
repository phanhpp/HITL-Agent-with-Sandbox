"use client";

import { useCallback, useState } from "react";
import type { AnyStream } from "@langchain/react";
import type { ActionRequest, HITLRequest, HITLResponse, ReviewConfig } from "langchain";

/**
 * Human-in-the-loop decisions, shared by every page.
 *
 * Lives here rather than in a page because /orchestrate needs the same logic, and
 * because ONE detail differs by where the interrupt fires and is easy to get wrong:
 *
 *   root agent   -> stream.interrupt
 *   subagent     -> stream.getThread()?.interrupts ?? []   (NOT stream.interrupt)
 *
 * GUIDE.md 7.3.9 and 12's mistake 5. Reading only stream.interrupt means a subagent
 * pause never shows and the run waits forever.
 *
 * Also: several simultaneous interrupts must be answered with ONE respondAll, because
 * the first respond() starts a new run and the second then fails (12's mistake 6).
 */
export interface HitlState {
  /** The actions awaiting review; empty when nothing is pending. */
  requests: ActionRequest[];
  /** Positionally aligned with `requests`. */
  reviewConfigs: ReviewConfig[];
  /** True while a decision is in flight; hide the cards so they cannot be double-sent. */
  isProcessing: boolean;
  approve: () => void;
  reject: (index: number, reason: string) => void;
  edit: (index: number, editedArgs: Record<string, unknown>) => void;
}

/**
 * The action requests of one interrupt payload, in either casing.
 *
 * `stream.interrupt` is camelCase, because useStream normalises it. The thread-level
 * list from `getThread()?.interrupts` is NOT normalised — its payloads arrive straight
 * off the wire as `action_requests` / `review_configs`. Verified by dumping a live
 * payload: `nestedPayloadKeys: "action_requests,review_configs"`.
 *
 * Reading only the camelCase name here returns [] for every nested interrupt, which
 * renders an approval card with no actions and sends `{decisions: []}` on approve.
 * Nothing caught it because a root interrupt is always present today, so the nested
 * branch never runs.
 */
type WireHITLRequest = {
  actionRequests?: ActionRequest[];
  action_requests?: ActionRequest[];
  reviewConfigs?: ReviewConfig[];
  review_configs?: ReviewConfig[];
};

function requestsOf(payload: HITLRequest | undefined): ActionRequest[] {
  const p = payload as WireHITLRequest | undefined;
  return p?.actionRequests ?? p?.action_requests ?? [];
}

function configsOf(payload: HITLRequest | undefined): ReviewConfig[] {
  const p = payload as WireHITLRequest | undefined;
  return p?.reviewConfigs ?? p?.review_configs ?? [];
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
   * Two different types, which GUIDE.md conflates:
   *
   *   stream.interrupt        -> Interrupt        { value, id? }   root namespace only
   *   getThread().interrupts  -> InterruptPayload { payload, interruptId, namespace }
   *
   * use-stream.d.ts:81 is explicit that stream.interrupts covers "the root namespace",
   * so a subagent pause only appears on the thread-level list.
   *
   * NOTE: the nested branch is written from the types and is UNVERIFIED until
   * /orchestrate exists to raise a subagent interrupt (step 6).
   */
  const rootRequest = stream.interrupt?.value as HITLRequest | undefined;

  const threadInterrupts = stream.getThread()?.interrupts ?? [];
  const nested = !rootRequest && threadInterrupts.length > 0 ? threadInterrupts : undefined;
  const nestedRequest = nested?.[0]?.payload as HITLRequest | undefined;

  const request = rootRequest ?? nestedRequest;


  // A fork never resolves the interrupt it replayed, so the stream can hold one the
  // thread has no task for. The checkpoint decides; the stream only supplies the body.
  const stale = approvalPending === false;
  const requests = stale ? [] : requestsOf(request);
  const reviewConfigs = stale ? [] : configsOf(request);

  const send = useCallback(
    async (build: (actionRequests: ActionRequest[]) => HITLResponse) => {
      if (!request) return;
      setIsProcessing(true);
      try {
        if (rootRequest) {
          await stream.respond(build(requestsOf(rootRequest)));
          return;
        }
        if (!nested) return;

        /*
         * One call for every pending interrupt. Two separate reasons it has to be
         * one call, and one reason each response must be built separately:
         *
         *  - Calling respond() twice fails. The first resume starts a new run, so
         *    the second has no interrupted run to answer (GUIDE.md 12, mistake 6).
         *  - respondAll takes a map of interruptId -> response, and resolves each
         *    namespace internally from the thread's interrupt list, so ids are all
         *    we need to supply.
         *  - Each interrupt carries its OWN action requests, and a decisions array
         *    is positional. Building one response from the first interrupt and
         *    sending it to all of them mismatches the moment two helpers pause with
         *    different numbers of actions — approving things nobody was shown.
         */
        await stream.respondAll(
          Object.fromEntries(
            nested.map((entry) => [
              entry.interruptId,
              build(requestsOf(entry.payload as HITLRequest | undefined)),
            ]),
          ),
        );
      } finally {
        setIsProcessing(false);
      }
    },
    [request, rootRequest, nested, stream],
  );

  /*
   * The fan-out below is deliberate and easy to "fix" wrongly:
   *   REJECT rejects every action.
   *   EDIT approves all the others.
   * Changing either changes what the agent does with the actions you did not click.
   */
  const approve = useCallback(
    () => void send((actions) => ({ decisions: actions.map(() => ({ type: "approve" as const })) })),
    [send],
  );

  const reject = useCallback(
    (index: number, reason: string) =>
      void send((actions) => ({
        decisions: actions.map((_, i) => ({
          type: "reject" as const,
          message: i === index ? reason || "User rejected" : "Rejected along with other actions",
        })),
      })),
    [send],
  );

  const edit = useCallback(
    (index: number, editedArgs: Record<string, unknown>) =>
      void send((actions) => ({
        decisions: actions.map((_, i) =>
          i === index && actions[index]
            ? { type: "edit" as const, editedAction: { name: actions[index].name, args: editedArgs } }
            : { type: "approve" as const },
        ),
      })),
    [send],
  );

  return { requests, reviewConfigs, isProcessing, approve, reject, edit };
}
