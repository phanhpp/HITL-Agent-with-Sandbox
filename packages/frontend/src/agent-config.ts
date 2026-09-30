const LOCAL_AGENT_SERVER_URL = `${window.location.origin}/api/langgraph`;
const PRODUCTION_AGENT_SERVER_URL = `${window.location.origin}/api/langgraph`;

function resolveAgentServerUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const value = params.get("agentServer");
  if (!value || value === "local") return LOCAL_AGENT_SERVER_URL;
  if (value === "production") return PRODUCTION_AGENT_SERVER_URL;
  return value;
}

export const AGENT_SERVER_URL = resolveAgentServerUrl();

export const SLUG_TO_ASSISTANT: Record<string, string> = {
  "human-in-the-loop": "human_in_the_loop",
};
