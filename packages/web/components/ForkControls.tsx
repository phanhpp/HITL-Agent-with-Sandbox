"use client";

import { useState } from "react";
import { useMessageMetadata, type AnyStream } from "@langchain/react";
import { HumanMessage, type BaseMessage } from "langchain";
import { PencilIcon, RefreshIcon } from "./icons";

/**
 * Branching, per GUIDE.md 8.1. Shared by every page.
 *
 * Every message records the checkpoint from just BEFORE it was created. Editing or
 * regenerating starts a new run from that checkpoint, so the thread becomes a tree:
 * the old answer is not deleted, it stays in checkpoint history.
 *
 * `forkFrom` is a plain checkpoint id string in the installed SDK, not an object —
 * GUIDE.md:2413 flags that the docs disagree, and the types win.
 */

/** The checkpoint to fork from, or undefined if this message cannot be forked. */
export function useForkFrom(stream: AnyStream, messageId: string | undefined) {
  return useMessageMetadata(stream, messageId)?.parentCheckpointId;
}

/**
 * Hover controls for one message.
 *
 * Editing needs to replace the message bubble, which only the parent can do, so this
 * reports the intent via onEdit and the parent renders <MessageEditor>.
 */
export function ForkControls({
  align = "left",
  canEdit,
  disabled,
  onEdit,
  onRegenerate,
}: {
  align?: "left" | "right";
  canEdit: boolean;
  disabled: boolean;
  onEdit?: () => void;
  onRegenerate?: () => void;
}) {
  const base =
    "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-text-tertiary hover:text-text hover:bg-surface-secondary disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors";

  return (
    <div
      className={`flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity ${
        align === "right" ? "justify-end" : ""
      }`}
    >
      {canEdit && onEdit && (
        <button
          type="button"
          onClick={onEdit}
          disabled={disabled}
          className={base}
          title={disabled ? "Wait for the agent to finish" : "Edit and re-run from here"}
        >
          <PencilIcon className="size-3" />
          Edit
        </button>
      )}
      {onRegenerate && (
        <button
          type="button"
          onClick={onRegenerate}
          disabled={disabled}
          className={base}
          title={disabled ? "Wait for the agent to finish" : "Regenerate this reply"}
        >
          <RefreshIcon className="size-3" />
          Retry
        </button>
      )}
    </div>
  );
}

/** Inline editor shown in place of a human message bubble. */
export function MessageEditor({
  initialText,
  onCancel,
  onSave,
}: {
  initialText: string;
  onCancel: () => void;
  onSave: (text: string) => void;
}) {
  const [draft, setDraft] = useState(initialText);
  const unchanged = draft.trim() === initialText.trim() || !draft.trim();

  return (
    <div className="rounded-xl border border-primary/40 bg-surface p-3 space-y-2">
      <textarea
        autoFocus
        rows={Math.min(8, Math.max(2, draft.split("\n").length))}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          // Enter sends, Shift+Enter makes a newline — same as the composer.
          if (e.key === "Enter" && !e.shiftKey && !unchanged) {
            e.preventDefault();
            onSave(draft.trim());
          }
        }}
        className="w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onSave(draft.trim())}
          disabled={unchanged}
          className="inline-flex items-center rounded-lg bg-primary-dark px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40 transition-opacity"
        >
          Save &amp; re-run
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:text-text transition-colors"
        >
          Cancel
        </button>
        <span className="text-xs text-text-tertiary">
          Re-runs from before this message; the old branch stays in history
        </span>
      </div>
    </div>
  );
}

/** Fork actions bound to a stream, so pages do not repeat the submit shapes. */
export function useFork(stream: AnyStream) {
  return {
    /** Replace a human message and re-run from its checkpoint. */
    editAndRerun: (forkFrom: string, text: string) =>
      void stream.submit({ messages: [new HumanMessage(text)] }, { forkFrom }),
    /** Re-run the same turn. `undefined` input, not {} — GUIDE.md 8.1. */
    regenerate: (forkFrom: string) => void stream.submit(undefined, { forkFrom }),
  };
}

export type { BaseMessage };
