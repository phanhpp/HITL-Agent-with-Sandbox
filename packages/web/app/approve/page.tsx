import type { Metadata } from "next";
import { ApproveClient } from "@/features/approve/ApproveClient";

export const metadata: Metadata = {
  title: "Approve — HITL Agent with Sandbox",
  description: "The agent pauses before sending an email. Approve, edit, or reject it.",
};

export default function ApprovePage() {
  return <ApproveClient />;
}
