import { expect, test } from "@playwright/test";

import { E2E_PASSWORD, signIn } from "./sign-in";

/*
 * The password gate. A public link spends the owner's model credit, so the two things
 * worth proving in a real browser are that a stranger gets nothing, and that the agent
 * proxy refuses them even if they skip the page.
 */

test("a stranger is sent to the login page and remembered destination", async ({ page }) => {
  await page.goto("/orchestrate");
  await expect(page).toHaveURL(/\/login\?next=%2Forchestrate/);
  await expect(page.getByLabel("Password")).toBeVisible();
});

test("the agent proxy refuses a stranger, so the LangSmith key is never attached", async ({ request }) => {
  const res = await request.get("/api/langgraph/threads/anything/state");
  expect(res.status()).toBe(401);
});

test("a wrong password stays on the page with an error", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Password").fill("wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Wrong password.")).toBeVisible();
});

test("the right password lands on the page you asked for", async ({ page }) => {
  await page.goto("/login?next=%2Forchestrate");
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/orchestrate$/);
});

test("signing in once covers the agent proxy as well", async ({ page }) => {
  await signIn(page);
  await page.goto("/approve");
  // fetch() from the page carries the Secure cookie; the API client would not over http.
  // Past the gate the unreachable fake upstream answers 502, not 401.
  const status = await page.evaluate(async () => (await fetch("/api/langgraph/threads/x/state")).status);
  expect(status).toBe(502);
});
