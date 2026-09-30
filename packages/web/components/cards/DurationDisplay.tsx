"use client";

import { useState, useEffect } from "react";

interface DurationDisplayProps {
  startTime: number;
  endTime?: number;
}

export function DurationDisplay({ startTime, endTime }: DurationDisplayProps) {
  // Seed from startTime, not Date.now(): the server and the browser each run this
  // initializer at a different moment, so Date.now() renders two different values
  // and React reports a hydration mismatch. Starting at startTime renders "0.0s"
  // on both sides, then the effect catches up once we're in the browser.
  const [now, setNow] = useState(startTime);

  useEffect(() => {
    if (endTime) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [endTime]);

  const elapsed = (endTime ?? now) - startTime;
  const seconds = (elapsed / 1000).toFixed(1);

  return <span className="text-xs text-text-tertiary font-mono tabular-nums">{seconds}s</span>;
}
