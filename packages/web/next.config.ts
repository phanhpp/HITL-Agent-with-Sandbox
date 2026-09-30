import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The agent is reached through app/api/langgraph/[...path]/route.ts, not a
  // rewrite: the route handler injects the LangSmith key server-side so it
  // never reaches the browser. A rewrite could not add the header.
};

export default nextConfig;
