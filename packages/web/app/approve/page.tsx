import type { Metadata } from "next";
import { ApproveChat } from "@/features/approve/ApproveChat";

// Server component: exists so the route can export metadata. The interactive
// part is ApproveChat, which is "use client".
export const metadata: Metadata = {
  title: "Approve — Agent UI patterns",
  description: "The agent pauses before sending an email. Approve, edit, or reject it.",
};

export default function ApprovePage() {
  return <ApproveChat />;
}
