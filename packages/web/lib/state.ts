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
 * `messages` is append-only. Used by /approve (human_in_the_loop) and
 * /rewind (chat).
 */
export interface AgentState {
  messages: BaseMessage[];
}

/**
 * Used by /orchestrate. `todos` comes from the planning middleware, which is
 * opt-in as of deepagents v0.7 — so the key is absent rather than empty when it
 * is off. Always read it as `stream.values?.todos ?? []`.
 *
 * TODO(step 6): confirm the field name against the server's schema once
 * deepagents is installed, and add the sandbox file state if the panel needs it.
 */
export interface DeepAgentState extends AgentState {
  todos?: Todo[];
}
