import { useState } from "react";
import { useStream } from "@langchain/react";
import { AIMessage, HumanMessage } from "langchain";
import type { humanInTheLoopAgent } from "@langchain/playground-agents";
import type { HITLRequest, HITLResponse } from "langchain";

import { AGENT_SERVER_URL, SLUG_TO_ASSISTANT } from "@/constants";
import {
  ChatContainer,
  AIBubble,
  HumanBubble,
  ChatInput,
  TypingIndicator,
  PresetPrompts,
  Markdown,
} from "@/components/playground";
import { ApprovalCard } from "./ApprovalCard";

const PRESETS = [
  "Send an email to team@acme.com with subject 'Q4 Results' saying revenue grew 15% this quarter",
];

export default function HumanInTheLoop() {
  const [threadId, setThreadId] = useState<string | null>(null);
  const stream = useStream<typeof humanInTheLoopAgent>({
    apiUrl: AGENT_SERVER_URL,
    assistantId: SLUG_TO_ASSISTANT["human-in-the-loop"],
    threadId,
    onThreadId: setThreadId,
  });

  const { messages, isLoading, interrupt } = stream;
  const [isProcessing, setIsProcessing] = useState(false);

  const handleSubmit = (text: string) => {
    stream.submit({ messages: [{ type: "human" as const, content: text }] });
  };

  const hitlRequest = interrupt?.value as HITLRequest | undefined;
  const actionRequests = hitlRequest?.actionRequests ?? [];
  const reviewConfigs = hitlRequest?.reviewConfigs ?? [];

  const handleApprove = async () => {
    if (!hitlRequest) return;
    setIsProcessing(true);
    try {
      const resume: HITLResponse = {
        decisions: actionRequests.map(() => ({
          type: "approve",
        })),
      };
      await stream.respond(resume);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReject = async (index: number, reason: string) => {
    if (!hitlRequest) return;
    setIsProcessing(true);
    try {
      const resume: HITLResponse = {
        decisions: actionRequests.map((_, i) =>
          i === index
            ? { type: "reject" as const, message: reason || "User rejected" }
            : { type: "reject" as const, message: "Rejected along with other actions" },
        ),
      };
      await stream.respond(resume);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleEdit = async (index: number, editedArgs: Record<string, unknown>) => {
    if (!hitlRequest) return;
    setIsProcessing(true);
    try {
      const originalAction = actionRequests[index];
      const resume: HITLResponse = {
        decisions: actionRequests.map((_, i) =>
          i === index
            ? {
                type: "edit" as const,
                editedAction: { name: originalAction.name, args: editedArgs },
              }
            : { type: "approve" as const },
        ),
      };
      await stream.respond(resume);
    } finally {
      setIsProcessing(false);
    }
  };

  const hasMessages = messages.length > 0;

  return (
    <ChatContainer
      input={
        <ChatInput
          onSubmit={handleSubmit}
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
      {!hasMessages && !isLoading && <PresetPrompts prompts={PRESETS} onSelect={handleSubmit} />}

      {messages.map((msg) => {
        if (HumanMessage.isInstance(msg)) {
          return (
            <HumanBubble key={msg.id}>
              <Markdown>{msg.text}</Markdown>
            </HumanBubble>
          );
        }

        if (AIMessage.isInstance(msg)) {
          const text = msg.text;
          if (!text) return null;
          return (
            <AIBubble key={msg.id}>
              <Markdown>{text}</Markdown>
            </AIBubble>
          );
        }

        return null;
      })}

      {isLoading && !hitlRequest && <TypingIndicator />}

      {hitlRequest && actionRequests.length > 0 && !isProcessing && (
        <div className="pl-9 max-w-[80%]">
          {actionRequests.map((actionRequest, idx) => (
            <ApprovalCard
              key={idx}
              actionRequest={actionRequest}
              reviewConfig={reviewConfigs[idx]}
              onApprove={() => handleApprove()}
              onReject={(reason) => handleReject(idx, reason)}
              onEdit={(editedArgs) => handleEdit(idx, editedArgs)}
              isProcessing={isProcessing}
            />
          ))}
        </div>
      )}
    </ChatContainer>
  );
}
