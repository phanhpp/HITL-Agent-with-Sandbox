"use client";

import type { FileTreeNode } from "@/lib/use-sandbox-files";

/**
 * The coder's filesystem as a tree.
 *
 * Expansion state is NOT held per node. It lives in `useSandboxFiles` as a set of paths,
 * which is what lets selecting a file reveal it — the official reference keeps it in each
 * row's own `useState`, so clicking a changed file nested two levels deep highlights a row
 * inside a closed folder and looks like nothing happened.
 */

const CHANGED_DOT = "bg-warning";

/**
 * A one-character stand-in for a file icon, coloured by kind.
 *
 * Deliberately not the reference's icon component: that imports the entire VSCode icon
 * set as JSON, several megabytes, to render a 14px glyph. This repo has no icon library
 * and draws its own SVG, so a lookup table is the proportionate answer.
 */
const EXT_COLOR: Record<string, string> = {
  js: "text-yellow-500",
  mjs: "text-yellow-500",
  ts: "text-blue-500",
  tsx: "text-blue-500",
  json: "text-amber-600",
  md: "text-text-secondary",
  css: "text-sky-500",
  html: "text-orange-500",
  py: "text-green-600",
};

function FileGlyph({ name }: { name: string }) {
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  return (
    <span className={`shrink-0 font-mono text-[10px] ${EXT_COLOR[ext] ?? "text-text-tertiary"}`}>
      ◦
    </span>
  );
}

/** True when this directory contains a changed file at any depth. */
function hasChangedDescendant(node: FileTreeNode, changed: Set<string>): boolean {
  for (const path of changed) {
    if (path.startsWith(node.path + "/")) return true;
  }
  return false;
}

function TreeRow({
  node,
  depth,
  selectedFile,
  changedFiles,
  expandedDirs,
  onSelect,
  onToggle,
}: {
  node: FileTreeNode;
  depth: number;
  selectedFile: string | null;
  changedFiles: Set<string>;
  expandedDirs: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  const isDir = node.type === "directory";
  const isOpen = isDir && expandedDirs.has(node.path);
  const isSelected = node.path === selectedFile;

  /* A directory marks when something inside it changed. The reference tests the directory
     path against a set that only ever holds file paths, so a folder never marks at all. */
  const marked = isDir ? hasChangedDescendant(node, changedFiles) : changedFiles.has(node.path);

  return (
    <li>
      <button
        type="button"
        onClick={() => (isDir ? onToggle(node.path) : onSelect(node.path))}
        aria-expanded={isDir ? isOpen : undefined}
        // Indent with padding, not nested boxes, so the hover and selected background
        // still span the full width of the column.
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        className={`flex w-full items-center gap-1.5 py-1 pr-2 text-left text-xs transition-colors ${
          isSelected
            ? "bg-surface-tertiary text-text"
            : "text-text-secondary hover:bg-surface-secondary hover:text-text"
        }`}
      >
        {isDir ? (
          <span
            className={`shrink-0 text-[9px] transition-transform ${isOpen ? "rotate-90" : ""}`}
          >
            ▸
          </span>
        ) : (
          <FileGlyph name={node.name} />
        )}
        <span className="truncate font-mono">{node.name}</span>
        {marked && (
          <span
            className={`ml-auto size-1.5 shrink-0 rounded-full ${CHANGED_DOT}`}
            title="Modified"
          />
        )}
      </button>

      {isDir && isOpen && node.children && node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedFile={selectedFile}
              changedFiles={changedFiles}
              expandedDirs={expandedDirs}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function SandboxTree({
  tree,
  selectedFile,
  changedFiles,
  expandedDirs,
  onSelect,
  onToggle,
  isLoading,
}: {
  tree: FileTreeNode[];
  selectedFile: string | null;
  changedFiles: Set<string>;
  expandedDirs: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  isLoading: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-baseline justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          Workspace
        </h2>
        {changedFiles.size > 0 && (
          <span className="text-xs text-text-tertiary tabular-nums">
            {changedFiles.size} changed
          </span>
        )}
      </div>

      {tree.length === 0 ? (
        <p className="px-1 text-xs text-text-tertiary">
          {isLoading ? "Reading the sandbox…" : "The coder's files appear here."}
        </p>
      ) : (
        <ul className="-mx-1 min-h-0 overflow-y-auto">
          {tree.map((node) => (
            <TreeRow
              key={node.path}
              node={node}
              depth={0}
              selectedFile={selectedFile}
              changedFiles={changedFiles}
              expandedDirs={expandedDirs}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
