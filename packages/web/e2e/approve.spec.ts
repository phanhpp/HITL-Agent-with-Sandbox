import { expect, test } from "@playwright/test";

import { decisionsSent, EMAIL_A, EMAIL_B, mockAgent } from "./mock-agent";

/*
 * The approval flow, end to end in a real browser against a fake agent.
 *
 * The unit tests already cover the decision logic in isolation. These cover what the
 * unit tests cannot: that the logic is actually wired to the buttons, that the card is
 * built from server state rather than anything the page is holding, and that the exact
 * JSON leaving the browser is correct.
 */

test.describe("a conversation paused on one approval", () => {
  test("renders the pending action from server state alone", async ({ page }) => {
    await mockAgent(page, [EMAIL_A]);
    await page.goto("/approve");

    // Nothing streamed. Everything on screen came from the saved conversation.
    await expect(page.getByRole("button", { name: /^Approve$/i })).toBeVisible();
    await expect(page.getByText("alice@acme.com")).toBeVisible();
  });

  test("survives a reload, because the pause lives on the server", async ({ page }) => {
    const agent = await mockAgent(page, [EMAIL_A]);
    await page.goto("/approve");
    await expect(page.getByRole("button", { name: /^Approve$/i })).toBeVisible();

    await page.reload();

    // THE thesis of the project: anything the page must remember, a reload can take away.
    // This card is still here because it was never the page's to remember.
    await expect(page.getByRole("button", { name: /^Approve$/i })).toBeVisible();
    await expect(page.getByText("alice@acme.com")).toBeVisible();
    expect(agent.responds()).toHaveLength(0);
  });

  test("approving sends exactly one answer, naming the interrupt", async ({ page }) => {
    const agent = await mockAgent(page, [EMAIL_A]);
    await page.goto("/approve");

    await page.getByRole("button", { name: /^Approve$/i }).click();

    await expect.poll(() => agent.responds().length).toBe(1);
    expect(decisionsSent(agent)).toEqual([{ type: "approve" }]);
  });

  test("rejecting sends a reject, not an approve", async ({ page }) => {
    const agent = await mockAgent(page, [EMAIL_A]);
    await page.goto("/approve");

    await page.getByRole("button", { name: /^Reject$/i }).click();
    const send = page.getByRole("button", { name: /send rejection|confirm|^Reject$/i }).last();
    await send.click();

    await expect.poll(() => agent.responds().length).toBe(1);
    expect(decisionsSent(agent)?.[0].type).toBe("reject");
  });
});

test.describe("one interrupt carrying TWO actions", () => {
  /*
   * The regression that matters most. The agent asked to send two emails in one message,
   * which is a SINGLE approval carrying a list — you answer the whole list at once. The
   * first version of this filled every slot from the first click, so approving one card
   * sent the other email too.
   */

  test("shows a card per action", async ({ page }) => {
    await mockAgent(page, [EMAIL_A, EMAIL_B]);
    await page.goto("/approve");

    await expect(page.getByRole("button", { name: /^Approve$/i })).toHaveCount(2);
    await expect(page.getByText("alice@acme.com")).toBeVisible();
    await expect(page.getByText("bob@acme.com")).toBeVisible();
  });

  test("approving ONE sends nothing at all", async ({ page }) => {
    const agent = await mockAgent(page, [EMAIL_A, EMAIL_B]);
    await page.goto("/approve");

    await page.getByRole("button", { name: /^Approve$/i }).first().click();
    await page.waitForTimeout(500);

    // The bug: this used to fire immediately and send BOTH emails.
    expect(agent.responds()).toHaveLength(0);
  });

  test("approving both sends one answer with both decisions, in order", async ({ page }) => {
    const agent = await mockAgent(page, [EMAIL_A, EMAIL_B]);
    await page.goto("/approve");

    await page.getByRole("button", { name: /^Approve$/i }).first().click();
    await page.getByRole("button", { name: /^Approve$/i }).last().click();

    await expect.poll(() => agent.responds().length).toBe(1);
    expect(decisionsSent(agent)).toEqual([{ type: "approve" }, { type: "approve" }]);
  });

  test("deciding out of order still sends a complete list", async ({ page }) => {
    // The sparse-array regression: filling index 1 first used to leave a HOLE at 0,
    // and the "is anything still undecided?" check skips holes.
    const agent = await mockAgent(page, [EMAIL_A, EMAIL_B]);
    await page.goto("/approve");

    await page.getByRole("button", { name: /^Approve$/i }).last().click();
    await page.waitForTimeout(300);
    expect(agent.responds()).toHaveLength(0);

    await page.getByRole("button", { name: /^Approve$/i }).first().click();

    await expect.poll(() => agent.responds().length).toBe(1);
    const decisions = decisionsSent(agent);
    expect(decisions).toHaveLength(2);
    expect(decisions?.every((d) => d?.type === "approve")).toBe(true);
  });
});
