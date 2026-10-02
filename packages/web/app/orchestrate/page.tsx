import type { Metadata } from "next";
import { OrchestrateClient } from "@/features/orchestrate/OrchestrateClient";

export const metadata: Metadata = {
  title: "Orchestrate — Full-stack agentic chatbot",
  description: "A deep agent plans a todo list, delegates to subagents, and synthesises.",
};

export default function OrchestratePage() {
  return <OrchestrateClient />;
}
