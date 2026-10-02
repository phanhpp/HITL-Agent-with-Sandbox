"use client";

import { useMemo } from "react";
import { File as PierreFile, FileDiff } from "@pierre/diffs/react";
import { parseDiffFromFile } from "@pierre/diffs";

import { usePierreTheme } from "@/lib/use-color-scheme";

/**
 * The centre column: one file, as code or as a diff.
 *
 * `@pierre/diffs` has been a dependency of this repo for a while and imported nowhere;
 * this is its first use. It renders through Shiki, which is why it needs a theme NAME
 * rather than CSS classes — see lib/use-color-scheme.ts.
 *
 * `disableWorkerPool` is not optional here. Pierre highlights in a web worker by
 * default, and under Next.js/Turbopack that worker does not resolve — the component
 * renders an empty `<diffs-container>` and reports nothing, which is a very quiet way to
 * show a blank pane. Highlighting on the main thread is fine for files this size.
 *
 * The file is named by its BASENAME on purpose. Pierre picks the language from that name,
 * so the extension has to survive; passing the full path works too but puts the whole
 * `/workspace/...` prefix in the header.
 */

function basename(path: string): string {
  return path.split("/").pop() || path;
}

export function CodeViewer({
  selectedFile,
  content,
  originalContent,
  isChanged,
  viewMode,
  onViewModeChange,
  isLoading,
  onClose,
}: {
  selectedFile: string | null;
  content: string | undefined;
  originalContent: string | undefined;
  isChanged: boolean;
  viewMode: "code" | "diff";
  onViewModeChange: (mode: "code" | "diff") => void;
  isLoading: boolean;
  onClose: () => void;
}) {
  const theme = usePierreTheme();
  const name = selectedFile ? basename(selectedFile) : "";

  const diff = useMemo(() => {
    if (!isChanged || !selectedFile || content === undefined) return null;
    try {
      /* `?? ""` matters: a file the agent CREATED has no original. The reference bails
         when original is undefined, so a new file gets a "modified" badge and a dot in
         the tree but no diff to look at. An empty left side is the right answer — the
         whole file reads as added. */
      return parseDiffFromFile(
        { name, contents: originalContent ?? "" },
        { name, contents: content },
      );
    } catch {
      // Binary and very large files throw. A missing diff is fine; a crash is not.
      return null;
    }
  }, [name, selectedFile, content, originalContent, isChanged]);

  // A stale "diff" must never render an empty pane, e.g. after the agent reverts a file
  // and it stops being changed while the Diff tab is still selected.
  const canDiff = isChanged && diff !== null;
  const mode = canDiff && viewMode === "diff" ? "diff" : "code";

  // The page only mounts this once a file is open, so there is no empty state here.
  if (!selectedFile) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-surface-secondary px-3">
        <Tab active={mode === "code"} onClick={() => onViewModeChange("code")}>
          <span className="font-mono">{name}</span>
        </Tab>
        {canDiff && (
          <Tab active={mode === "diff"} onClick={() => onViewModeChange("diff")} accent>
            <span className="size-1.5 rounded-full bg-warning" />
            Diff
          </Tab>
        )}
        {isChanged && (
          <span className="ml-auto text-[10px] font-medium uppercase tracking-wide text-warning">
            Modified
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close file"
          title="Close, and give the width back to the conversation"
          className={`${isChanged ? "" : "ml-auto"} px-1.5 text-text-tertiary hover:text-text transition-colors`}
        >
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto text-xs">
        {content === undefined ? (
          <p className="p-4 text-sm text-text-tertiary">Loading file…</p>
        ) : mode === "diff" && diff ? (
          <FileDiff
            fileDiff={diff}
            disableWorkerPool
            options={{ theme, diffStyle: "unified", diffIndicators: "bars" }}
          />
        ) : (
          <PierreFile file={{ name, contents: content }} disableWorkerPool options={{ theme }} />
        )}
      </div>
    </div>
  );
}

function Tab({
  active,
  accent,
  onClick,
  children,
}: {
  active: boolean;
  accent?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 border-b-2 px-2 py-2 text-xs transition-colors ${
        active
          ? `${accent ? "border-warning" : "border-primary"} text-text`
          : "border-transparent text-text-tertiary hover:text-text-secondary"
      }`}
    >
      {children}
    </button>
  );
}
