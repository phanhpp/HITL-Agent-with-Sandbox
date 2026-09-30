function formatPatternLabel(slug: string): string {
  return slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function PatternListView({
  slugs,
  onSelect,
}: {
  slugs: string[];
  onSelect: (slug: string) => void;
}) {
  return (
    <div className="min-h-[400px] p-6">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-lg font-semibold text-text">React examples</h1>
        <p className="mt-1 text-sm text-text-tertiary">
          Choose a pattern to preview in this sandbox.
        </p>
        <ul className="mt-6 grid gap-2 sm:grid-cols-2">
          {slugs.map((slug) => (
            <li key={slug}>
              <button
                type="button"
                onClick={() => onSelect(slug)}
                title={`${formatPatternLabel(slug)} (${slug})`}
                className="flex w-full min-w-0 items-center gap-3 overflow-hidden rounded-lg border border-border bg-surface-secondary px-4 py-3 text-left text-sm whitespace-nowrap text-text transition-colors hover:border-primary hover:text-primary cursor-pointer"
              >
                <span className="min-w-0 flex-1 truncate font-medium">
                  {formatPatternLabel(slug)}
                </span>
                <span className="shrink-0 truncate font-mono text-xs text-text-tertiary max-w-[45%]">
                  {slug}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
