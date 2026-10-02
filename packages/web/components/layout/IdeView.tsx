import type { ReactNode } from "react";

/**
 * Three columns: files, code, chat.
 *
 * The sibling of `SplitView`, used only once the thread has a sandbox. A research-only
 * conversation keeps `SplitView` — a code pane with nothing in it is worse than no code
 * pane, and most conversations on this page never ask for code.
 *
 * The same three classes are load-bearing here as there, for the same silent reasons:
 *
 *   min-h-0  on the row and both asides, or the page grows past the viewport and nothing
 *            scrolls, with no error anywhere.
 *   min-w-0  on the CODE column. In a flex row an item's automatic minimum width is its
 *            content, and source code is exactly the content that has no natural width —
 *            one long line pushes the chat off screen.
 *   shrink-0 on both asides, or they collapse as the code widens.
 *
 * Below `lg` this falls back to chat only, matching SplitView: a file tree at phone width
 * is a control that cannot act.
 */
export function IdeView({
  files,
  code,
  children,
}: {
  /** Left column: plan, workspace tree, changed files. */
  files: ReactNode;
  /** Centre column: the code or diff viewer. `null` when no file is open. */
  code: ReactNode | null;
  /** Right column: the chat. */
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1">
      <aside className="hidden lg:flex lg:flex-col shrink-0 w-[var(--sidebar-width)] min-h-0 overflow-y-auto border-r border-border bg-surface p-4 gap-6">
        {files}
      </aside>

      {/* Only present while a file is open. A code pane sitting empty takes the space
          the conversation needs, and the conversation is the thing people are using. */}
      {code && (
        <div className="hidden lg:flex min-h-0 min-w-0 flex-1 flex-col bg-surface">{code}</div>
      )}

      <div
        className={`flex min-h-0 flex-col border-l border-border ${
          code ? "w-full lg:w-[26rem] shrink-0" : "min-w-0 flex-1"
        }`}
      >
        {children}
      </div>
    </div>
  );
}
