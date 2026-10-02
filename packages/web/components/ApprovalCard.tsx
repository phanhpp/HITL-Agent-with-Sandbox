"use client";

import { useState } from "react";
import type { ActionRequest, ReviewConfig } from "langchain";

interface ApprovalCardProps {
  actionRequest: ActionRequest;
  reviewConfig?: ReviewConfig;
  onApprove: () => void;
  onReject: (reason: string) => void;
  onEdit: (editedArgs: Record<string, unknown>) => void;
  isProcessing: boolean;
  /**
   * Set once the user has decided THIS action while a sibling action in the same
   * interrupt is still undecided. Nothing is sent until every action has a decision,
   * so without this the card reads as a dead button.
   */
  decision?: "approve" | "edit" | "reject";
}

/** Past tense, because by the time it shows the click has already happened. */
const DECIDED_LABEL = {
  approve: "Approved",
  edit: "Edited",
  reject: "Rejected",
} as const;

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
    </svg>
  );
}

function PencilIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125"
      />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
    </svg>
  );
}

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.249-8.25-3.285Z"
      />
    </svg>
  );
}

export function ApprovalCard({
  actionRequest,
  reviewConfig,
  onApprove,
  onReject,
  onEdit,
  isProcessing,
  decision,
}: ApprovalCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editedArgs, setEditedArgs] = useState<Record<string, unknown>>(actionRequest.args);
  const [rejectReason, setRejectReason] = useState("");
  const [showRejectInput, setShowRejectInput] = useState(false);

  const allowed = reviewConfig?.allowedDecisions ?? ["approve", "reject"];
  const canEdit = allowed.includes("edit");
  const canReject = allowed.includes("reject");

  if (isEditing) {
    return (
      <div
        className="rounded-xl border border-border bg-surface overflow-hidden"
        data-testid="sdk-preview-chat-turn"
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-surface-secondary">
          <PencilIcon className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-text">
            Edit —{" "}
            <code className="font-mono text-xs bg-surface-tertiary px-1.5 py-0.5 rounded">
              {actionRequest.name}
            </code>
          </span>
        </div>
        <div className="p-4 space-y-3">
          {Object.entries(editedArgs).map(([key, value]) => {
            const strValue = formatValue(value);
            const isLong = strValue.length > 80 || strValue.includes("\n");
            return (
              <div key={key}>
                <label
                  htmlFor={`edit-${key}`}
                  className="block text-xs font-medium text-text-secondary mb-1.5"
                >
                  {key}
                </label>
                {isLong ? (
                  <textarea
                    id={`edit-${key}`}
                    value={strValue}
                    onChange={(e) => setEditedArgs((prev) => ({ ...prev, [key]: e.target.value }))}
                    rows={4}
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary resize-y"
                  />
                ) : (
                  <input
                    id={`edit-${key}`}
                    type="text"
                    value={strValue}
                    onChange={(e) => setEditedArgs((prev) => ({ ...prev, [key]: e.target.value }))}
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                  />
                )}
              </div>
            );
          })}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                onEdit(editedArgs);
                setIsEditing(false);
              }}
              disabled={isProcessing}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary-dark px-3.5 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              <CheckIcon className="h-3.5 w-3.5" />
              Save & Approve
            </button>
            <button
              type="button"
              onClick={() => {
                setEditedArgs(actionRequest.args);
                setIsEditing(false);
              }}
              className="inline-flex items-center rounded-lg border border-border bg-surface px-3.5 py-2 text-sm font-medium text-text-secondary hover:bg-surface-secondary transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border border-border bg-surface overflow-hidden"
      data-testid="sdk-preview-chat-turn"
    >
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-surface-secondary">
        <ShieldIcon className={`h-4 w-4 ${decision ? "text-text-tertiary" : "text-warning"}`} />
        <span className="text-sm font-medium text-text">Review Required</span>
        <span
          className={`ml-auto text-[11px] font-medium px-2 py-0.5 rounded-full text-white ${
            decision ? "bg-text-tertiary" : "bg-warning"
          }`}
        >
          {decision ? DECIDED_LABEL[decision] : "Awaiting Approval"}
        </span>
      </div>

      <div className="p-4 space-y-3">
        <div className="rounded-lg bg-surface-tertiary border border-border p-3">
          <code className="text-sm font-mono font-semibold text-text">{actionRequest.name}</code>
          {actionRequest.description && (
            <p className="text-xs text-text-tertiary mt-1">{actionRequest.description}</p>
          )}

          <div className="mt-2.5 space-y-2">
            {Object.entries(actionRequest.args).map(([key, value]) => {
              const strValue = formatValue(value);
              const isMultiline = strValue.includes("\n");
              return (
                <div key={key}>
                  <div className="text-[11px] font-medium text-text-tertiary uppercase tracking-wider mb-0.5">
                    {key}
                  </div>
                  {isMultiline ? (
                    <pre className="text-sm text-text whitespace-pre-wrap wrap-break-word font-mono bg-surface rounded-md px-2.5 py-1.5 border border-border">
                      {strValue}
                    </pre>
                  ) : (
                    <div className="text-sm text-text wrap-break-word">{strValue}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {showRejectInput && (
          <div className="space-y-2">
            <label
              htmlFor="reject-reason"
              className="block text-xs font-medium text-text-secondary"
            >
              Reason for rejection{" "}
              <span className="text-text-tertiary font-normal">(optional)</span>
            </label>
            <input
              id="reject-reason"
              type="text"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Enter reason..."
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-red-400/30 focus:border-red-400"
            />
          </div>
        )}

        {decision ? (
          <p className="text-xs text-text-tertiary">
            {DECIDED_LABEL[decision]} — waiting on the other action in this request before
            anything runs.
          </p>
        ) : (
        <div className="flex flex-wrap items-center gap-2">
          {showRejectInput ? (
            <>
              <button
                type="button"
                onClick={() => {
                  onReject(rejectReason || "User rejected");
                  setShowRejectInput(false);
                }}
                disabled={isProcessing}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 hover:bg-red-700 px-3.5 py-2 text-sm font-medium text-white transition-colors disabled:opacity-40"
              >
                <XIcon className="h-3.5 w-3.5" />
                Confirm Rejection
              </button>
              <button
                type="button"
                onClick={() => setShowRejectInput(false)}
                className="inline-flex items-center rounded-lg border border-border bg-surface px-3.5 py-2 text-sm font-medium text-text-secondary hover:bg-surface-secondary transition-colors"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onApprove}
                disabled={isProcessing}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500 px-3.5 py-2 text-sm font-medium text-white transition-colors disabled:opacity-40"
              >
                <CheckIcon className="h-3.5 w-3.5" />
                Approve
              </button>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => setIsEditing(true)}
                  disabled={isProcessing}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3.5 py-2 text-sm font-medium text-text-secondary hover:bg-surface-secondary transition-colors disabled:opacity-40"
                >
                  <PencilIcon className="h-3.5 w-3.5" />
                  Edit
                </button>
              )}
              {canReject && (
                <button
                  type="button"
                  onClick={() => setShowRejectInput(true)}
                  disabled={isProcessing}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3.5 py-2 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors disabled:opacity-40"
                >
                  <XIcon className="h-3.5 w-3.5" />
                  Reject
                </button>
              )}
            </>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
