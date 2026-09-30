"use client";

import { useMemo, useState } from "react";
import {
  useMessageMetadata,
  useStream,
  type AnyStream,
  type AssembledToolCall,
} from "@langchain/react";
import { AIMessage, HumanMessage, type BaseMessage } from "langchain";

import { ASSISTANTS, resolveAgentUrl } from "@/lib/agent";
import type { AgentState } from "@/lib/state";
import { useHitl } from "@/lib/use-hitl";
import type { ChatShellRenderProps } from "@/components/ChatShell";
import { ApprovalCard } from "@/components/ApprovalCard";
import { ToolCallCard } from "@/components/ToolCallCard";
import {
  AIBubble,
  ChatContainer,
  ChatInput,
  HumanBubble,
  Markdown,
  PresetPrompts,
  TypingIndicator,
} from "@/components/playground";

const PRESETS = [
  "Send an email to team@acme.com with subject 'Q4 Results' saying revenue grew 15% this quarter",
];

/**
 * GUIDE.md 8.3's RejoinableChat for /approve. Owns useStream; torn down and rebuilt on
 * Leave/Rejoin, always handed the same threadId by ChatShell so it reconnects.
 */
export function ApproveChat({ threadId, onThreadId, onLeave }: ChatShellRenderProps) {
  // Reads window, so compute lazily rather than at module scope.
  const [apiUrl] = useState(resolveAgentUrl);

  const stream = useStream<AgentState>({
    apiUrl,
    assistantId: ASSISTANTS.approve,
    threadId,
    onThreadId,
  });

  const { messages, isLoading } = stream;
  const hitl = useHitl(stream);
  const pending = hitl.requests.length > 0;
  const hasMessages = messages.length > 0;

  const submit = (text: string) => {
    void stream.submit({ messages: [new HumanMessage(text)] });
  };

  return (
    <ChatContainer
      embedded
      className="max-w-3xl mx-auto w-full"
      input={
        <div className="space-y-2">
          <ChatInput
            onSubmit={submit}
            disabled={isLoading || hitl.isProcessing || pending}
            placeholder={
              pending
                ? "Please approve or reject the pending action..."
                : "Ask the agent to do something sensitive..."
            }
          />
          <div className="flex items-center gap-3">
            {/* disconnect() detaches without cancelling; stop() cancels the run
                server-side. Keeping them distinct is GUIDE.md 12's mistake 4. */}
            <button
              type="button"
              onClick={async () => {
                await stream.disconnect();
                onLeave();
              }}
              className="text-xs text-text-secondary hover:text-text transition-colors"
            >
              Leave (keeps running)
            </button>
            <button
              type="button"
              onClick={() => void stream.stop()}
              disabled={!isLoading}
              className="text-xs text-text-secondary hover:text-text disabled:opacity-40 transition-colors"
            >
              Stop (cancels)
            </button>
          </div>
        </div>
      }
    >
      {!hasMessages && !isLoading && <PresetPrompts prompts={PRESETS} onSelect={submit} />}

      {/* Only stream.messages: useStream adds the submitted message optimistically,
          so rendering it ourselves too would show it twice. */}
      {messages.map((message) => (
        <MessageRow key={message.id} stream={stream} message={message} />
      ))}

      {isLoading && !pending && <TypingIndicator />}

      {pending && !hitl.isProcessing && (
        <div className="pl-9 max-w-[80%] space-y-3">
          {hitl.requests.map((actionRequest, idx) => (
            <ApprovalCard
              key={`${actionRequest.name}-${idx}`}
              actionRequest={actionRequest}
              reviewConfig={hitl.reviewConfigs[idx]}
              onApprove={hitl.approve}
              onReject={(reason) => hitl.reject(idx, reason)}
              onEdit={(editedArgs) => hitl.edit(idx, editedArgs)}
              isProcessing={hitl.isProcessing}
            />
          ))}
        </div>
      )}
    </ChatContainer>
  );
}

/** Separate component so useMessageMetadata can run per message — hooks cannot go in a map. */
function MessageRow({ stream, message }: { stream: AnyStream; message: BaseMessage }) {
  const optimisticStatus = useMessageMetadata(stream, message.id)?.optimisticStatus;

  // stream.toolCalls is flat for the whole thread, so pick this message's out. Keyed by
  // callId: a call mutates status in place, and an index key reuses the wrong card.
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

  // Tool messages are not rendered: their content appears inside ToolCallCard.
  return null;
}
