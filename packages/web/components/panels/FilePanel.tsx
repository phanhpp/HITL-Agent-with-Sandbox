"use client";

import { useState } from "react";

/**
 * The agent's filesystem, from `stream.values.files`.
 *
 * This panel exists because the page's central interaction is an approval card gating
 * `write_file`. Without somewhere to see the result, approving a write has no visible
 * consequence — which reads as a broken demo.
 *
 * With a StateBackend the filesystem lives in graph state, so this is a plain
 * `stream.values` read and is already reactive. None of the snapshot/diff/refresh
 * machinery a sandbox needs applies here (docs/deepagent-guide.md section 8.7).
 */

// Deep agents write their own bookkeeping to the default backend. Showing it buries
// the one file the user actually approved.
const INTERNAL_PREFIXES = ["/large_tool_results/", "/conversation_history/"];

export function FilePanel({ files }: { files: Record<string, unknown> }) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [showInternal, setShowInternal] = useState(false);

  const all = Object.keys(files).sort();
  const internal = all.filter((p) => INTERNAL_PREFIXES.some((pre) => p.startsWith(pre)));
  const paths = showInternal ? all : all.filter((p) => !internal.includes(p));

  if (all.length === 0) {
    return <p className="text-xs text-text-tertiary">Files the agent writes appear here.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          Files
        </h2>
        <span className="text-xs text-text-tertiary tabular-nums">{paths.length}</span>
      </div>

      <ul className="space-y-1">
        {paths.map((path) => (
          <li key={path}>
            <button
              type="button"
              onClick={() => setOpenPath(openPath === path ? null : path)}
              aria-expanded={openPath === path}
              className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs text-text-secondary hover:bg-surface-secondary hover:text-text transition-colors"
            >
              <span className={`transition-transform ${openPath === path ? "rotate-90" : ""}`}>
                ▸
              </span>
              <span className="truncate font-mono">{path}</span>
            </button>
            {openPath === path && (
              <pre className="mt-1 max-h-64 overflow-auto rounded border border-border bg-surface-secondary p-2 text-[11px] font-mono leading-relaxed text-text-secondary">
                {/* The shape of a file value is not guaranteed, so never assume string. */}
                {typeof files[path] === "string"
                  ? (files[path] as string)
                  : JSON.stringify(files[path], null, 2)}
              </pre>
            )}
          </li>
        ))}
      </ul>

      {internal.length > 0 && (
        <button
          type="button"
          onClick={() => setShowInternal((v) => !v)}
          className="text-[11px] text-text-tertiary hover:text-text-secondary transition-colors"
        >
          {showInternal ? "Hide" : "Show"} {internal.length} internal
        </button>
      )}
    </div>
  );
}
