"use client";

/**
 * `< Branch 1/2 >` — move between sibling lineages at a fork.
 *
 * `siblingBranches` comes from getBranchContext's `branchOptions` (see
 * lib/use-branching.ts). GUIDE.md 8.1 notes v1 ships no built-in switcher, but the
 * SDK does compute the sibling list, so this is only presentation.
 *
 * Renders nothing unless there is an actual fork.
 */
export function BranchSwitcher({
  siblingBranches,
  currentBranch,
  onSwitch,
  disabled,
}: {
  siblingBranches: string[];
  currentBranch: string;
  onSwitch: (branch: string) => void;
  disabled?: boolean;
}) {
  if (siblingBranches.length <= 1) return null;

  // currentBranch can name a lineage that is not among these siblings; fall back to
  // the first so the counter always shows a real position.
  const resolved =
    currentBranch && siblingBranches.includes(currentBranch) ? currentBranch : siblingBranches[0]!;
  const index = siblingBranches.indexOf(resolved);

  const go = (delta: number) =>
    onSwitch(siblingBranches[(index + delta + siblingBranches.length) % siblingBranches.length]!);

  const arrow =
    "px-1 rounded text-text-tertiary hover:text-text hover:bg-surface-tertiary disabled:opacity-30 disabled:cursor-not-allowed transition-colors";

  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border bg-surface-secondary px-1 py-0.5">
      <button type="button" onClick={() => go(-1)} disabled={disabled} className={arrow} aria-label="Previous branch">
        ‹
      </button>
      <span className="px-1 text-[10px] font-medium text-text-secondary tabular-nums whitespace-nowrap">
        Branch {index + 1}/{siblingBranches.length}
      </span>
      <button type="button" onClick={() => go(1)} disabled={disabled} className={arrow} aria-label="Next branch">
        ›
      </button>
    </div>
  );
}
