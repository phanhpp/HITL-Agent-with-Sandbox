import type { Page, Route } from "@playwright/test";

/*
 * A fake agent server, built from traffic recorded off the real one
 * (see e2e/record-fixtures.mjs). Every shape here — the history entry, the interrupt
 * payload, the JSON-RPC command envelope — was copied from an actual run, not invented.
 *
 * Why mock at all: these tests then need no agent, no API key and no model call, and
 * they give the same answer every time. A model does not, which is why asserting on
 * generated text is a bad idea.
 *
 * What it still tests for real: the browser's own behaviour. What it renders from server
 * state, and exactly what it sends back when you click. That is where the bugs were.
 */

export const THREAD_ID = "01a10ed8-eae3-7224-b433-f727e4fafdaa";
export const INTERRUPT_ID = "531e8d9bcf3d12b28ac18440fd4c6b96";
const CHECKPOINT_ID = "1f1c1260-e44f-6104-8001-824931cda7ba";

export interface ActionRequest {
  name: string;
  args: Record<string, unknown>;
  description?: string;
}

export const EMAIL_A: ActionRequest = {
  name: "send_email",
  args: { to: "alice@acme.com", subject: "First", body: "Message one." },
  description: "Review email before sending",
};

export const EMAIL_B: ActionRequest = {
  name: "send_email",
  args: { to: "bob@acme.com", subject: "Second", body: "Message two." },
  description: "Review email before sending",
};

/** The conversation as the server reports it, paused on an approval. */
function pendingState(requests: ActionRequest[]) {
  return {
    values: {
      messages: [
        {
          type: "human",
          content: "Send the emails.",
          id: "msg-human-1",
          additional_kwargs: {},
          response_metadata: {},
        },
        {
          type: "ai",
          content: "",
          id: "msg-ai-1",
          additional_kwargs: {},
          response_metadata: {},
          tool_calls: requests.map((r, i) => ({
            id: `call-${i}`,
            name: r.name,
            args: r.args,
            type: "tool_call",
          })),
        },
      ],
      answer_runs: [],
    },
    next: ["HumanInTheLoopMiddleware.after_model"],
    tasks: [
      {
        id: "task-1",
        name: "HumanInTheLoopMiddleware.after_model",
        path: ["__pregel_pull", "HumanInTheLoopMiddleware.after_model"],
        error: null,
        // result stays absent: that is the server's "not answered yet" signal.
        interrupts: [
          {
            id: INTERRUPT_ID,
            value: {
              action_requests: requests,
              review_configs: requests.map((r) => ({
                action_name: r.name,
                allowed_decisions: ["approve", "edit", "reject"],
              })),
            },
          },
        ],
      },
    ],
    metadata: { graph_id: "human_in_the_loop", assistant_id: "human_in_the_loop" },
    created_at: "2026-10-06T00:00:00.000Z",
    checkpoint: { checkpoint_id: CHECKPOINT_ID, thread_id: THREAD_ID, checkpoint_ns: "" },
    parent_checkpoint: null,
    interrupts: [],
    checkpoint_id: CHECKPOINT_ID,
    parent_checkpoint_id: null,
  };
}

export interface MockAgent {
  /** Every JSON-RPC body the page sent to /commands, in order. */
  commands: Record<string, any>[];
  /** Just the input.respond ones — i.e. answers to an approval. */
  responds(): Record<string, any>[];
}

/**
 * Serve a conversation that is paused awaiting approval of `requests`.
 *
 * One interrupt carrying N action requests is the shape that caused the worst bug in
 * this project: approving the first card ran every action, because the decisions list
 * answers the whole interrupt at once.
 */
export async function mockAgent(page: Page, requests: ActionRequest[]): Promise<MockAgent> {
  const state = pendingState(requests);
  const commands: Record<string, any>[] = [];

  // The thread id lives in localStorage, so seeding it is what makes the app behave as
  // though you are returning to an existing conversation.
  await page.addInitScript(
    ([key, id]) => window.localStorage.setItem(key as string, id as string),
    ["thread:approve", THREAD_ID],
  );

  await page.route("**/api/langgraph/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path.endsWith("/history")) return json([state]);
    if (path.endsWith("/state")) return json(state);
    if (path.endsWith("/votes")) return json({ votes: {} });

    if (path.endsWith("/commands")) {
      const body = JSON.parse(request.postData() ?? "{}");
      commands.push(body);
      return json({ type: "success", id: body.id, result: {}, meta: { applied_through_seq: 0 } });
    }

    // The live event stream. Held open and silent: these tests are about what the page
    // renders from saved state and what it sends back, not about token streaming.
    if (path.endsWith("/stream/events")) {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
    }

    return json({});
  });

  return {
    commands,
    responds: () => commands.filter((c) => c.method === "input.respond"),
  };
}

/** The decisions sent for an interrupt, or undefined if nothing was sent. */
export function decisionsSent(agent: MockAgent): { type: string }[] | undefined {
  const respond = agent.responds()[0];
  return respond?.params?.responses?.[0]?.response?.decisions;
}
