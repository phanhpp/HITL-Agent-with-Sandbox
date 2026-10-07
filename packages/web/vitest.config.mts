import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Unit tests for the hooks. No browser, no agent server, no API key — every test here
 * builds a fake `stream` object or stubs `fetch`.
 *
 * The `@/` alias has to be repeated. Vitest does not read `tsconfig.json`'s `paths`, so
 * without this `import { resolveAgentUrl } from "@/lib/agent"` fails to resolve even
 * though `tsc` is perfectly happy.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    // The hooks call useState/useEffect and read window.location, so they need a DOM.
    environment: "jsdom",
    globals: true,
    include: ["lib/**/*.test.ts", "lib/**/*.test.tsx"],
  },
});
