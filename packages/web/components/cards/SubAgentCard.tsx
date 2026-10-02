"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { AIMessage } from "langchain";
import {
  useMessages,
  useToolCalls,
  type AnyStream,
  type AssembledToolCall,
  type SubagentDiscoverySnapshot,
} from "@langchain/react";

import { StatusBadge } from "@/components/cards/StatusBadge";
import { DurationDisplay } from "@/components/cards/DurationDisplay";
import { JsonViewer } from "@/components/cards/JsonViewer";
import { Markdown } from "@/components/Markdown";
import { ReasoningTrace } from "@/components/chat/ReasoningTrace";
import { reasoningText } from "@/lib/reasoning";

const TOOL_STATE_STYLES = {
  running: "text-primary",
  finished: "text-emerald-600 dark:text-emerald-400",
  error: "text-error",
} as const;

function ToolCallIcon({ state }: { state: "running" | "finished" | "error" }) {
  if (state === "running") {
    return (
      <svg className="w-3 h-3 text-primary animate-spin shrink-0" viewBox="0 0 24 24" fill="none">
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth={3}
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
        />
      </svg>
    );
  }
  if (state === "finished") {
    return (
      <svg className="w-3 h-3 text-emerald-500 shrink-0" viewBox="0 0 20 20" fill="currentColor">
        <path
          fillRule="evenodd"
          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
          clipRule="evenodd"
        />
      </svg>
    );
  }
  return (
    <svg className="w-3 h-3 text-error shrink-0" viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function SubagentToolCallRow({ toolCall }: { toolCall: AssembledToolCall }) {
  return (
    <div className={`flex items-center gap-1.5 text-xs ${TOOL_STATE_STYLES[toolCall.status]}`}>
      <ToolCallIcon state={toolCall.status} />
      <span className="font-mono font-semibold truncate">{toolCall.name}</span>
    </div>
  );
}

export function SubagentCard({
  stream,
  subagent,
  awaitingApproval = false,
}: {
  stream: AnyStream;
  subagent: SubagentDiscoverySnapshot;
  /** True while the page has an approval pending. See `paused` below. */
  awaitingApproval?: boolean;
}) {
  // Open while running, folded away once finished. This is not only cosmetic: the
  // body owns ref-counted subscriptions (see SubagentCardBody), so collapsing a
  // finished card is what releases them.
  const [open, setOpen] = useState(subagent.status === "running");
  const touched = useRef(false);

  useEffect(() => {
    // A manual toggle always wins over the automatic open/collapse.
    if (!touched.current) setOpen(subagent.status === "running");
  }, [subagent.status]);

  // `taskInput` is the instruction the coordinator actually gave this worker, which is
  // the useful subtitle. (This used to print the namespace, a debug string.)
  const subtitle = subagent.taskInput?.trim();

  /*
   * A subagent stopped at an approval reports status "error", which is not what
   * happened — it is waiting, not broken. Showing a red ✕ next to a card whose tool
   * call is sitting in an approval dialog reads as a failure the user caused.
   *
   * Note `subagent.error` is populated on a pause too, so it cannot be used to tell
   * the two apart — only the page knows an approval dialog is open. The trade-off is
   * that a helper which genuinely fails while an unrelated approval is pending reads
   * as waiting; that is rarer, and far less misleading than calling every pause a
   * failure.
   */
  const paused = subagent.status === "error" && awaitingApproval;
  const displayStatus = paused ? "pending" : subagent.status;

  const hasDuration =
    subagent.status === "running" ||
    (subagent.completedAt != null && +subagent.completedAt - +subagent.startedAt >= 100);

  return (
    <div className="rounded-lg border border-border bg-surface-secondary overflow-hidden flex flex-col">
      <button
        type="button"
        onClick={() => {
          touched.current = true;
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium text-text hover:bg-surface-tertiary transition-colors"
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className={`text-xs transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
          <span className="truncate">{subagent.name}</span>
        </span>
        <span className="flex items-center gap-2 shrink-0">
          {/* Suppressed when it would read "0.0s": after a rejoin the snapshots are
              rebuilt from the thread rather than observed live, so startedAt and
              completedAt collapse onto the same instant. A wrong duration is worse
              than none. */}
          {hasDuration && (
            <DurationDisplay
              startTime={+subagent.startedAt}
              endTime={subagent.completedAt ? +subagent.completedAt : undefined}
            />
          )}
          <StatusBadge
            status={displayStatus}
            label={paused ? "Awaiting approval" : undefined}
          />
        </span>
      </button>

      {open && (
        <div className="border-t border-border flex flex-col min-h-0">
          {subtitle && (
            <p className="px-3 pt-2 pb-1 text-xs text-text-tertiary line-clamp-2 m-0">
              {subtitle}
            </p>
          )}
          <SubagentCardBody stream={stream} subagent={subagent} paused={paused} />
        </div>
      )}
    </div>
  );
}

/**
 * The inside of an expanded card.
 *
 * This is a SEPARATE component, and that is the whole point: `useMessages` and
 * `useToolCalls` open ref-counted subscriptions for as long as they are mounted. With
 * the hooks in the card itself, every subagent in the thread streams whether or not
 * anyone has the card open. Mounted only when `open`, they are released on collapse.
 */
function SubagentCardBody({
  stream,
  subagent,
  paused,
}: {
  stream: AnyStream;
  subagent: SubagentDiscoverySnapshot;
  paused: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = useMessages(stream, subagent);
  const toolCalls = useToolCalls(stream, subagent);
  const running = subagent.status === "running";

  type ContentItem =
    | { kind: "reasoning"; message: (typeof messages)[number]; key: string }
    | { kind: "text"; content: string; key: string }
    | { kind: "tool_call"; call: AssembledToolCall; key: string };

  const contentItems = useMemo(() => {
    const items: ContentItem[] = [];
    const seen = new Set<string>();
    for (const msg of messages) {
      if (!AIMessage.isInstance(msg)) continue;
      // Reasoning first: `msg.text` excludes thinking blocks, so without this the
      // subagent's entire thought process is silently dropped.
      if (reasoningText(msg)) {
        items.push({ kind: "reasoning", message: msg, key: `r-${msg.id}` });
      }
      if (msg.text.trim()) {
        items.push({ kind: "text", content: msg.text, key: `text-${msg.id}` });
      }
      const ids = new Set(msg.tool_calls?.map((t) => t.id) ?? []);
      for (const tc of toolCalls) {
        if (ids.has(tc.callId) && !seen.has(tc.callId)) {
          seen.add(tc.callId);
          items.push({ kind: "tool_call", call: tc, key: `tc-${tc.callId}` });
        }
      }
    }
    return items;
  }, [messages, toolCalls]);

  useEffect(() => {
    if (scrollRef.current && running) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [contentItems.length, running]);

  return (
    <div
      ref={scrollRef}
      className="px-3 py-2 overflow-y-auto space-y-1.5"
      style={{ maxHeight: "12rem" }}
    >
      {contentItems.map((item, i) =>
        item.kind === "reasoning" ? (
          <ReasoningTrace
            key={item.key}
            message={item.message}
            variant="inline"
            isStreaming={running && i === contentItems.length - 1}
          />
        ) : item.kind === "text" ? (
          <div key={item.key} className="text-sm text-text-secondary">
            <Markdown>{item.content}</Markdown>
            {running && i === contentItems.length - 1 && (
              <span className="animate-pulse ml-0.5 text-primary">▌</span>
            )}
          </div>
        ) : (
          <SubagentToolCallRow key={item.key} toolCall={item.call} />
        ),
      )}

      {contentItems.length === 0 &&
        (running ? (
          <div className="flex items-center gap-1.5 text-text-tertiary">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="w-1.5 h-1.5 rounded-full bg-current animate-bounce"
                style={{ animationDelay: `${i * 150}ms` }}
              />
            ))}
            <span className="text-xs ml-1">Working…</span>
          </div>
        ) : paused ? (
          <p className="text-xs text-text-tertiary m-0">Waiting for your approval…</p>
        ) : subagent.status === "error" ? (
          // The snapshot carries the actual message; a generic sentence wastes it.
          <p className="text-xs text-error m-0">{subagent.error ?? "This subagent failed."}</p>
        ) : (
          // Re-opening a finished card remounts the selector hooks on a namespace whose
          // events are long past, so the scoped stream can come back empty. The
          // snapshot's own output is the fallback.
          <SubagentOutput output={subagent.output} />
        ))}
    </div>
  );
}

/** `SubagentDiscoverySnapshot.output` is typed `unknown`, so never render it as text. */
function SubagentOutput({ output }: { output: unknown }) {
  if (output == null) return null;
  if (typeof output === "string") {
    return (
      <div className="text-sm text-text-secondary">
        <Markdown>{output}</Markdown>
      </div>
    );
  }
  return <JsonViewer data={output} />;
}
