"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  useStream,
  useToolCalls,
  type AnyStream,
  type SubagentDiscoverySnapshot,
} from "@langchain/react";
import { AIMessage, HumanMessage } from "langchain";

import { ASSISTANTS, resolveAgentUrl } from "@/lib/agent";
import type { DeepAgentState } from "@/lib/state";
import { useHitl, type HitlState } from "@/lib/use-hitl";
import { useStopRun } from "@/lib/use-stop-run";
import { useFeedback } from "@/lib/use-feedback";
import { FILE_MUTATING_TOOLS, useSandboxFiles } from "@/lib/use-sandbox-files";
import type { ChatShellRenderProps } from "@/components/ChatShell";
import { ApprovalCard } from "@/components/ApprovalCard";
import { SplitView } from "@/components/layout/SplitView";
import { IdeView } from "@/components/layout/IdeView";
import { TodoPanel } from "@/components/panels/TodoPanel";
import { FilePanel } from "@/components/panels/FilePanel";
import { SandboxTree } from "@/components/panels/SandboxTree";
import { ChangedFiles } from "@/components/panels/ChangedFiles";
/*
 * Loaded only when a file is opened. `CodeViewer` pulls in @pierre/diffs, which pulls in
 * Shiki and its grammars — a large chunk that has no business being in the initial
 * bundle of a page most visitors use purely as a chat.
 */
const CodeViewer = dynamic(
  () => import("@/components/panels/CodeViewer").then((m) => m.CodeViewer),
  { ssr: false, loading: () => <p className="p-4 text-sm text-text-tertiary">Opening…</p> },
);
import { StopIcon } from "@/components/icons";
import { ChatContainer, ChatInput, PresetPrompts, TypingIndicator } from "@/components/playground";
import { CoordinatorTurn } from "./CoordinatorTurn";

/** The only subagent with a machine of its own. Matches agents/orchestrator.py. */
const CODER_SUBAGENT = "coder";

const PRESETS = [
  "Write me a short brief comparing H3 and S2 spatial indexing",
  "Plan and research what makes a good incident postmortem",
  "A test is failing in /workspace — find the bug, fix it, and run the tests",
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
   * No branching on this page. Edit/Retry was built and reverted — see
   * docs/DEEP_GUIDE.md section 7 for the three defects it produced. In short: the
   * panels and the approval card read thread-level state, so forking makes them
   * disagree with the transcript, and one of those disagreements puts the wrong
   * arguments on an approval card.
   */
  const hitl = useHitl(stream);
  const { stopRun, isStopping } = useStopRun(stream, threadId);
  const sandbox = useSandboxFiles(threadId);
  // Run ids come from graph state, so the controls survive a reload.
  const feedback = useFeedback(stream, threadId);
  const [viewMode, setViewMode] = useState<"code" | "diff">("code");

  const messages = stream.messages;
  const todos = stream.values?.todos ?? [];
  const files = stream.values?.files ?? {};
  const pending = hitl.groups.length > 0;

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

  const { refreshPath, refreshAll } = sandbox;

  /*
   * Which subagents own a sandbox. Only the coder does — the researchers share the
   * supervisor's StateBackend, so nothing they write is on a machine.
   */
  const sandboxSubagents = useMemo(
    () => subagents.filter((s) => s.name === CODER_SUBAGENT),
    [subagents],
  );

  const submit = (text: string) => {
    // The baseline for every diff is the filesystem as it stood when the user asked.
    sandbox.takeSnapshot();
    void stream.submit({ messages: [new HumanMessage(text)] });
  };

  /* Every worker is done but the run continues: the coordinator is writing the final
     answer. Without this the page looks hung for the length of a synthesis. */
  const synthesising =
    isLoading && subagents.length > 0 && subagents.every((s) => s.status !== "running");

  /* One mutation handler for every watcher. `write_file`/`edit_file`/`delete` name a
     single path; `execute` is a shell command that can touch anything, so it re-reads
     the whole tree. An unexpected argument shape also re-reads everything rather than
     silently skipping the update. */
  const onMutation = useCallback(
    (name: string, args: Record<string, unknown>) => {
      const path = args.file_path ?? args.path;
      if (name !== "execute" && typeof path === "string") refreshPath(path);
      else refreshAll();
    },
    [refreshPath, refreshAll],
  );

  /*
   * Re-read the sandbox whenever a sandbox-backed subagent changes state.
   *
   * This is the backstop, and it is not redundant with SandboxWatcher. The watcher only
   * sees tool calls that arrive after it mounts, and it cannot mount until the subagent
   * has been discovered — so a short run, where the coder is discovered and finishes in
   * the same breath, produces NO watcher events at all. Measured: a 17.9s run edited a
   * file, the agent reported success, and the panel never moved.
   *
   * A snapshot's status needs no subscription, so this fires regardless of timing:
   * once when the coder appears (which is also what switches the page into IDE mode,
   * since the machine is created when the graph is built), and again when it finishes.
   * The watcher still earns its place on a long run by updating during the work rather
   * than only at the end.
   */
  const subagentStates = sandboxSubagents.map((s) => `${s.id}:${s.status}`).join("|");
  useEffect(() => {
    if (subagentStates) refreshAll();
  }, [subagentStates, refreshAll]);

  /* The sandbox decides the layout. A thread that never asked for code has no machine,
     the tree route answers `sandboxId: null`, and the page stays as it was — an empty
     code pane is worse than no code pane, and most conversations here never write code. */
  const isIde = sandbox.sandboxId !== null;

  const selectFile = (path: string) => {
    sandbox.selectFile(path);
    // Open on the diff when there is one: for a file the agent just changed, the change
    // is the thing the user came to look at.
    setViewMode(sandbox.changedFiles.has(path) ? "diff" : "code");
  };

  const watchers = sandboxSubagents.map((subagent) => (
    <SandboxWatcher
      key={subagent.id}
      stream={stream}
      subagent={subagent}
      onMutation={onMutation}
    />
  ));

  const chat = (
      <ChatContainer
        embedded
        className={isIde ? "w-full" : "max-w-3xl mx-auto w-full"}
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
              awaitingApproval={pending}
              feedback={feedback}
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
        {watchers}
      </ChatContainer>
  );

  const plan = <TodoPanel todos={todos} isPlanning={isLoading && todos.length === 0} />;

  if (!isIde) {
    return (
      <SplitView
        sidebar={
          <>
            {plan}
            <FilePanel files={files} />
          </>
        }
      >
        {chat}
      </SplitView>
    );
  }

  return (
    <IdeView
      files={
        <>
          {plan}
          <SandboxTree
            tree={sandbox.tree}
            selectedFile={sandbox.selectedFile}
            changedFiles={sandbox.changedFiles}
            expandedDirs={sandbox.expandedDirs}
            onSelect={selectFile}
            onToggle={sandbox.toggleDir}
            isLoading={sandbox.isLoading}
          />
          <ChangedFiles changes={sandbox.changes} onSelect={selectFile} />
          {/* The supervisor's own filesystem is still there and still worth showing, but
              it is no longer the headline once a real machine is in play. */}
          <FilePanel files={files} />
        </>
      }
      code={
        sandbox.selectedFile === null ? null : (
        <CodeViewer
          selectedFile={sandbox.selectedFile}
          content={sandbox.selectedFile ? sandbox.files[sandbox.selectedFile] : undefined}
          originalContent={
            sandbox.selectedFile ? sandbox.originalFiles[sandbox.selectedFile] : undefined
          }
          isChanged={sandbox.selectedFile ? sandbox.changedFiles.has(sandbox.selectedFile) : false}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          isLoading={sandbox.isLoading}
          onClose={sandbox.closeFile}
        />
        )
      }
    >
      {chat}
    </IdeView>
  );
}

/**
 * One approval card per pending interrupt, and per action within it.
 *
 * Several interrupts can be pending at once (two parallel subagents each writing a
 * file). Rendering only the first silently hides the others, and answering without an
 * id can resolve a different one than the card shown.
 */
/**
 * Watches one sandbox-backed subagent and re-reads its filesystem when it changes it.
 *
 * WHY THIS IS NOT AN EFFECT ON `stream.messages`. The official reference watches the root
 * message list for `ToolMessage`s from file-mutating tools, and that works there because
 * its agent is a single deep agent — every tool call it makes is at the root. Here the
 * writing is done by a SUBAGENT, so its `execute` and `edit_file` live in that subagent's
 * namespace and never appear in `stream.messages`. Measured: the root list showed only
 * the supervisor's `task` call, and the panel never refreshed.
 *
 * `useToolCalls(stream, subagent)` is the namespaced view, and `status === "finished"`
 * means the result has landed — the same "wait for the result, never the call" rule, which
 * matters because keying on the call races the write.
 *
 * It renders nothing. It exists to hold a subscription, which is why it is scoped to the
 * coder: those subscriptions are ref-counted, so watching every subagent would keep one
 * open per researcher for no benefit.
 */
function SandboxWatcher({
  stream,
  subagent,
  onMutation,
}: {
  stream: AnyStream;
  subagent: SubagentDiscoverySnapshot;
  onMutation: (name: string, args: Record<string, unknown>) => void;
}) {
  const toolCalls = useToolCalls(stream, subagent);
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const call of toolCalls) {
      if (call.status !== "finished") continue;
      if (!FILE_MUTATING_TOOLS.has(call.name)) continue;
      // Never cleared: call ids are unique, and clearing it would re-fire every
      // historical write on the next turn.
      if (seen.current.has(call.callId)) continue;
      seen.current.add(call.callId);
      onMutation(call.name, (call.args ?? {}) as Record<string, unknown>);
    }
  }, [toolCalls, onMutation]);

  return null;
}

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
