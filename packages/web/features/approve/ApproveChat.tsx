"use client";

import { Fragment, useMemo, useState } from "react";
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
import { ForkControls, MessageEditor, useFork } from "@/components/ForkControls";
import { forkPointForMessage, useCheckpoints } from "@/lib/use-checkpoints";
import { useStopRun } from "@/lib/use-stop-run";
import { StopIcon } from "@/components/icons";
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

  // One history fetch per thread, refreshed when a run ends. Each message's fork
  // point is derived from this rather than from per-message metadata, which is
  // undefined here — see lib/use-checkpoints.ts.
  const checkpoints = useCheckpoints(stream, threadId);
  const { stopRun, isStopping } = useStopRun(stream, threadId);
  const pending = hitl.requests.length > 0;
  const hasMessages = messages.length > 0;

  /*
   * Which message the approval card belongs under.
   *
   * It used to render in a block after the whole list, which put it at the bottom of
   * the thread. That looks right only while the reviewed turn is the last one — after
   * a fork, or once another query is sent, the card detaches from the tool call it is
   * actually reviewing. Match on the tool name instead and render it in place.
   */
  const pendingIndex = useMemo(() => {
    if (hitl.requests.length === 0) return -1;
    const names = new Set(hitl.requests.map((r) => r.name));
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (AIMessage.isInstance(m) && (m.tool_calls ?? []).some((tc) => names.has(tc.name))) {
        return i;
      }
    }
    return -1;
  }, [hitl.requests, messages]);

  const approvalCards =
    pending && !hitl.isProcessing ? (
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
    ) : null;

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
          <div className="flex items-center gap-2">
            {/* disconnect() detaches and lets the run continue; stop() cancels it
                server-side. Keeping them distinct is GUIDE.md 12's mistake 4. */}
            <button
              type="button"
              onClick={async () => {
                await stream.disconnect();
                onLeave();
              }}
              className="rounded-md border border-border px-2.5 py-1 text-xs text-text-secondary hover:text-text hover:border-border-hover transition-colors"
            >
              Leave
            </button>

            {/*
              Only while the agent is actually working. isLoading goes false at every
              terminal phase, an interrupt included — and while an approval is pending
              there is no run to cancel anyway, so Reject on the card is the action that
              applies there.
            */}
            {isLoading && (
              <button
                type="button"
                onClick={() => void stopRun()}
                disabled={isStopping}
                aria-label="Stop generating"
                title={isStopping ? "Stopping…" : "Stop the agent working on this thread"}
                className="inline-flex size-7 items-center justify-center rounded-full border border-error/50 text-error hover:border-error hover:bg-error/10 disabled:opacity-50 transition-colors"
              >
                <StopIcon className={`size-3 ${isStopping ? "animate-pulse" : ""}`} />
              </button>
            )}
          </div>
        </div>
      }
    >
      {!hasMessages && !isLoading && <PresetPrompts prompts={PRESETS} onSelect={submit} />}

      {/* Only stream.messages: useStream adds the submitted message optimistically,
          so rendering it ourselves too would show it twice. */}
      {messages.map((message, index) => (
        <Fragment key={message.id}>
          <MessageRow
            stream={stream}
            message={message}
            // The checkpoint holding exactly `index` messages is the state just
            // before this one existed, so resuming from it replays this turn.
            forkFrom={forkPointForMessage(checkpoints, index)}
          />
          {index === pendingIndex && approvalCards}
        </Fragment>
      ))}

      {isLoading && !pending && <TypingIndicator />}

      {/* Fallback: an interrupt whose tool call matches no message in view. */}
      {pendingIndex === -1 && approvalCards}
    </ChatContainer>
  );
}

/** Separate component so useMessageMetadata can run per message — hooks cannot go in a map. */
function MessageRow({
  stream,
  message,
  forkFrom,
}: {
  stream: AnyStream;
  message: BaseMessage;
  forkFrom: string | undefined;
}) {
  const optimisticStatus = useMessageMetadata(stream, message.id)?.optimisticStatus;
  const fork = useFork(stream);
  const [isEditing, setIsEditing] = useState(false);

  // No fork point, or a run in flight: editing now would race it (GUIDE.md 12's
  // mistake 12 — do not let users edit or regenerate while streaming).
  const forkDisabled = !forkFrom || stream.isLoading;

  // stream.toolCalls is flat for the whole thread, so pick this message's out. Keyed by
  // callId: a call mutates status in place, and an index key reuses the wrong card.
  const toolCalls = useMemo<AssembledToolCall[]>(() => {
    const ids = AIMessage.isInstance(message)
      ? new Set((message.tool_calls ?? []).map((tc) => tc.id))
      : new Set<string | undefined>();
    return ids.size ? stream.toolCalls.filter((tc) => ids.has(tc.callId)) : [];
  }, [stream.toolCalls, message]);

  if (HumanMessage.isInstance(message)) {
    if (isEditing && forkFrom) {
      return (
        <MessageEditor
          initialText={message.text}
          onCancel={() => setIsEditing(false)}
          onSave={(text) => {
            setIsEditing(false);
            fork.editAndRerun(forkFrom, text);
          }}
        />
      );
    }

    return (
      <div className="group" style={{ opacity: optimisticStatus === "pending" ? 0.6 : 1 }}>
        <HumanBubble>
          <Markdown>{message.text}</Markdown>
        </HumanBubble>
        <ForkControls
          align="right"
          canEdit
          disabled={forkDisabled}
          onEdit={() => setIsEditing(true)}
        />
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
      <div className="group space-y-2">
        {text && (
          <AIBubble>
            <Markdown>{text}</Markdown>
          </AIBubble>
        )}
        {text && (
          <ForkControls
            canEdit={false}
            disabled={forkDisabled}
            onRegenerate={() => forkFrom && fork.regenerate(forkFrom)}
          />
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
