interface JsonViewerProps {
  data: unknown;
  maxHeight?: number;
}

export function JsonViewer({ data, maxHeight = 200 }: JsonViewerProps) {
  const json = typeof data === "string" ? data : JSON.stringify(data, null, 2);

  return (
    <pre
      className="overflow-auto rounded-md bg-surface-tertiary px-3 py-2 text-xs font-mono text-text-secondary leading-relaxed"
      style={{ maxHeight: `${maxHeight}px` }}
    >
      {json}
    </pre>
  );
}
