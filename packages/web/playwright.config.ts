import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against a FAKE agent.
 *
 * Every agent call is intercepted and answered from fixtures recorded off the real
 * server, so these need no agent process, no API key and no model call — and they give
 * the same answer every run, which a model never would.
 *
 * They do start a real Next.js server, because the point is to exercise the real browser
 * behaviour: what gets rendered from server state, and what JSON leaves the page when
 * you click.
 */
export default defineConfig({
  testDir: "./e2e",
  // Only the specs. record-fixtures.mjs is a manual tool, not a test.
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4300",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  /*
   * A production build on port 4300, not the 4200 `make dev-next` uses.
   *
   * `next start`, not `next dev`: Next 16 refuses to run a second dev server from the
   * same directory whatever port you give it, so `next dev` here would fail for anyone
   * who had the app running. This also tests what actually ships.
   *
   * The build is a SEPARATE step (see the test:e2e script), not chained here with `&&`.
   * A chained command leaves `next start` running as a grandchild that Playwright cannot
   * kill, so the suite passes and then hangs forever on teardown — which in CI is a job
   * timeout rather than a visible failure.
   */
  webServer: {
    // Next's bin run DIRECTLY under node, not via `pnpm exec`. Playwright kills the
    // process it spawned; a package-manager wrapper spawns the real server as a child
    // that survives, and teardown then waits on it forever.
    command: "node node_modules/next/dist/bin/next start --port 4300",
    url: "http://127.0.0.1:4300/approve",
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    // The proxy refuses to start without this. The mock means it is never reached.
    env: { AGENT_SERVER_URL: "http://127.0.0.1:9/unused" },
  },
});
