"use client";

import { useEffect, useState } from "react";
import type { BaseMessage } from "langchain";

import { reasoningText } from "@/lib/reasoning";
import { ThinkingBubble } from "./Bubble";

/**
 * Renders one message's extended-thinking blocks, in either of the two places
 * /orchestrate needs them: beside a coordinator message, and inside a subagent card.
 *
 * `ThinkingBubble` is deliberately left untouched — it is byte-identical to the
 * official reasoning-tokens reference, and it is always-expanded by design. The
 * disclosure lives here instead, so the bubble keeps its shape.
 *
 * `variant` exists because a subagent card is a small scroll box: a 7x7 avatar and an
 * 80%-width bubble are wrong at that size.
 */
export function ReasoningTrace({
  message,
  isStreaming = false,
  variant = "bubble",
}: {
  message: BaseMessage;
  isStreaming?: boolean;
  variant?: "bubble" | "inline";
}) {
  const reasoning = reasoningText(message);

  // Open while the thought is still arriving, then fold away so the answer leads.
  const [open, setOpen] = useState(isStreaming);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setOpen(isStreaming);
  }, [isStreaming, touched]);

  if (!reasoning) return null;

  const toggle = () => {
    setTouched(true);
    setOpen((v) => !v);
  };

  if (variant === "bubble") {
    return open ? (
      <button type="button" onClick={toggle} className="block w-full text-left" aria-expanded>
        <ThinkingBubble content={reasoning} isStreaming={isStreaming} />
      </button>
    ) : (
      <Summary reasoning={reasoning} onClick={toggle} className="pl-9" />
    );
  }

  return (
    <div className="space-y-1">
      <Summary reasoning={reasoning} onClick={toggle} expanded={open} />
      {open && (
        <pre className="whitespace-pre-wrap text-[11px] font-mono text-text-tertiary leading-relaxed m-0 max-h-40 overflow-y-auto">
          {reasoning}
        </pre>
      )}
    </div>
  );
}

function Summary({
  reasoning,
  onClick,
  expanded = false,
  className = "",
}: {
  reasoning: string;
  onClick: () => void;
  expanded?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      className={`inline-flex items-center gap-1.5 text-xs text-text-tertiary hover:text-text-secondary transition-colors ${className}`}
    >
      <span className={`transition-transform ${expanded ? "rotate-90" : ""}`}>▸</span>
      Thought
      <span className="tabular-nums">· {reasoning.length} chars</span>
    </button>
  );
}
