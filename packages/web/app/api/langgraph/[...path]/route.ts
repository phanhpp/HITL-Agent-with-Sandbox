import type { NextRequest } from "next/server";

/**
 * Proxy between the browser and the LangGraph agent server.
 *
 * Why this exists rather than a next.config rewrite: in production the upstream
 * is a LangSmith Deployment that requires an `X-Api-Key` header. A rewrite cannot
 * add one, and putting the key in the browser would expose it. So every agent
 * request goes through here, the key is attached server-side, and the browser only
 * ever talks to its own origin (which also sidesteps CORS).
 *
 * This is the production equivalent of the Vite dev proxy in
 * packages/frontend/vite.config.ts, including stripping the /api/langgraph prefix.
 */

// Node, not edge: we stream an upstream body straight through and want no
// header or body-size constraints beyond the platform's.
export const runtime = "nodejs";

// Never cache or statically analyse this route — every request is a live call.
export const dynamic = "force-dynamic";

// Agent turns take minutes. Vercel with fluid compute allows 300s on Hobby
// (which is also its maximum) and up to 800s on Pro.
export const maxDuration = 300;

/**
 * Request headers worth forwarding. Everything else is dropped: `host` would
 * point at our own origin, and `cookie` must not leak to the agent server.
 * `last-event-id` matters — it is how an SSE client resumes a dropped stream.
 */
const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "last-event-id"];

/** Response headers worth returning. `content-type` carries text/event-stream. */
const FORWARDED_RESPONSE_HEADERS = ["content-type", "content-disposition", "etag"];

async function proxy(req: NextRequest, ctx: RouteContext<"/api/langgraph/[...path]">) {
  const base = process.env.AGENT_SERVER_URL;
  if (!base) {
    return Response.json(
      { error: "AGENT_SERVER_URL is not set. Copy .env.local.example to .env.local." },
      { status: 500 },
    );
  }

  // In Next 16 params is a promise.
  const { path } = await ctx.params;
  const search = req.nextUrl.search;
  const upstreamUrl = `${base.replace(/\/$/, "")}/${(path ?? []).join("/")}${search}`;

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }

  // Only set when present, so `langgraph dev` — which needs no auth — works locally
  // with this same file and an unset key.
  const apiKey = process.env.LANGSMITH_API_KEY;
  if (apiKey) headers.set("X-Api-Key", apiKey);

  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      // Required when body is a stream: we start sending before the response
      // arrives. Not in the fetch types yet, hence the cast.
      ...(hasBody ? { duplex: "half" } : {}),
      redirect: "manual",
      cache: "no-store",
      signal: req.signal,
    } as RequestInit);
  } catch (error) {
    // Most often: the agent server is not running. Say so plainly instead of
    // surfacing an opaque fetch failure to the stream client.
    return Response.json(
      {
        error: "Could not reach the agent server.",
        upstream: base,
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  // Keep SSE flowing: no-transform stops intermediaries rewriting the body, and
  // x-accel-buffering disables nginx-style buffering that would batch up events.
  responseHeaders.set("cache-control", "no-cache, no-transform");
  responseHeaders.set("x-accel-buffering", "no");

  // Pass the body through as a stream rather than awaiting it, so tokens reach
  // the browser as they are produced.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
