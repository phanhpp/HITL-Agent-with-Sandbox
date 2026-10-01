import type { Todo } from "langchain";

import { StatusBadge } from "@/components/cards/StatusBadge";

/**
 * The agent's live plan, from `stream.values.todos`.
 *
 * Pure: no stream, no hooks. The caller does the `?? []`.
 *
 * Todos have NO id — `Todo` is `{content, status}` — so items are keyed by index.
 * That is the only option available, not a shortcut.
 */
export function TodoPanel({ todos, isPlanning }: { todos: Todo[]; isPlanning: boolean }) {
  // An empty plan is a CORRECT state, not a bug: the planning middleware's own prompt
  // tells the model to skip todos for simple requests.
  if (todos.length === 0) {
    return (
      <p className="text-xs text-text-tertiary">
        {isPlanning ? "Working on a plan…" : "Tasks appear here as the agent plans."}
      </p>
    );
  }

  const done = todos.filter((t) => t.status === "completed").length;
  const pct = Math.round((done / todos.length) * 100);

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          Plan
        </h2>
        <span className="text-xs text-text-tertiary tabular-nums">
          {done}/{todos.length}
        </span>
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-tertiary">
        <div
          className="h-full rounded-full bg-primary transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>

      <ul className="space-y-2">
        {todos.map((todo, i) => (
          <li
            key={i}
            className={`flex gap-2 text-xs leading-relaxed ${
              todo.status === "completed" ? "text-text-tertiary line-through" : "text-text"
            }`}
          >
            {/* StatusBadge already owns the ○ ◉ ✓ glyphs, the colours, and the pulse
                on "running" — so no new icons are needed for this panel. */}
            <StatusBadge status={TODO_STATUS[todo.status]} label="" />
            <span className="min-w-0">{todo.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Todo statuses and StatusBadge statuses are near-identical but not the same words. */
const TODO_STATUS = {
  pending: "pending",
  in_progress: "running",
  completed: "complete",
} as const satisfies Record<Todo["status"], "pending" | "running" | "complete">;
