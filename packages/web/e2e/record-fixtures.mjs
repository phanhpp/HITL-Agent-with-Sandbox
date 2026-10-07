/*
 * Records REAL agent traffic once, so the e2e fixtures are not guesses.
 *
 * Run it by hand, with both dev servers up and an API key present:
 *
 *     node e2e/record-fixtures.mjs
 *
 * It drives /approve through one email approval — the turn that exercises an interrupt —
 * and writes every /api/langgraph request and response to e2e/fixtures/. The specs then
 * replay those, so CI needs no agent, no key and no model call.
 *
 * This is NOT part of the suite. It costs money and talks to a real model; it exists so
 * the recording can be redone when the protocol changes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "fixtures");
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:4200";

/** One captured exchange. `url` keeps only the path+query, so the host never matters. */
const captured = [];

const browser = await chromium.launch();
const page = await browser.newPage();

page.on("response", async (response) => {
  const url = new URL(response.url());
  if (!url.pathname.startsWith("/api/langgraph")) return;

  const request = response.request();
  let body = "";
  try {
    body = await response.text();
  } catch {
    // A stream still open when the page closed. Keep the shape, drop the body.
    body = "";
  }

  captured.push({
    method: request.method(),
    path: url.pathname + url.search,
    requestBody: request.postData() ?? null,
    status: response.status(),
    contentType: response.headers()["content-type"] ?? "application/json",
    body,
  });
  process.stdout.write(`  ${request.method()} ${url.pathname} -> ${response.status()}\n`);
});

console.log("recording /approve with an email approval…");
// A fresh browser context has no stored thread, so this already IS a new conversation —
// "New conversation" is disabled until one exists.
await page.goto(`${BASE}/approve`);
await page.waitForTimeout(1500);

await page
  .getByPlaceholder(/Ask the agent/i)
  .fill("Send an email to team@acme.com with subject 'Q4' saying revenue grew 15%.");
await page.keyboard.press("Enter");

// Wait for the approval card rather than a fixed sleep.
await page.getByRole("button", { name: /^Approve$/i }).waitFor({ timeout: 60_000 });
console.log("approval card reached");

await page.getByRole("button", { name: /^Approve$/i }).click();
await page.waitForTimeout(8000);

mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, "approve-flow.json"), JSON.stringify(captured, null, 2));
console.log(`\nwrote ${captured.length} exchanges to fixtures/approve-flow.json`);

await browser.close();
