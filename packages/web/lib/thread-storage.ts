/**
 * The saved thread id, with an expiry.
 *
 * The browser keeps only an id; the conversation lives on the agent server. The server
 * deletes threads after THREAD_TTL_MINUTES (checkpointer.ttl in packages/agent/langgraph.json),
 * so the browser must forget the id on the same schedule. Otherwise the page asks for a
 * thread that no longer exists and shows an error instead of a fresh chat.
 *
 * KEEP THE TWO NUMBERS EQUAL. If this is longer than the server's, you reload into a
 * deleted thread. If it is shorter, you lose a conversation the server still has.
 *
 * The age counts from when the id was saved, which is when the thread was created. The
 * server may count from the last activity, so a conversation older than the TTL is cut
 * off here even if it is still being used. Acceptable for a demo; touch the stamp on
 * submit if that ever matters.
 */
export const THREAD_TTL_MINUTES = 24 * 60;

const stampKey = (key: string) => `${key}:savedAt`;

/** The saved id, or null if there is none or it has expired. An expired id is removed. */
export function readThreadId(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  key: string,
  now: number = Date.now(),
): string | null {
  const id = storage.getItem(key);
  if (!id) return null;

  const stamp = Number(storage.getItem(stampKey(key)));
  if (!stamp) {
    // Saved before expiry existed (or seeded by a test): start the clock now rather
    // than throw away a conversation that may still be live.
    storage.setItem(stampKey(key), String(now));
    return id;
  }

  if (now - stamp > THREAD_TTL_MINUTES * 60_000) {
    clearThreadId(storage, key);
    return null;
  }
  return id;
}

export function saveThreadId(
  storage: Pick<Storage, "setItem">,
  key: string,
  id: string,
  now: number = Date.now(),
) {
  storage.setItem(key, id);
  storage.setItem(stampKey(key), String(now));
}

export function clearThreadId(storage: Pick<Storage, "removeItem">, key: string) {
  storage.removeItem(key);
  storage.removeItem(stampKey(key));
}
