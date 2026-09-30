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

export function useHitl(stream: AnyStream): HitlState {
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
  const requests = request?.actionRequests ?? [];
  const reviewConfigs = request?.reviewConfigs ?? [];

  const send = useCallback(
    async (build: () => HITLResponse) => {
      if (!request) return;
      setIsProcessing(true);
      try {
        const response = build();
        if (rootRequest) {
          await stream.respond(response);
        } else if (nested) {
          // One call for every pending interrupt, keyed by interruptId. Calling
          // respond() twice fails: the first starts a new run (12's mistake 6).
          // respond resolves `namespace` from the interrupt list given only the id.
          await stream.respondAll(
            Object.fromEntries(nested.map((entry) => [entry.interruptId, response])),
          );
        }
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
    () => void send(() => ({ decisions: requests.map(() => ({ type: "approve" as const })) })),
    [send, requests],
  );

  const reject = useCallback(
    (index: number, reason: string) =>
      void send(() => ({
        decisions: requests.map((_, i) => ({
          type: "reject" as const,
          message: i === index ? reason || "User rejected" : "Rejected along with other actions",
        })),
      })),
    [send, requests],
  );

  const edit = useCallback(
    (index: number, editedArgs: Record<string, unknown>) =>
      void send(() => ({
        decisions: requests.map((_, i) =>
          i === index
            ? { type: "edit" as const, editedAction: { name: requests[index].name, args: editedArgs } }
            : { type: "approve" as const },
        ),
      })),
    [send, requests],
  );

  return { requests, reviewConfigs, isProcessing, approve, reject, edit };
}
