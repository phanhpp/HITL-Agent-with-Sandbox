import type { BaseMessage } from "langchain";

/**
 * The reasoning (extended thinking) text of one message, or "" if it has none.
 *
 * Two traps live here, which is why this is a function rather than an inline filter
 * repeated at each call site:
 *
 * 1. THE BLOCK IS NAMED DIFFERENTLY DEPENDING ON WHERE YOU READ IT. Raw `content`
 *    — the wire, and `GET /threads/{id}/state` — calls it `thinking`. The normalised
 *    `contentBlocks` view calls it `reasoning`. Filtering raw content for "reasoning"
 *    silently matches nothing.
 *
 * 2. `message.text` EXCLUDES reasoning. It keeps only `type === "text"` blocks, so a
 *    component that renders `msg.text` drops the entire thought process without any
 *    error.
 *
 * `redacted_thinking` normalises to `non_standard`, not `reasoning`, so it is dropped
 * here. That is deliberate: render nothing rather than a "reasoning was hidden" notice.
 */
export function reasoningText(message: BaseMessage): string {
  const blocks = (message as { contentBlocks?: { type?: string; reasoning?: string }[] })
    .contentBlocks;
  if (!Array.isArray(blocks)) return "";

  return blocks
    .filter((b) => b?.type === "reasoning" && typeof b.reasoning === "string")
    .map((b) => b.reasoning as string)
    .filter((r) => r.trim().length > 0)
    .join("");
}
