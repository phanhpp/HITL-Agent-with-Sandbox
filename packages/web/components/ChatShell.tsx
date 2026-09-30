"use client";

import { useCallback, useState, type ReactNode } from "react";

/**
 * GUIDE.md 8.3's ChatShell, shared by every page.
 *
 * Owns which conversation you are in, and swaps between the live chat and a Rejoin
 * button. Two properties do the real work, and both are easy to lose:
 *
 * 1. `localStorage` is read SYNCHRONOUSLY in the useState initializer, so threadId is
 *    already correct on the first render. Reading it in an effect leaves render 1 with
 *    null, and the conversation is gone after a reload. This is only legal because the
 *    page loads this module with `dynamic(..., { ssr: false })` — a plain "use client"
 *    component is still server-rendered, where localStorage does not exist.
 *
 * 2. This component NEVER UNMOUNTS. Its threadId sits here untouched while the chat is
 *    left and rejoined; only the child is torn down and rebuilt. That is what makes
 *    Rejoin reconnect to the same conversation rather than start a new one.
 *
 * Nothing loops: a click changes state, React re-renders, and it waits again.
 */
export interface ChatShellRenderProps {
  /** null on a first visit; useStream then creates a thread on the first submit. */
  threadId: string | null;
  /** Pass straight to useStream's onThreadId. useStream calls it itself. */
  onThreadId: (id: string) => void;
  /** Call AFTER `await stream.disconnect()`. Hides the chat, shows Rejoin. */
  onLeave: () => void;
}

export default function ChatShell({
  storageKey,
  renderChat,
}: {
  /** One key per page, e.g. "thread:approve", so pages keep separate conversations. */
  storageKey: string;
  renderChat: (props: ChatShellRenderProps) => ReactNode;
}) {
  const [threadId, setThreadId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(storageKey);
    } catch {
      // Private mode or blocked storage: start fresh rather than crash.
      return null;
    }
  });

  const [connected, setConnected] = useState(true);

  // Updates React state and localStorage together. Used both to save a real id and
  // to clear it (id === null), which is why the else branch exists.
  const persist = useCallback(
    (id: string | null) => {
      setThreadId(id);
      try {
        if (id) localStorage.setItem(storageKey, id);
        else localStorage.removeItem(storageKey);
      } catch {
        // The id still works for this page view.
      }
    },
    [storageKey],
  );

  if (!connected) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center">
        <div className="text-center space-y-3">
          <p className="text-sm text-text-secondary">
            You left the conversation. It kept running on the server.
          </p>
          <button
            type="button"
            onClick={() => setConnected(true)}
            className="px-4 py-2 rounded-md bg-primary-dark text-text border border-border hover:border-border-hover transition-colors"
          >
            Rejoin
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-2 border-b border-border">
        <span className="text-xs font-mono text-text-tertiary truncate">
          {threadId ? `thread ${threadId.slice(0, 8)}…` : "new conversation"}
        </span>
        <button
          type="button"
          onClick={() => persist(null)}
          disabled={!threadId}
          className="text-xs text-text-secondary hover:text-text disabled:opacity-40 disabled:hover:text-text-secondary transition-colors"
        >
          New conversation
        </button>
      </div>

      {renderChat({
        threadId,
        onThreadId: persist,
        onLeave: () => setConnected(false),
      })}
    </div>
  );
}
