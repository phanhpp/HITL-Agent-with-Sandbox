import { act, renderHook, waitFor } from "@testing-library/react";
import type { AnyStream } from "@langchain/react";
import { describe, expect, it, vi } from "vitest";

import { useHitl } from "@/lib/use-hitl";

/*
 * The approval logic, which is where the worst bug in this project lived: two write_file
 * calls in ONE interrupt rendered two cards, and approving the first ran both. `decisions`
 * is positional and answers the whole interrupt at once, so filling the array on the first
 * click authorised an action the user never clicked.
 *
 * The fix staged decisions per card — and the first version of THAT had its own bug,
 * because `arr.length = n` creates holes and `some`/`every` skip holes. Both failure modes
 * are pinned below.
 *
 * `useHitl` touches only four things on `stream`, so a plain object is enough.
 */

type Fake = {
  stream: AnyStream;
  respondAll: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
};

function request(name: string, args: Record<string, unknown> = {}) {
  return { name, args };
}

/** One interrupt carrying N action requests — the shape that caused the bug. */
function fakeStream(
  interrupts: { id: string; requests: ReturnType<typeof request>[] }[],
  tasks: unknown[] = [],
): Fake {
  const respondAll = vi.fn().mockResolvedValue(undefined);
  const getState = vi.fn().mockResolvedValue({ tasks });

  const stream = {
    interrupts: interrupts.map((i) => ({
      id: i.id,
      value: { action_requests: i.requests },
    })),
    threadId: "thread-1",
    client: { threads: { getState } },
    respondAll,
  } as unknown as AnyStream;

  return { stream, respondAll, getState };
}

describe("one interrupt with two action requests", () => {
  it("renders both requests as a single group", async () => {
    const { stream } = fakeStream([
      { id: "i1", requests: [request("write_file"), request("write_file")] },
    ]);
    const { result } = renderHook(() => useHitl(stream));

    await waitFor(() => expect(result.current.groups).toHaveLength(1));
    expect(result.current.groups[0].requests).toHaveLength(2);
  });

  it("sends NOTHING when only the first card is approved", async () => {
    const { stream, respondAll } = fakeStream([
      { id: "i1", requests: [request("write_file"), request("write_file")] },
    ]);
    const { result } = renderHook(() => useHitl(stream));
    await waitFor(() => expect(result.current.groups).toHaveLength(1));

    act(() => result.current.approve("i1", 0));

    // THE bug: this used to fire immediately and run both writes.
    expect(respondAll).not.toHaveBeenCalled();
  });

  it("sends once, with both decisions in order, after the second card", async () => {
    const { stream, respondAll } = fakeStream([
      { id: "i1", requests: [request("write_file"), request("write_file")] },
    ]);
    const { result } = renderHook(() => useHitl(stream));
    await waitFor(() => expect(result.current.groups).toHaveLength(1));

    act(() => result.current.approve("i1", 0));
    act(() => result.current.reject("i1", 1, "no thanks"));

    expect(respondAll).toHaveBeenCalledTimes(1);
    const [payload] = respondAll.mock.calls[0];
    const decisions = payload.i1.decisions;

    expect(decisions).toHaveLength(2);
    expect(decisions[0].type).toBe("approve");
    expect(decisions[1].type).toBe("reject");
  });

  it("produces no holes when the cards are decided out of order", async () => {
    // The sparse-array regression: `arr.length = 2` then setting index 1 leaves index 0
    // a HOLE, and `some(d => d === undefined)` skips holes — so it read as fully decided.
    const { stream, respondAll } = fakeStream([
      { id: "i1", requests: [request("write_file"), request("write_file")] },
    ]);
    const { result } = renderHook(() => useHitl(stream));
    await waitFor(() => expect(result.current.groups).toHaveLength(1));

    act(() => result.current.approve("i1", 1));
    expect(respondAll).not.toHaveBeenCalled();

    act(() => result.current.approve("i1", 0));

    expect(respondAll).toHaveBeenCalledTimes(1);
    const decisions = respondAll.mock.calls[0][0].i1.decisions;
    expect(decisions).toHaveLength(2);
    expect(Object.keys(decisions)).toHaveLength(2); // holes would make this 1
    expect(decisions.every((d: unknown) => d !== undefined)).toBe(true);
  });
});

describe("two interrupts with one request each", () => {
  it("answers only the interrupt that was decided", async () => {
    const { stream, respondAll } = fakeStream([
      { id: "i1", requests: [request("write_file", { path: "/a.md" })] },
      { id: "i2", requests: [request("write_file", { path: "/b.md" })] },
    ]);
    const { result } = renderHook(() => useHitl(stream));
    await waitFor(() => expect(result.current.groups).toHaveLength(2));

    act(() => result.current.approve("i2", 0));

    expect(respondAll).toHaveBeenCalledTimes(1);
    const payload = respondAll.mock.calls[0][0];
    expect(Object.keys(payload)).toEqual(["i2"]);
  });

  it("sends a single-request group on the first click", async () => {
    const { stream, respondAll } = fakeStream([
      { id: "i1", requests: [request("send_email")] },
    ]);
    const { result } = renderHook(() => useHitl(stream));
    await waitFor(() => expect(result.current.groups).toHaveLength(1));

    act(() => result.current.approve("i1", 0));
    expect(respondAll).toHaveBeenCalledTimes(1);
  });
});

describe("answered interrupts", () => {
  it("hides an interrupt the server has already resolved", async () => {
    // tasks[].result is the server-side answered/pending discriminator.
    const { stream } = fakeStream(
      [{ id: "i1", requests: [request("send_email")] }],
      [{ result: { ok: true }, interrupts: [{ id: "i1" }] }],
    );
    const { result } = renderHook(() => useHitl(stream));

    await waitFor(() => expect(result.current.groups).toHaveLength(0));
  });

  it("still shows the interrupt when the check FAILS", async () => {
    // Deliberate: a failed lookup must never hide a live approval. Erring the other way
    // means the user silently cannot answer, and the run hangs.
    const { stream, getState } = fakeStream([
      { id: "i1", requests: [request("send_email")] },
    ]);
    getState.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useHitl(stream));

    await waitFor(() => expect(getState).toHaveBeenCalled());
    expect(result.current.groups).toHaveLength(1);
  });
});

describe("rejection reasons", () => {
  it("falls back to a default message when none is given", async () => {
    const { stream, respondAll } = fakeStream([
      { id: "i1", requests: [request("send_email")] },
    ]);
    const { result } = renderHook(() => useHitl(stream));
    await waitFor(() => expect(result.current.groups).toHaveLength(1));

    act(() => result.current.reject("i1", 0, ""));

    const decision = respondAll.mock.calls[0][0].i1.decisions[0];
    expect(decision.type).toBe("reject");
    expect(decision.message).toBeTruthy();
  });
});
