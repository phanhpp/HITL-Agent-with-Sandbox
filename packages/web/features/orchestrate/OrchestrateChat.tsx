"use client";

import { Fragment, useMemo, useState } from "react";
import { useStream } from "@langchain/react";
import { AIMessage, HumanMessage } from "langchain";

import { ASSISTANTS, resolveAgentUrl } from "@/lib/agent";
import type { DeepAgentState } from "@/lib/state";
import { useHitl } from "@/lib/use-hitl";
import { useStopRun } from "@/lib/use-stop-run";
import type { ChatShellRenderProps } from "@/components/ChatShell";
import { ApprovalCard } from "@/components/ApprovalCard";
import { SplitView } from "@/components/layout/SplitView";
import { TodoPanel } from "@/components/panels/TodoPanel";
import { FilePanel } from "@/components/panels/FilePanel";
import { StopIcon } from "@/components/icons";
import { ChatContainer, ChatInput, PresetPrompts, TypingIndicator } from "@/components/playground";
import { CoordinatorTurn } from "./CoordinatorTurn";

const PRESETS = [
  "Write me a short brief comparing H3 and S2 spatial indexing",
  "Plan and research what makes a good incident postmortem",
];

/**
 * /orchestrate: a deep agent that plans, delegates and synthesises.
 *
 * Mirrors ApproveChat, with three differences:
 *
 *  - a sidebar, because the plan and the filesystem are state the transcript cannot show
 *  - subagent cards attached to the turn that delegated the work
 *  - NO branching. See the note on useHitl below.
 */
export function OrchestrateChat({ threadId, onThreadId, onLeave, reconnect }: ChatShellRenderProps) {
  const [apiUrl] = useState(resolveAgentUrl);

  const stream = useStream<DeepAgentState>({
    apiUrl,
    assistantId: ASSISTANTS.orchestrate,
    threadId,
    onThreadId,
  });

  const { isLoading } = stream;

  /*
   * useHitl with no checkpoint gate, and no useBranching on this page.
   *
   * Branching is deliberately off here. Nothing else on the page is branch-aware:
   * TodoPanel, FilePanel and the subagent cards all read `stream.values` /
   * `stream.subagents`, which are the THREAD's latest state, not the viewed branch. So
   * switching branches would confidently show another branch's plan. The stale
   * interrupt that `approvalPending` guards against is created by forking, so with no
   * fork UI it cannot arise.
   */
  const hitl = useHitl(stream);
  const { stopRun, isStopping } = useStopRun(stream, threadId);

  const messages = stream.messages;
  const todos = stream.values?.todos ?? [];
  const files = stream.values?.files ?? {};
  const pending = hitl.requests.length > 0;

  const subagents = useMemo(() => [...stream.subagents.values()], [stream.subagents]);
  /* Index by `s.id` from .values(), never by the Map key: the runtime key is the
     tool-call id but the TYPE narrows it to declared subagent names. */
  const subagentsByCallId = useMemo(
    () => new Map(subagents.map((s) => [s.id, s])),
    [subagents],
  );

  /* Approval cards sit under the message whose tool call is being reviewed, so they
     stay attached once another turn arrives. Same rule as /approve. */
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

  /* Every worker is done but the run continues: the coordinator is writing the final
     answer. Without this the page looks hung for the length of a synthesis. */
  const synthesising =
    isLoading && subagents.length > 0 && subagents.every((s) => s.status !== "running");

  return (
    <SplitView
      sidebar={
        <>
          <TodoPanel todos={todos} isPlanning={isLoading && todos.length === 0} />
          <FilePanel files={files} />
        </>
      }
    >
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
                  : "Ask for something that needs planning and research..."
              }
            />
            <div className="flex items-center gap-2">
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

              {isLoading && (
                <button
                  type="button"
                  onClick={async () => {
                    await stopRun();
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
        {messages.length === 0 && !isLoading && (
          <PresetPrompts prompts={PRESETS} onSelect={submit} />
        )}

        {messages.map((message, index) => (
          <Fragment key={message.id}>
            <CoordinatorTurn
              stream={stream}
              message={message}
              subagentsByCallId={subagentsByCallId}
              isLast={index === messages.length - 1}
            />
            {index === pendingIndex && approvalCards}
          </Fragment>
        ))}

        {synthesising ? (
          <p className="flex items-center gap-2 text-sm text-text-tertiary animate-pulse">
            <span>✦</span> Synthesising results…
          </p>
        ) : (
          isLoading && !pending && <TypingIndicator />
        )}

        {pendingIndex === -1 && approvalCards}
      </ChatContainer>
    </SplitView>
  );
}
