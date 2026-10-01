import type { ReactNode } from "react";

/**
 * Sidebar + main, as a flex ROW inside the page.
 *
 * It is a component rather than an inline div because three of its classes break
 * silently if dropped, and this is the one place to explain them:
 *
 *   min-h-0   on the row and the aside. Without it the flex children refuse to shrink
 *             and the page grows past the viewport — the same failure CLAUDE.md records
 *             for `main`, with the same symptom: nothing scrolls, no error.
 *   min-w-0   on the chat column. In a row, flex items have an automatic minimum width
 *             of their content, so one wide <pre> inside a markdown block pushes the
 *             sidebar off screen or creates horizontal overflow.
 *   shrink-0  on the aside, or the sidebar collapses as the transcript widens.
 *
 * The sidebar is hidden below `lg` with no toggle: a control that cannot act should be
 * absent rather than disabled (docs/LESSONS.md). This is where a disclosure would go.
 */
export function SplitView({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1">
      <aside className="hidden lg:flex lg:flex-col shrink-0 w-[var(--sidebar-width)] min-h-0 overflow-y-auto border-r border-border bg-surface p-4 gap-6">
        {sidebar}
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
