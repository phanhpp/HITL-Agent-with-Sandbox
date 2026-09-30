"use client";

import dynamic from "next/dynamic";
import { ApproveChat } from "./ApproveChat";

/**
 * Loads ChatShell client-only.
 *
 * ChatShell reads localStorage synchronously in a useState initializer (GUIDE.md 8.3),
 * which needs the component to never render on the server. `ssr: false` does that, and
 * per Next 16's docs it only works from inside a client component — which is why this
 * thin wrapper exists instead of calling dynamic() in app/approve/page.tsx.
 */
const ChatShell = dynamic(() => import("@/components/ChatShell"), { ssr: false });

export function ApproveClient() {
  return (
    <ChatShell
      storageKey="thread:approve"
      renderChat={(props) => <ApproveChat {...props} />}
    />
  );
}
