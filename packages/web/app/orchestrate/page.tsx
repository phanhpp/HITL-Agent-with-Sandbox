import type { Metadata } from "next";
import { OrchestrateClient } from "@/features/orchestrate/OrchestrateClient";

export const metadata: Metadata = {
  title: "Orchestrate — Agent UI patterns",
  description: "A deep agent plans a todo list, delegates to subagents, and synthesises.",
};

export default function OrchestratePage() {
  return <OrchestrateClient />;
}
