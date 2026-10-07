import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AGENT_API_PATH, ASSISTANTS, resolveAgentUrl } from "@/lib/agent";

/*
 * The URL helper, plus one cross-package check: the graph names the frontend asks for
 * have to exist in langgraph.json. Nothing else verifies that — a rename on the Python
 * side would otherwise surface as a 404 at runtime.
 */

function setSearch(search: string) {
  window.history.replaceState({}, "", `${window.location.pathname}${search}`);
}

afterEach(() => setSearch(""));

describe("resolveAgentUrl", () => {
  it("returns the same-origin proxy path by default", () => {
    expect(resolveAgentUrl()).toBe(`${window.location.origin}${AGENT_API_PATH}`);
  });

  it("honours an ?agentServer= override", () => {
    setSearch("?agentServer=http://127.0.0.1:2024");
    expect(resolveAgentUrl()).toBe("http://127.0.0.1:2024");
  });

  it("ignores the override when it is 'local'", () => {
    setSearch("?agentServer=local");
    expect(resolveAgentUrl()).toBe(`${window.location.origin}${AGENT_API_PATH}`);
  });

  it("points at the proxy, never at an agent host, by default", () => {
    // The whole reason this function exists: the browser talks to its own origin so the
    // API key can be injected server-side.
    expect(resolveAgentUrl().endsWith(AGENT_API_PATH)).toBe(true);
  });
});

describe("assistant ids", () => {
  it("names graphs that langgraph.json actually registers", () => {
    // Resolved from cwd (packages/web), not import.meta.url — under jsdom that is an
    // http: URL and readFileSync rejects it.
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), "../agent/langgraph.json"), "utf8"),
    );
    const registered = Object.keys(config.graphs);

    for (const assistantId of Object.values(ASSISTANTS)) {
      expect(registered).toContain(assistantId);
    }
  });
});
