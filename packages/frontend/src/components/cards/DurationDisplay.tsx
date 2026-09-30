import { useState, useEffect } from "react";

interface DurationDisplayProps {
  startTime: number;
  endTime?: number;
}

export function DurationDisplay({ startTime, endTime }: DurationDisplayProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (endTime) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [endTime]);

  const elapsed = (endTime ?? now) - startTime;
  const seconds = (elapsed / 1000).toFixed(1);

  return <span className="text-xs text-text-tertiary font-mono tabular-nums">{seconds}s</span>;
}
