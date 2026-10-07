import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnswerRun } from "@/lib/state";
import { useFeedback } from "@/lib/use-feedback";

/*
 * The thumbs lookup and the vote.
 *
 * Two bugs are pinned here. One: the run map read only `stream.values`, which always
 * describes the branch TIP, so switching back to an older branch lost its thumbs. Two:
 * seeding recorded votes must not overwrite a vote already in flight, because LangSmith
 * ingestion is backgrounded (~12s) and a fetch right after voting legitimately cannot
 * see it yet.
 */

const RUN_A: AnswerRun = { message_id: "m1", run_id: "run-1" };
const RUN_B: AnswerRun = { message_id: "m2", run_id: "run-2" };
const STALE: AnswerRun = { message_id: "m1", run_id: "stale" };
const FRESH: AnswerRun = { message_id: "m1", run_id: "fresh" };

const streamA = streamWith([RUN_A]);
const streamB = streamWith([RUN_B]);
const streamFresh = streamWith([FRESH]);
const emptyStream = () => ({});

/* Built ONCE per test, never inside the render callback. A fresh array each render
   changes the memo's dependency every render, which re-fires the seed effect in a loop —
   the same hazard the hook guards against with its module-level NO_RUNS default. */
function streamWith(runs: AnswerRun[]) {
  const stream = { values: { answer_runs: runs } };
  return () => stream;
}

/** No votes recorded, so nothing is seeded and the buttons start empty. */
function stubFetch(votes: Record<string, { score: 0 | 1 }> = {}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ votes }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => stubFetch());
afterEach(() => vi.unstubAllGlobals());

describe("which messages can be rated", () => {
  it("finds a run recorded on the thread", () => {
    const { result } = renderHook(() => useFeedback(streamA(), "t1"));
    expect(result.current.runFor("m1")).toEqual(RUN_A);
  });

  it("returns undefined for a message with no recorded run", () => {
    const { result } = renderHook(() => useFeedback(streamA(), "t1"));
    // Mid-stream, a tool-call-only message, or anything the user typed.
    expect(result.current.runFor("unknown")).toBeUndefined();
    expect(result.current.runFor(undefined)).toBeUndefined();
  });

  it("includes runs from other branches", () => {
    // REGRESSION: branch 1's run lives only in checkpoint history, not in the tip values.
    const { result } = renderHook(() =>
      useFeedback(streamB(), "t1", [RUN_A]),
    );
    expect(result.current.runFor("m1")).toEqual(RUN_A);
    expect(result.current.runFor("m2")).toEqual(RUN_B);
  });

  it("lets a live value win over branch history for the same message", () => {
    const { result } = renderHook(() => useFeedback(streamFresh(), "t1", [STALE]));
    expect(result.current.runFor("m1")?.run_id).toBe("fresh");
  });

  it("survives a thread with no runs at all", () => {
    const { result } = renderHook(() => useFeedback(emptyStream(), "t1"));
    expect(result.current.runFor("m1")).toBeUndefined();
  });
});

describe("voting", () => {
  it("posts the run id and score", async () => {
    const fetchMock = stubFetch();
    const { result } = renderHook(() => useFeedback(streamA(), "t1"));

    await act(async () => {
      result.current.vote("m1", 1);
    });

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post).toBeDefined();
    expect(JSON.parse(post![1].body)).toMatchObject({
      message_id: "m1",
      run_id: "run-1",
      score: 1,
    });
  });

  it("includes a comment when one is given", async () => {
    const fetchMock = stubFetch();
    const { result } = renderHook(() => useFeedback(streamA(), "t1"));

    await act(async () => {
      result.current.vote("m1", 0, "too generic");
    });

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(post![1].body).comment).toBe("too generic");
  });

  it("marks the vote sent on a 200", async () => {
    const { result } = renderHook(() => useFeedback(streamA(), "t1"));

    await act(async () => {
      result.current.vote("m1", 1);
    });

    await waitFor(() => expect(result.current.voteFor("m1")?.status).toBe("sent"));
    expect(result.current.voteFor("m1")?.score).toBe(1);
  });

  it("marks the vote failed on a 400", async () => {
    // A rejected vote still RESOLVES the promise — without checking res.ok a 400 would
    // read as recorded.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
    );
    const { result } = renderHook(() => useFeedback(streamA(), "t1"));

    await act(async () => {
      result.current.vote("m1", 1);
    });

    await waitFor(() => expect(result.current.voteFor("m1")?.status).toBe("failed"));
  });

  it("marks the vote failed when the request throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { result } = renderHook(() => useFeedback(streamA(), "t1"));

    await act(async () => {
      result.current.vote("m1", 1);
    });

    await waitFor(() => expect(result.current.voteFor("m1")?.status).toBe("failed"));
  });

  it("does nothing for a message with no recorded run", async () => {
    const fetchMock = stubFetch();
    const { result } = renderHook(() => useFeedback(streamA(), "t1"));

    await act(async () => {
      result.current.vote("unknown", 1);
    });

    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("does nothing without a thread id", async () => {
    const fetchMock = stubFetch();
    const { result } = renderHook(() => useFeedback(streamA(), null));

    await act(async () => {
      result.current.vote("m1", 1);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("votes recorded earlier", () => {
  it("comes back as already voted after a reload", async () => {
    stubFetch({ "run-1": { score: 1 } });
    const { result } = renderHook(() => useFeedback(streamA(), "t1"));

    await waitFor(() => expect(result.current.voteFor("m1")?.status).toBe("sent"));
    expect(result.current.voteFor("m1")?.score).toBe(1);
  });

  it("does not overwrite a vote already in flight", async () => {
    // Ingestion is backgrounded, so a seed fetch can return nothing right after voting.
    // Overwriting would flip a just-clicked button back to empty.
    stubFetch({});
    const { result } = renderHook(() => useFeedback(streamA(), "t1"));

    await act(async () => {
      result.current.vote("m1", 0);
    });
    await waitFor(() => expect(result.current.voteFor("m1")).toBeDefined());

    expect(result.current.voteFor("m1")?.score).toBe(0);
  });

  it("asks for nothing when the thread has no runs", () => {
    const fetchMock = stubFetch();
    renderHook(() => useFeedback(emptyStream(), "t1"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
