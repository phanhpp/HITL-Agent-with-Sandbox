import { beforeEach, describe, expect, it } from "vitest";

import { clearThreadId, readThreadId, saveThreadId, THREAD_TTL_MINUTES } from "./thread-storage";

const TTL_MS = THREAD_TTL_MINUTES * 60_000;

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe("the saved thread id", () => {
  let storage: ReturnType<typeof memoryStorage>;
  beforeEach(() => {
    storage = memoryStorage();
  });

  it("returns nothing when nothing was saved", () => {
    expect(readThreadId(storage, "thread:x")).toBeNull();
  });

  it("returns a fresh id", () => {
    saveThreadId(storage, "thread:x", "abc", 1_000);
    expect(readThreadId(storage, "thread:x", 1_000 + TTL_MS - 1)).toBe("abc");
  });

  it("forgets an id older than the TTL and removes both keys", () => {
    saveThreadId(storage, "thread:x", "abc", 1_000);
    expect(readThreadId(storage, "thread:x", 1_000 + TTL_MS + 1)).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it("keeps an id saved before expiry existed, and starts its clock", () => {
    storage.setItem("thread:x", "old");
    expect(readThreadId(storage, "thread:x", 5_000)).toBe("old");
    // The clock started at 5_000, so it now expires on schedule.
    expect(readThreadId(storage, "thread:x", 5_000 + TTL_MS + 1)).toBeNull();
  });

  it("keeps each page's conversation separate", () => {
    saveThreadId(storage, "thread:approve", "a", 1_000);
    saveThreadId(storage, "thread:orchestrate", "o", 1_000);
    clearThreadId(storage, "thread:approve");
    expect(readThreadId(storage, "thread:approve", 2_000)).toBeNull();
    expect(readThreadId(storage, "thread:orchestrate", 2_000)).toBe("o");
  });
});
