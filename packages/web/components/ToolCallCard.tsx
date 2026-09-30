"use client";

import type { AssembledToolCall } from "@langchain/react";
import { JsonViewer } from "@/components/cards/JsonViewer";

/**
 * One tool call, from stream.toolCalls (GUIDE.md 7.1).
 *
 * The same call mutates status in place, "running" -> "finished" | "error", so
 * the parent must key these by tc.callId. Keying by array index makes React
 * reuse the wrong card when several calls are in flight.
 */
const STATUS_STYLE: Record<AssembledToolCall["status"], { label: string; className: string }> = {
  running: { label: "running", className: "text-warning" },
  finished: { label: "finished", className: "text-success" },
  error: { label: "error", className: "text-error" },
};

export function ToolCallCard({ toolCall }: { toolCall: AssembledToolCall }) {
  const status = STATUS_STYLE[toolCall.status];

  return (
    <div className="rounded-lg border border-border bg-surface-secondary overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-border">
        <code className="text-xs font-mono text-text">{toolCall.name}</code>
        <span className={`text-xs font-mono ${status.className}`}>
          {toolCall.status === "running" && (
            <span className="inline-block mr-1 animate-pulse">●</span>
          )}
          {status.label}
        </span>
      </div>

      <div className="px-3 py-2 space-y-2">
        <div>
          <div className="text-xs text-text-tertiary mb-1">arguments</div>
          <JsonViewer data={toolCall.input} maxHeight={120} />
        </div>

        {toolCall.status === "finished" && toolCall.output != null && (
          <div>
            <div className="text-xs text-text-tertiary mb-1">result</div>
            <JsonViewer data={toolCall.output} maxHeight={160} />
          </div>
        )}

        {toolCall.status === "error" && toolCall.error && (
          <div>
            <div className="text-xs text-error mb-1">error</div>
            <pre className="text-xs font-mono text-error whitespace-pre-wrap wrap-break-word">
              {toolCall.error}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
