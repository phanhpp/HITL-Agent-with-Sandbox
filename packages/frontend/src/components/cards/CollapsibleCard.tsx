import { useState, type ReactNode } from "react";

interface CollapsibleCardProps {
  title: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}

export function CollapsibleCard({
  title,
  badge,
  children,
  defaultOpen = false,
}: CollapsibleCardProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-lg border border-border bg-surface-secondary overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium text-text hover:bg-surface-tertiary transition-colors"
      >
        <span className="flex items-center gap-2">
          <span className={`text-xs transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
          {title}
        </span>
        {badge}
      </button>
      {open && <div className="border-t border-border px-3 py-2">{children}</div>}
    </div>
  );
}
