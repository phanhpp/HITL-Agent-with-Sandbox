import type { BaseMessage } from "langchain";

export interface AgentState {
  messages: BaseMessage[];
}
