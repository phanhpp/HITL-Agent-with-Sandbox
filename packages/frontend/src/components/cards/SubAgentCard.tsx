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
import { Markdown } from "@/components/Markdown";

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
}: {
  stream: AnyStream;
  subagent: SubagentDiscoverySnapshot;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(true);

  const messages = useMessages(stream, subagent);
  const toolCalls = useToolCalls(stream, subagent);

  const statusMap: Record<string, "pending" | "running" | "complete" | "error"> = {
    pending: "pending",
    running: "running",
    complete: "complete",
    error: "error",
  };
  const status = statusMap[subagent.status] ?? "running";

  type ContentItem =
    | { kind: "text"; content: string; key: string }
    | { kind: "tool_call"; call: AssembledToolCall; key: string };

  const contentItems = useMemo(() => {
    const items: ContentItem[] = [];
    const seenToolCallIds = new Set<string>();
    for (const msg of messages) {
      if (!AIMessage.isInstance(msg)) continue;
      if (msg.text.trim()) {
        items.push({ kind: "text", content: msg.text, key: `text-${msg.id}` });
      }
      const msgToolCallIds = new Set(msg.tool_calls?.map((t) => t.id) ?? []);
      for (const tc of toolCalls) {
        if (msgToolCallIds.has(tc.callId) && !seenToolCallIds.has(tc.callId)) {
          seenToolCallIds.add(tc.callId);
          items.push({ kind: "tool_call", call: tc, key: `tc-${tc.callId}` });
        }
      }
    }
    return items;
  }, [messages, toolCalls]);

  // Title / description: pulled from the subagent name and namespace.
  const title = subagent.name ?? "Subagent";
  const taskDescription = `Namespace: ${subagent.namespace.join("/") || "(root)"}`;

  useEffect(() => {
    if (status === "running") setOpen(true);
  }, [status]);

  useEffect(() => {
    if (scrollRef.current && status === "running") {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [contentItems.length, status]);

  return (
    <div
      className="rounded-lg border border-border bg-surface-secondary overflow-hidden flex flex-col"
      data-testid="sdk-preview-chat-turn"
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium text-text hover:bg-surface-tertiary transition-colors"
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className={`text-xs transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
          <span className="truncate">{title}</span>
        </span>
        <StatusBadge status={status} />
      </button>

      {open && (
        <div className="border-t border-border flex flex-col min-h-0">
          <p className="px-3 pt-2 pb-1 text-xs text-text-tertiary truncate m-0">
            {taskDescription}
          </p>

          <div
            ref={scrollRef}
            className="px-3 py-2 overflow-y-auto space-y-1.5"
            style={{ maxHeight: "12rem" }}
          >
            {contentItems.map((item, i) =>
              item.kind === "text" ? (
                <div key={item.key} className="text-sm text-text-secondary">
                  <Markdown>{item.content}</Markdown>
                  {status === "running" && i === contentItems.length - 1 && (
                    <span className="animate-pulse ml-0.5 text-primary">▌</span>
                  )}
                </div>
              ) : (
                <SubagentToolCallRow key={item.key} toolCall={item.call} />
              ),
            )}

            {contentItems.length === 0 &&
              (status === "running" || status === "pending" ? (
                <div className="flex items-center gap-1.5 text-text-tertiary">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="w-1.5 h-1.5 rounded-full bg-current animate-bounce"
                      style={{ animationDelay: `${i * 150}ms` }}
                    />
                  ))}
                  <span className="text-xs ml-1">
                    {status === "pending" ? "Queued…" : "Working…"}
                  </span>
                </div>
              ) : status === "error" ? (
                <p className="text-xs text-error m-0">
                  An error occurred while running this subagent.
                </p>
              ) : null)}
          </div>
        </div>
      )}
    </div>
  );
}
