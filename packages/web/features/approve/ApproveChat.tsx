"use client";

import { useMemo, useState } from "react";
import { useMessageMetadata, useStream, type AnyStream, type AssembledToolCall } from "@langchain/react";
import { AIMessage, HumanMessage, type BaseMessage } from "langchain";
import type { HITLRequest, HITLResponse } from "langchain";

import { ASSISTANTS, resolveAgentUrl } from "@/lib/agent";
import type { AgentState } from "@/lib/state";
import {
  AIBubble,
  ChatContainer,
  ChatInput,
  HumanBubble,
  Markdown,
  PresetPrompts,
  TypingIndicator,
} from "@/components/playground";
import { ApprovalCard } from "./ApprovalCard";
import { ToolCallCard } from "./ToolCallCard";

const PRESETS = [
  "Send an email to team@acme.com with subject 'Q4 Results' saying revenue grew 15% this quarter",
];

export function ApproveChat() {
  // resolveAgentUrl() reads window, so compute it lazily rather than at module
  // scope. It is SSR-safe (returns the relative path when there is no window).
  const [apiUrl] = useState(resolveAgentUrl);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const stream = useStream<AgentState>({
    apiUrl,
    assistantId: ASSISTANTS.approve,
    threadId,
    onThreadId: setThreadId,
  });

  const { messages, isLoading, interrupt } = stream;

  const hitlRequest = interrupt?.value as HITLRequest | undefined;
  const actionRequests = hitlRequest?.actionRequests ?? [];
  const reviewConfigs = hitlRequest?.reviewConfigs ?? [];
  const hasMessages = messages.length > 0;

  const submit = (text: string) => {
    void stream.submit({ messages: [new HumanMessage(text)] });
  };

  /*
   * One decision per action request, positionally aligned with actionRequests.
   *
   * The fan-out is deliberate and easy to "fix" wrongly, so: REJECT rejects every
   * action, while EDIT approves all the others. Changing either changes what the
   * agent does with the actions you did not click on.
   */
  const respond = async (build: () => HITLResponse) => {
    if (!hitlRequest) return;
    setIsProcessing(true);
    try {
      await stream.respond(build());
    } finally {
      setIsProcessing(false);
    }
  };

  const handleApprove = () =>
    respond(() => ({ decisions: actionRequests.map(() => ({ type: "approve" as const })) }));

  const handleReject = (index: number, reason: string) =>
    respond(() => ({
      decisions: actionRequests.map((_, i) => ({
        type: "reject" as const,
        message:
          i === index ? reason || "User rejected" : "Rejected along with other actions",
      })),
    }));

  const handleEdit = (index: number, editedArgs: Record<string, unknown>) =>
    respond(() => ({
      decisions: actionRequests.map((_, i) =>
        i === index
          ? {
              type: "edit" as const,
              editedAction: { name: actionRequests[index].name, args: editedArgs },
            }
          : { type: "approve" as const },
      ),
    }));

  return (
    <ChatContainer
      embedded
      className="max-w-3xl mx-auto w-full"
      input={
        <ChatInput
          onSubmit={submit}
          disabled={isLoading || isProcessing || !!interrupt}
          placeholder={
            interrupt
              ? "Please approve or reject the pending action..."
              : "Ask the agent to do something sensitive..."
          }
          onNewThread={hasMessages ? () => setThreadId(null) : undefined}
        />
      }
    >
      {!hasMessages && !isLoading && <PresetPrompts prompts={PRESETS} onSelect={submit} />}

      {/* Only stream.messages is rendered — useStream adds the submitted message
          optimistically, so adding it here too would show it twice. */}
      {messages.map((message) => (
        <MessageRow key={message.id} stream={stream} message={message} />
      ))}

      {isLoading && !hitlRequest && <TypingIndicator />}

      {hitlRequest && actionRequests.length > 0 && !isProcessing && (
        <div className="pl-9 max-w-[80%] space-y-3">
          {actionRequests.map((actionRequest, idx) => (
            <ApprovalCard
              key={`${actionRequest.name}-${idx}`}
              actionRequest={actionRequest}
              reviewConfig={reviewConfigs[idx]}
              onApprove={handleApprove}
              onReject={(reason) => void handleReject(idx, reason)}
              onEdit={(editedArgs) => void handleEdit(idx, editedArgs)}
              isProcessing={isProcessing}
            />
          ))}
        </div>
      )}
    </ChatContainer>
  );
}

/**
 * One message. Separate component because it uses useMessageMetadata, which is a
 * hook and so cannot be called inside the .map() above.
 */
function MessageRow({ stream, message }: { stream: AnyStream; message: BaseMessage }) {
  const metadata = useMessageMetadata(stream, message.id);
  const optimisticStatus = metadata?.optimisticStatus;

  // stream.toolCalls is a flat list for the whole thread, so pick out the ones
  // this message requested. Cards are keyed by callId: a call mutates status in
  // place, and keying by index would make React reuse the wrong card.
  const toolCalls = useMemo<AssembledToolCall[]>(() => {
    const ids = AIMessage.isInstance(message)
      ? new Set((message.tool_calls ?? []).map((tc) => tc.id))
      : new Set<string | undefined>();
    return ids.size ? stream.toolCalls.filter((tc) => ids.has(tc.callId)) : [];
  }, [stream.toolCalls, message]);

  if (HumanMessage.isInstance(message)) {
    return (
      <div style={{ opacity: optimisticStatus === "pending" ? 0.6 : 1 }}>
        <HumanBubble>
          <Markdown>{message.text}</Markdown>
        </HumanBubble>
        {optimisticStatus === "failed" && (
          <div className="flex justify-end mt-1">
            <button
              type="button"
              onClick={() => void stream.submit({ messages: [message] })}
              className="text-xs text-error hover:underline"
            >
              Failed to send — retry
            </button>
          </div>
        )}
      </div>
    );
  }

  if (AIMessage.isInstance(message)) {
    const text = message.text;
    if (!text && toolCalls.length === 0) return null;
    return (
      <div className="space-y-2">
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
      </div>
    );
  }

  // Tool messages are not rendered: their content is shown inside ToolCallCard.
  return null;
}
