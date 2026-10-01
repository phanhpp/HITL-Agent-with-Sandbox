"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// /rewind was dropped from the plan — rewind and rejoin are capabilities every page
// has, not a page of their own.
const LINKS = [
  { href: "/approve", label: "Approve" },
  { href: "/orchestrate", label: "Orchestrate" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="shrink-0 border-b border-border bg-surface">
      <div className="flex items-center gap-6 px-4 h-14">
        <Link href="/" className="font-semibold text-text hover:text-primary transition-colors">
          agent-ui
        </Link>
        <div className="flex items-center gap-1">
          {LINKS.map(({ href, label }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                  active
                    ? "bg-surface-tertiary text-text font-medium"
                    : "text-text-secondary hover:text-text hover:bg-surface-secondary"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
