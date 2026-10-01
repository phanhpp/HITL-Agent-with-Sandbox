/**
 * Browser-side agent config.
 *
 * The Vite version (frontend/src/agent-config.ts) read window.location at MODULE
 * scope, so merely importing it on the server threw "window is not defined". Here
 * the window access lives inside a function, so this module is safe to import
 * anywhere; only client components may call resolveAgentUrl().
 */

/** Same-origin path served by app/api/langgraph/[...path]/route.ts. */
export const AGENT_API_PATH = "/api/langgraph";

/**
 * Where the browser sends agent traffic. Call this from a client component only
 * (inside a useState initializer or useMemo), never at module scope.
 *
 * `?agentServer=<url>` bypasses the proxy and talks to an agent server directly —
 * useful for pointing a local page at a deployed agent. Note that doing so sends
 * no API key, so it only works against a server that needs none (langgraph dev).
 */
export function resolveAgentUrl(): string {
  // A "use client" component is still server-rendered in Next before it hydrates,
  // so this runs once with no window. Return the relative path then: no request is
  // made during SSR (useStream connects from an effect), so the value is unused —
  // it only has to not throw.
  if (typeof window === "undefined") return AGENT_API_PATH;

  const override = new URLSearchParams(window.location.search).get("agentServer");
  if (override && override !== "local") return override;
  return `${window.location.origin}${AGENT_API_PATH}`;
}

/**
 * Graph names, which must match the keys under "graphs" in
 * packages/agent/langgraph.json. This is the `assistantId` useStream sends.
 */
export const ASSISTANTS = {
  approve: "human_in_the_loop",
} as const;
