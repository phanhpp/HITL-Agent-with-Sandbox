interface StatusBadgeProps {
  status: "pending" | "running" | "complete" | "error";
  label?: string;
}

const config = {
  pending: { color: "var(--color-text-tertiary)", icon: "○", label: "Pending" },
  running: { color: "var(--color-warning)", icon: "◉", label: "Running" },
  complete: { color: "var(--color-success)", icon: "✓", label: "Complete" },
  error: { color: "var(--color-error)", icon: "✕", label: "Error" },
} as const;

export function StatusBadge({ status, label }: StatusBadgeProps) {
  const c = config[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs font-medium"
      style={{ color: c.color }}
    >
      <span className={status === "running" ? "animate-pulse" : ""}>{c.icon}</span>
      {label ?? c.label}
    </span>
  );
}
