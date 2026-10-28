import Link from "next/link";

// No "use client": this page is static, so it ships zero JavaScript.
const PAGES = [
  {
    href: "/approve",
    title: "Approve",
    blurb: "The agent proposes sending an email and stops. You approve, edit, or reject it.",
    shows: ["interrupt / resume", "branching: edit & retry", "rejoin after reload", "stop a run"],
  },
  {
    href: "/orchestrate",
    title: "Orchestrate",
    blurb:
      "A deep agent writes a plan, delegates each step to a specialist, and synthesises the result.",
    shows: ["live todo list", "subagent cards", "extended thinking", "approval on file writes"],
  },
];

export default function Home() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 py-12 sm:py-16">
        <h1 className="text-3xl sm:text-4xl font-bold text-text text-balance">
          HITL Agent with Sandbox
        </h1>
        <p className="mt-3 text-text-secondary max-w-2xl">
          Two chatbots over real LangGraph agents. Streaming, interrupts and
          checkpoints are live — nothing here is mocked.
        </p>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PAGES.map(({ href, title, blurb, shows }) => (
            <Link
              key={href}
              href={href}
              className="group flex flex-col rounded-xl border border-border bg-surface p-5 transition-colors hover:border-border-hover hover:bg-surface-secondary"
            >
              <h2 className="font-semibold text-text group-hover:text-primary transition-colors">
                {title}
              </h2>
              <p className="mt-2 text-sm text-text-secondary flex-1">{blurb}</p>
              <ul className="mt-4 space-y-1">
                {shows.map((item) => (
                  <li key={item} className="text-xs text-text-tertiary font-mono">
                    {item}
                  </li>
                ))}
              </ul>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
