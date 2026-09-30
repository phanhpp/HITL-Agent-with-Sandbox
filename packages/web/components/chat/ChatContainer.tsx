"use client";

import { useRef, useEffect, type ReactNode } from "react";

interface ChatContainerProps {
  children: ReactNode;
  input: ReactNode;
  className?: string;
  /** Fill remaining space inside a flex parent instead of using the full viewport height. */
  embedded?: boolean;
}

export function ChatContainer({
  children,
  input,
  className = "",
  embedded = false,
}: ChatContainerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Within 40px of the bottom counts as "following along".
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  // No dependency array on purpose. Streamed tokens grow the last message's text
  // without changing the message count, so there is no value to key this on —
  // anything narrower would stop autoscrolling mid-stream. The body is two reads
  // and one write, and stickToBottom means scrolling up to read history is no
  // longer yanked back down on the next token.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div
      className={`flex flex-col bg-surface ${embedded ? "min-h-0 flex-1" : "h-screen"} ${className}`}
    >
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        data-testid="sdk-preview-messages"
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4 space-y-4"
      >
        {children}
      </div>
      {input && <div className="shrink-0 border-t border-border px-4 py-3">{input}</div>}
    </div>
  );
}
