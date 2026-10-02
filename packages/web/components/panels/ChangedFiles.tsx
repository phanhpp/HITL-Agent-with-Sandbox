"use client";

import { useMemo } from "react";

import type { FileChange } from "@/lib/use-sandbox-files";
import { WORKDIR } from "@/lib/use-sandbox-files";

/**
 * "2 files changed, +14 −3" — what this run actually did to the filesystem.
 *
 * The counts come from `git diff --numstat` on the machine, not from re-diffing in the
 * browser. An earlier version parsed every changed file here on every stream tick to
 * produce the same numbers; git already has them, and it also knows about files that
 * were created or deleted, which comparing two maps of contents handles badly.
 */

const STATUS_LABEL: Record<FileChange["status"], string> = {
  modified: "modified",
  added: "new file",
  deleted: "deleted",
};

export function ChangedFiles({
  changes,
  onSelect,
}: {
  changes: FileChange[];
  onSelect: (path: string) => void;
}) {
  const rows = useMemo(
    () =>
      changes.map((change) => ({
        ...change,
        // Relative, because the /workspace prefix is on every row and tells you nothing.
        name: change.path.startsWith(WORKDIR + "/")
          ? change.path.slice(WORKDIR.length + 1)
          : change.path,
      })),
    [changes],
  );

  if (rows.length === 0) return null;

  const totals = rows.reduce(
    (acc, r) => ({
      additions: acc.additions + r.additions,
      deletions: acc.deletions + r.deletions,
    }),
    { additions: 0, deletions: 0 },
  );

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          Changed
        </h2>
        <span className="flex gap-1.5 text-xs tabular-nums">
          {totals.additions > 0 && <span className="text-success">+{totals.additions}</span>}
          {totals.deletions > 0 && <span className="text-error">−{totals.deletions}</span>}
        </span>
      </div>

      <ul className="-mx-1">
        {rows.map((row) => (
          <li key={row.path}>
            <button
              type="button"
              onClick={() => onSelect(row.path)}
              title={STATUS_LABEL[row.status]}
              className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text"
            >
              <span
                className={`shrink-0 font-mono text-[10px] ${
                  row.status === "added"
                    ? "text-success"
                    : row.status === "deleted"
                      ? "text-error"
                      : "text-warning"
                }`}
              >
                {row.status === "added" ? "A" : row.status === "deleted" ? "D" : "M"}
              </span>
              <span
                className={`truncate font-mono ${row.status === "deleted" ? "line-through" : ""}`}
              >
                {row.name}
              </span>
              <span className="ml-auto flex shrink-0 gap-1 tabular-nums">
                {row.additions > 0 && <span className="text-success">+{row.additions}</span>}
                {row.deletions > 0 && <span className="text-error">−{row.deletions}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
