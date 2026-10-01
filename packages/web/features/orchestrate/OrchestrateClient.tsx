"use client";

import dynamic from "next/dynamic";
import { OrchestrateChat } from "./OrchestrateChat";

/**
 * Loads ChatShell client-only — same reason as ApproveClient: ChatShell reads
 * localStorage synchronously in a useState initializer, so it must never render on the
 * server, and `ssr: false` only works from inside a client component.
 *
 * A separate storageKey means /orchestrate keeps its own conversation; switching pages
 * does not disturb /approve's.
 */
const ChatShell = dynamic(() => import("@/components/ChatShell"), { ssr: false });

export function OrchestrateClient() {
  return (
    <ChatShell
      storageKey="thread:orchestrate"
      renderChat={(props) => <OrchestrateChat {...props} />}
    />
  );
}
