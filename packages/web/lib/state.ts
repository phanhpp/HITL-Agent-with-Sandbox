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
 * One answer and the LangSmith run that produced it, written by the agent's
 * `record_run_id` middleware as each turn ends (packages/agent/agents/run_ids.py).
 *
 * This is in graph state rather than a stream event so it survives a reload: the run id
 * is announced once, live, and a thumbs control on an older message would otherwise have
 * no run to post to. It also records WHICH message the run produced, which the browser
 * cannot work out on its own — one prompt can be several runs when a turn pauses for
 * approval, and only the resumed run writes the answer.
 */
export interface AnswerRun {
  message_id: string;
  /**
   * The ROOT run of the turn, not the middleware span that recorded it. Inside an
   * after_agent hook the "current" run is the hook's own child span, so the agent
   * deliberately stores the trace root here — that is the run a rating means.
   */
  run_id: string;
}

/**
 * langchain's built-in agent state, and the base of deepagents' DeepAgentState.
 * `messages` is append-only. Used by /approve (human_in_the_loop).
 *
 * `answer_runs` is absent until a turn finishes with tracing on, so it is optional and
 * an empty list is a correct state — same rule as `todos` below.
 */
export interface AgentState {
  messages: BaseMessage[];
  answer_runs?: AnswerRun[];
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
 * panel is a plain `stream.values` read — no HTTP route and no sandbox. The coder
 * subagent has a sandbox backend instead, which does NOT populate this key; its files
 * come over HTTP (see lib/use-sandbox-files.ts).
 *
 * A file VALUE is an object, not a string. Confirmed against a live thread:
 *
 *   "files": { "/a.md": { "content": "alpha", "encoding": "utf-8",
 *                         "created_at": "...", "modified_at": "..." } }
 *
 * This was declared `Record<string, string>` for a while, which is why FilePanel used to
 * print a JSON blob of the metadata where the file was meant to be.
 */
export interface StateFile {
  content: string;
  encoding?: string;
  created_at?: string;
  modified_at?: string;
}

export interface DeepAgentState extends AgentState {
  todos?: Todo[];
  files?: Record<string, StateFile>;
}
