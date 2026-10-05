"use client";

import { useMemo } from "react";
import { AIMessage, HumanMessage, type BaseMessage } from "langchain";
import type { AnyStream, AssembledToolCall, SubagentDiscoverySnapshot } from "@langchain/react";

import { AIBubble, HumanBubble, Markdown, SubagentCard } from "@/components/playground";
import { ReasoningTrace } from "@/components/chat/ReasoningTrace";
import { ToolCallCard } from "@/components/ToolCallCard";
import { FeedbackControls } from "@/components/FeedbackControls";
import type { Feedback } from "@/lib/use-feedback";

/** Tool calls the page renders better somewhere else than as a raw-argument card. */
const RENDERED_ELSEWHERE = new Set(["write_todos"]);

/**
 * One coordinator message, plus anything it spawned.
 *
 * The order follows what the agent did: it thought, then spoke, then delegated — so
 * the reasoning trace comes first, the text second, the subagent cards last.
 */
export function CoordinatorTurn({
  stream,
  message,
  subagentsByCallId,
  isLast,
  awaitingApproval,
  feedback,
}: {
  stream: AnyStream;
  message: BaseMessage;
  subagentsByCallId: Map<string, SubagentDiscoverySnapshot>;
  isLast: boolean;
  /** True while an approval is open, so a paused helper is not shown as failed. */
  awaitingApproval: boolean;
  feedback: Feedback;
}) {
  /*
   * This message's tool calls, minus two kinds that would be rendered twice:
   *
   *  - `task`, because `subagent.id` IS the task tool-call id, so the SubagentCard
   *    below already represents it. Without this filter every delegation appears
   *    twice, once as raw arguments and once as a card.
   *  - `write_todos`, because the sidebar IS that call's result. Showing both puts a
   *    large JSON dump of the plan directly above the plan.
   */
  const toolCalls = useMemo<AssembledToolCall[]>(() => {
    if (!AIMessage.isInstance(message)) return [];
    const ids = new Set(
      (message.tool_calls ?? []).map((tc) => tc.id).filter((id): id is string => !!id),
    );
    if (ids.size === 0) return [];
    return stream.toolCalls.filter(
      (tc) =>
        ids.has(tc.callId) &&
        !subagentsByCallId.has(tc.callId) &&
        !RENDERED_ELSEWHERE.has(tc.name),
    );
  }, [stream.toolCalls, message, subagentsByCallId]);

  /* Cards attach to the turn that delegated the work, not the thread bottom — the
     same rule /approve uses for approval cards. */
  const turnSubagents = useMemo(() => {
    if (!AIMessage.isInstance(message)) return [];
    return (message.tool_calls ?? [])
      .map((tc) => subagentsByCallId.get(tc.id ?? ""))
      .filter((s): s is SubagentDiscoverySnapshot => s !== undefined);
  }, [message, subagentsByCallId]);

  if (HumanMessage.isInstance(message)) {
    return (
      <HumanBubble>
        <Markdown>{message.text}</Markdown>
      </HumanBubble>
    );
  }

  if (!AIMessage.isInstance(message)) return null;

  const streaming = isLast && stream.isLoading;
  const text = message.text;

  // An AI message that carried only reasoning still deserves its trace.
  if (!text && toolCalls.length === 0 && turnSubagents.length === 0) {
    return <ReasoningTrace message={message} isStreaming={streaming} />;
  }

  return (
    <div className="group space-y-2">
      <ReasoningTrace message={message} isStreaming={streaming} />

      {text && (
        <AIBubble>
          <Markdown>{text}</Markdown>
        </AIBubble>
      )}

      {toolCalls.length > 0 && (
        <div className="pl-9 max-w-[80%] space-y-2">
          {toolCalls.map((tc) => (
            <ToolCallCard key={tc.callId} toolCall={tc} />
          ))}
        </div>
      )}

      {turnSubagents.length > 0 && (
        <div className="ml-3 space-y-2 border-l-2 border-border pl-9">
          {turnSubagents.map((subagent) => (
            <SubagentCard
              key={subagent.id}
              stream={stream}
              subagent={subagent}
              awaitingApproval={awaitingApproval}
            />
          ))}
        </div>
      )}

      {/* Last, after the subagent cards, because the rating is on the whole turn — the
          coordinator's answer and everything it delegated. The agent records a run for
          exactly one message per turn, so only that one gets a row. */}
      {feedback.runFor(message.id) && (
        <div className="pl-9">
          <FeedbackControls
            vote={feedback.voteFor(message.id)}
            onVote={(score, comment) => feedback.vote(message.id!, score, comment)}
          />
        </div>
      )}
    </div>
  );
}
