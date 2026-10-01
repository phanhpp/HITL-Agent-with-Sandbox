/**
 * Graph state types for `useStream<T>`.
 *
 * `AgentState` covers both langchain's `create_agent` and deepagents'
 * `create_deep_agent`, because DeepAgentState extends AgentState and the only
 * field the UI reads from the base is `messages`.
 *
 * The graphs do carry more state than this — HumanInTheLoopMiddleware adds
 * `hitl_edited_tool_calls`, create_agent adds `jump_to` and
 * `structured_response`. They are deliberately left out: nothing in the UI reads
 * them. Interrupt payloads arrive via `stream.interrupt`, and edited arguments
 * come back in the tool result, so none of that needs a type here.
 *
 * Extend this only for a field the UI actually renders (see DeepAgentState), or
 * hand-define a new interface for a custom StateGraph with its own TypedDict.
 *
 * To see a graph's full real state, ask the server — it reports JSON Schema
 * derived from the Python type hints, including middleware fields:
 *
 *   curl -s localhost:2024/assistants/search -X POST \
 *     -H 'content-type: application/json' -d '{"limit":10}'
 *   curl -s localhost:2024/assistants/<assistant_id>/schemas | python3 -m json.tool
 */
import type { BaseMessage, Todo } from "langchain";

/**
 * langchain's built-in agent state, and the base of deepagents' DeepAgentState.
 * `messages` is append-only. Used by /approve (human_in_the_loop).
 */
export interface AgentState {
  messages: BaseMessage[];
}

/**
 * Used by /orchestrate. Both extra keys were confirmed against a live thread, not
 * taken from a schema — `GET /assistants/<id>/schemas` reports only
 * `{files, messages}`, so `todos` cannot be discovered that way.
 *
 * `todos` comes from TodoListMiddleware, which is opt-in as of deepagents 0.7: with
 * the middleware off the key is absent rather than empty, and the model is told to
 * skip planning for simple requests even when it is on. So an empty panel is a
 * correct state. Always read `stream.values?.todos ?? []`.
 *
 * `files` is the StateBackend filesystem. Because it lives in graph state, the file
 * panel is a plain `stream.values` read — no HTTP route and no sandbox. A sandbox
 * backend would NOT populate this (docs/deepagent-guide.md section 8.14).
 */
export interface DeepAgentState extends AgentState {
  todos?: Todo[];
  files?: Record<string, string>;
}
