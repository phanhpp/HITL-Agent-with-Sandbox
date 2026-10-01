# Reasoning tokens

> Display model thinking and reasoning processes in collapsible blocks

Reasoning tokens expose the internal thought process of advanced models like OpenAI's GPT-5 and Anthropic's Claude with extended thinking. These models produce structured content blocks that separate reasoning from the final answer, letting you build UIs that show *how* the model arrived at its response.

## What are reasoning tokens?

When models with reasoning capabilities process a prompt, they generate two distinct types of content:

1. **Reasoning blocks**: the model's internal chain-of-thought, problem decomposition, and step-by-step analysis
2. **Text blocks**: the final, polished response presented to the user

These are delivered as typed content blocks within an `AIMessage`, accessible via the `contentBlocks` property:

```ts
// Reasoning block
{ type: "reasoning", reasoning: "Let me think about this step by step..." }

// Text block
{ type: "text", text: "The answer is 42." }
```

> **Note:** Not all models produce reasoning tokens. This pattern applies specifically to models that support extended thinking or chain-of-thought output. Standard chat models return only text blocks.

## Use cases

* **Transparency**: show users the model's reasoning process to build trust in its answers
* **Debugging**: inspect the model's thought process to identify where it goes wrong
* **Educational tools**: teach students problem-solving by revealing how an AI approaches questions
* **Decision support**: let domain experts validate the reasoning behind recommendations
* **Quality assurance**: audit reasoning chains for compliance in regulated industries

## Extracting reasoning and text blocks

The `contentBlocks` array on an `AIMessage` contains all blocks in the order they were generated. Filter them by `type` to separate reasoning from text:

```ts
import { AIMessage } from "langchain";

function extractBlocks(msg: AIMessage) {
  const reasoningBlocks = msg.contentBlocks
    .filter((b) => b.type === "reasoning")
    .map((b) => b.reasoning);

  const textBlocks = msg.contentBlocks
    .filter((b) => b.type === "text")
    .map((b) => b.text);

  return {
    reasoning: reasoningBlocks.join(""),
    text: textBlocks.join(""),
  };
}
```

A single message may contain multiple reasoning blocks (e.g., if the model pauses its reasoning, produces partial text, then reasons further). Joining them gives you the complete thought process.

## Accessing messages from `useStream`

Connect [`useStream`](https://reference.langchain.com/javascript/langchain-react/index/useStream) to your reasoning-capable agent and iterate
`stream.messages` in your chat UI. Branch on `HumanMessage.isInstance` and
`AIMessage.isInstance`, then pass each assistant message to a component that
reads `contentBlocks` and separates reasoning from text. Set `isStreaming` on
the last message while `stream.isLoading` is true so thinking blocks update as
tokens arrive.

> **Info:** The code examples use `useStream<typeof myAgent>` for type-safe stream state. See Type inference for [Python](/oss/python/langchain/frontend/overview#type-inference) or [JavaScript](/oss/javascript/langchain/frontend/overview#type-inference) backends.

```tsx
import { useStream } from "@langchain/react";
import { AIMessage, HumanMessage } from "langchain";

function Chat() {
  const stream = useStream<typeof myAgent>({
    apiUrl: "http://localhost:2024",
    assistantId: "reasoning",
  });

  return (
    <div className="messages">
      {stream.messages.map((msg, i) => {
        if (HumanMessage.isInstance(msg)) {
          return <HumanBubble key={i} text={msg.text} />;
        }
        if (AIMessage.isInstance(msg)) {
          return (
            <AIResponse
              key={i}
              message={msg}
              isStreaming={stream.isLoading && i === stream.messages.length - 1}
            />
          );
        }
        return null;
      })}
    </div>
  );
}
```

## Building a ThinkingBubble component

The `ThinkingBubble` presents reasoning tokens in a visually distinct, collapsible container. Users can expand it to see the full thought process or collapse it to focus on the final answer.

```tsx
import { useState } from "react";

function ThinkingBubble({
  reasoning,
  isStreaming,
}: {
  reasoning: string;
  isStreaming: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  const charCount = reasoning.length;
  const previewLength = 120;
  const preview =
    reasoning.length > previewLength
      ? reasoning.slice(0, previewLength) + "..."
      : reasoning;

  return (
    <div className="thinking-bubble">
      <button
        className="thinking-header"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span className="thinking-icon">
          {isStreaming ? (
            <span className="thinking-spinner" />
          ) : (
            "💭"
          )}
        </span>
        <span className="thinking-label">
          {isStreaming ? "Thinking..." : `Thought process (${charCount} chars)`}
        </span>
        <span className={`chevron ${isExpanded ? "expanded" : ""}`}>▶</span>
      </button>

      {isExpanded && (
        <div className="thinking-content">
          <pre>{reasoning}</pre>
        </div>
      )}

      {!isExpanded && !isStreaming && (
        <div className="thinking-preview">{preview}</div>
      )}
    </div>
  );
}
```

## Rendering the complete AI response

Combine the `ThinkingBubble` and a standard text bubble into a single `AIResponse` component:

```tsx
function AIResponse({
  message,
  isStreaming,
}: {
  message: AIMessage;
  isStreaming: boolean;
}) {
  const reasoningBlocks = message.contentBlocks
    .filter((b) => b.type === "reasoning")
    .map((b) => b.reasoning)
    .join("");

  const textBlocks = message.contentBlocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  const hasReasoning = reasoningBlocks.length > 0;
  const hasText = textBlocks.length > 0;

  const isReasoningPhase = isStreaming && !hasText;
  const isTextPhase = isStreaming && hasText;

  return (
    <div className="ai-response">
      {hasReasoning && (
        <ThinkingBubble
          reasoning={reasoningBlocks}
          isStreaming={isReasoningPhase}
        />
      )}
      {hasText && (
        <div className="ai-text-bubble">
          <p>{textBlocks}</p>
          {isTextPhase && <span className="cursor-blink">▊</span>}
        </div>
      )}
    </div>
  );
}
```

## Handling edge cases

### Messages without reasoning

Not every AI message will contain reasoning blocks. When `contentBlocks` has only text blocks, render a standard message bubble without the ThinkingBubble.

### Empty reasoning blocks

Some models produce empty reasoning blocks as placeholders. Filter these out:

```ts
const meaningfulReasoning = message.contentBlocks
  .filter((b) => b.type === "reasoning" && b.reasoning.trim().length > 0);
```

### Multiple reasoning-text cycles

A single message can alternate between reasoning and text blocks. If you need to preserve this interleaving, iterate `contentBlocks` in order rather than grouping by type:

```ts
message.contentBlocks.forEach((block) => {
  if (block.type === "reasoning") {
    // Render ThinkingBubble
  } else if (block.type === "text") {
    // Render text paragraph
  }
});
```

## Best practices

* **Default to collapsed**: show reasoning on demand, not by default
* **Show character count**: gives users a quick sense of how much thinking went into the response
* **Differentiate visually**: use distinct colors, borders, or backgrounds so reasoning is never confused with the actual answer
* **Animate transitions**: smooth expand/collapse animations improve perceived quality
* **Consider accessibility**: use proper ARIA attributes (`aria-expanded`, `aria-controls`) on the toggle button
* **Truncate in previews**: show a short preview of the reasoning when collapsed so users can decide whether to expand

---

# How the reference repo actually does it

Investigated `~/dev/reasoning-tokens`. The official guide above describes the
pattern; this section records what the working implementation does differently,
and what already exists in **this** repo.

## The agent is eight lines

`packages/agent/agents/reasoning_tokens.py`:

```python
from langchain_anthropic import ChatAnthropic
from langchain.agents import create_agent

model = ChatAnthropic(
    model="claude-sonnet-4-5-20250929",
    max_tokens=20000,
    thinking={"type": "enabled", "budget_tokens": 10000},
)

agent = create_agent(model=model)
```

- Reasoning is **off by default**. Without `thinking=...` you get no reasoning
  blocks at all — verified on our own agent, whose AI messages carry block types
  `['tool_call']` and `has reasoning: False`.
- **`max_tokens` must exceed `budget_tokens`.** The reference uses 20000 / 10000.
- `create_agent(model=model)` with **no tools** — plain reasoning chat.
- Uses `ChatAnthropic` directly rather than `init_chat_model`. Both work; our own
  probe confirmed `init_chat_model("anthropic:claude-haiku-4-5", thinking={...},
  max_tokens=3000)` produces reasoning too.

## The block type is named differently depending on where you read it

This is the detail that silently breaks the filter in the guide above:

| Where you read it | Block type |
|---|---|
| raw `content` (the wire, and `/threads/{id}/state`) | `thinking` |
| normalized `contentBlocks` | **`reasoning`** |

`b.type === "reasoning"` only matches via `contentBlocks`. Filter raw `content`
and you silently get nothing. Same class of trap as snake_case on the wire vs
camelCase through `useStream`.

Verified directly:

```
block types:          ['thinking', 'text']      <- r.content
contentBlocks types:  ['reasoning', 'text']     <- r.content_blocks
```

## The rendering is ~20 lines

From `preview.tsx`, inside the `AIMessage.isInstance(msg)` branch:

```tsx
const reasoningBlocks = msg.contentBlocks
  .filter((b) => b.type === "reasoning")
  .map((b) => b.reasoning)
  .join("");
const textBlocks = msg.contentBlocks.filter((b) => b.type === "text");

return (
  <div key={msg.id ?? i} className="space-y-2">
    {reasoningBlocks.length > 0 && (
      <ThinkingBubble
        content={reasoningBlocks}
        isStreaming={stream.isLoading && i === stream.messages.length - 1}
      />
    )}
    {textBlocks.length > 0 && (
      <AIBubble>
        <Markdown>{textBlocks.map(({ text }) => text).join("")}</Markdown>
      </AIBubble>
    )}
  </div>
);
```

- Multiple reasoning blocks are **joined**, not rendered separately.
- `isStreaming` is true only for the **last** message while loading.
- Both halves are guarded on `length > 0`, so a message with no reasoning renders
  a plain bubble and nothing else.

## The guide oversells the component

The prose above describes a collapsible bubble with a chevron, an expand/collapse
toggle, a 120-character preview and ARIA attributes. **The shipped component has
none of that.** It is always expanded:

```tsx
export function ThinkingBubble({ content, isStreaming }: ThinkingBubbleProps) {
  // Avatar, then:
  //   SparklesIcon (animate-pulse while streaming)
  //   "Thinking…" | "Thought"  ·  "<n> chars"
  //   <pre className="whitespace-pre-wrap text-xs font-mono">{content}</pre>
}
```

Treat the guide's "Building a ThinkingBubble component" section as a suggestion,
not as what the reference does.

## We already have the component

`ThinkingBubble` is **already in this repo** at
`packages/web/components/chat/Bubble.tsx:78`, already exported from
`components/playground.ts`, and **byte-identical** to the reference. It came
across in the original component port and has been unused since.

So the work is not "build a thinking UI". It is:

1. Enable `thinking` on the model (Python).
2. Read `contentBlocks` in the message renderer and render the component we have.

## What the reference does NOT cover

It is a plain chat agent with no tools, so it says nothing about:

- **Thinking + tool calling together**, which is what `/orchestrate` needs. The
  Anthropic API constrains this (thinking blocks must be preserved when tool
  results are passed back, and temperature is forced to 1). `langchain-anthropic`
  handles most of it, but it is unverified here.
- **Thinking + interrupts**, i.e. what a reasoning block looks like across a HITL
  pause and resume.
- **Thinking inside subagents** — whether a deep agent's `task` subagent surfaces
  its own reasoning blocks separately.

All three need probing before building `/orchestrate`, not assuming.
