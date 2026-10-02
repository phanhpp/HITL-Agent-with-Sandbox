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
import { useHitl, type HitlState } from "@/lib/use-hitl";
import type { ChatShellRenderProps } from "@/components/ChatShell";
import { ApprovalCard } from "@/components/ApprovalCard";
import { ToolCallCard } from "@/components/ToolCallCard";
import { ForkControls, MessageEditor, useFork } from "@/components/ForkControls";
import { useBranching, type BranchInfo } from "@/lib/use-branching";
import { BranchSwitcher } from "@/components/BranchSwitcher";
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
export function ApproveChat({ threadId, onThreadId, onLeave, reconnect }: ChatShellRenderProps) {
  // Reads window, so compute lazily rather than at module scope.
  const [apiUrl] = useState(resolveAgentUrl);

  const stream = useStream<AgentState>({
    apiUrl,
    assistantId: ASSISTANTS.approve,
    threadId,
    onThreadId,
  });

  const { isLoading } = stream;

  // Fork points, branch info and the branch tip. See lib/use-branching.ts.
  const branching = useBranching(stream, threadId);
  // Gated on the branch checkpoint so a forked-away interrupt stops rendering a card.
  const hitl = useHitl(stream, branching.approvalPending);
  // Branch history when idle, live stream while running. See lib/use-branching.ts.
  const messages = branching.selectMessages(stream.messages);
  const { stopRun, isStopping } = useStopRun(stream, threadId);
  const pending = hitl.groups.length > 0;
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
    if (hitl.groups.length === 0) return -1;
    const names = new Set(hitl.groups.flatMap((g) => g.requests).map((r) => r.name));
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (AIMessage.isInstance(m) && (m.tool_calls ?? []).some((tc) => names.has(tc.name))) {
        return i;
      }
    }
    return -1;
  }, [hitl.groups, messages]);

  const approvalCards =
    pending && !hitl.isProcessing ? <ApprovalCards hitl={hitl} /> : null;

  const submit = (text: string) => {
    // Anchor to the tip of the branch on screen. Without this the SDK appends to the
    // thread's "latest" checkpoint, so after switching branches a new message would
    // silently jump back to the newest one.
    const tip = branching.branchTipCheckpointId;
    void stream.submit(
      { messages: [new HumanMessage(text)] },
      tip != null ? { forkFrom: tip } : undefined,
    );
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
                onClick={async () => {
                  await stopRun();
                  // Re-read the thread. After a cancel the client still holds whatever
                  // it streamed, and an optimistic message whose run never persisted
                  // lingers as "Failed to send" even though the user stopped it on
                  // purpose. Rebuilding makes the view match the server.
                  reconnect();
                }}
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
            branchInfo={branching.metadataFor(message.id)}
            activeBranch={branching.activeBranch}
            onSwitchBranch={branching.switchBranch}
            onFork={branching.markFork}
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
  branchInfo,
  activeBranch,
  onSwitchBranch,
  onFork,
}: {
  stream: AnyStream;
  message: BaseMessage;
  branchInfo: BranchInfo;
  activeBranch: string;
  onSwitchBranch: (branch: string) => void;
  /** Tells the hook to move the view onto the branch this fork creates. */
  onFork: (forkFromId: string) => void;
}) {
  const forkFrom = branchInfo.parentCheckpointId;
  const siblings = branchInfo.siblingBranches;
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

  const switcher = siblings && siblings.length > 1 && (
    <div className="flex justify-center my-2">
      <BranchSwitcher
        siblingBranches={siblings}
        currentBranch={branchInfo.branch ?? activeBranch}
        onSwitch={onSwitchBranch}
        disabled={stream.isLoading}
      />
    </div>
  );

  if (HumanMessage.isInstance(message)) {
    if (isEditing && forkFrom) {
      return (
        <MessageEditor
          initialText={message.text}
          onCancel={() => setIsEditing(false)}
          onSave={(text) => {
            setIsEditing(false);
            onFork(forkFrom);
            fork.editAndRerun(forkFrom, text);
          }}
        />
      );
    }

    return (
      <div className="group" style={{ opacity: optimisticStatus === "pending" ? 0.6 : 1 }}>
        {switcher}
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
        {switcher}
        {text && (
          <AIBubble>
            <Markdown>{text}</Markdown>
          </AIBubble>
        )}
        {text && (
          <ForkControls
            canEdit={false}
            disabled={forkDisabled}
            onRegenerate={() => {
              if (!forkFrom) return;
              onFork(forkFrom);
              fork.regenerate(forkFrom);
            }}
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

/**
 * One approval card per pending interrupt, and per action within it.
 *
 * Several interrupts can be pending at once (two parallel subagents each writing a
 * file). Rendering only the first silently hides the others, and answering without an
 * id can resolve a different one than the card shown.
 */
function ApprovalCards({ hitl }: { hitl: HitlState }) {
  return (
    <div className="pl-9 max-w-[80%] space-y-3">
      {hitl.groups.map((group) =>
        group.requests.map((actionRequest, idx) => (
          <ApprovalCard
            key={`${group.id}-${idx}`}
            actionRequest={actionRequest}
            reviewConfig={group.reviewConfigs[idx]}
            onApprove={() => hitl.approve(group.id, idx)}
            onReject={(reason) => hitl.reject(group.id, idx, reason)}
            onEdit={(editedArgs) => hitl.edit(group.id, idx, editedArgs)}
            isProcessing={hitl.isProcessing}
            decision={group.decisions[idx]}
          />
        )),
      )}
    </div>
  );
}
