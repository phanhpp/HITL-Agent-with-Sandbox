"""One sandbox per thread, and the single function that owns the provider choice.

Everything provider-specific lives in `get_or_create_sandbox_for_thread`. Swapping
LangSmith for Daytona is a rewrite of that one body plus the seed call — nothing in
the graph or the UI knows which provider is behind it.

Why per thread: a sandbox is a real machine with a filesystem. Sharing one across
conversations would let one visitor read and overwrite another's work. The thread id
is already the isolation boundary everywhere else in this app, so it is the name.

Facts below came from probing the live API, not the docs:

  - `get_sandbox(name)` raises `ResourceNotFoundError` when the name is unused, so
    the try/except can be precise rather than swallowing everything.
  - A cold `create_sandbox` takes under a second, and a *stopped* sandbox restarts
    by itself on the next operation (~2s). That is why there is no status check and
    no start call here: asking first would cost a round trip to learn nothing.
"""

import asyncio

from deepagents.backends import LangSmithSandbox
from langsmith.sandbox import (
    ResourceAlreadyExistsError,
    ResourceNameConflictError,
    ResourceNotFoundError,
    Sandbox,
    SandboxClient,
)

# Stop after 10 minutes idle, delete an hour after that. Any command or file
# operation resets the idle timer.
#
# The platform defaults are 600s idle and ~14 DAYS before deletion. The idle default
# is fine; the deletion default is not, for a public demo — it would keep a machine
# per visitor for a fortnight. 3600 is the shortest useful window and, like every
# value here, must be a multiple of 60.
IDLE_TTL_SECONDS = 600
DELETE_AFTER_STOP_SECONDS = 3600

WORKDIR = "/workspace"

# A small project with a real bug in it, and a test that already fails because of it.
#
# The seed is not decoration. A coding agent with an empty directory can only create,
# which demonstrates nothing about reading code — and an empty file panel is a poor
# first impression. Starting from a red test gives the demo a verifiable ending:
# the agent reads, finds the cause, edits, and runs the tests, and the user sees the
# approval card on that test run.
#
# The bug: `Router.handle` matches on the raw path, so "/items?limit=5" misses the
# route registered as "/items" and 404s. `test/router.test.js` asserts otherwise.
#
# `node --test` is the built-in runner, so nothing here needs `npm install` — which
# matters because sandbox egress is allowlisted to a fixed set of hosts.
SEED_FILES: list[tuple[str, bytes]] = [
    (
        f"{WORKDIR}/README.md",
        b"# tiny-router\n"
        b"\n"
        b"A minimal router and key/value store, used as a scratch project.\n"
        b"\n"
        b"    npm test\n"
        b"\n"
        b"One test is currently failing.\n",
    ),
    (
        f"{WORKDIR}/package.json",
        b"{\n"
        b'  "name": "tiny-router",\n'
        b'  "version": "1.0.0",\n'
        b'  "type": "module",\n'
        b'  "scripts": { "test": "node --test" }\n'
        b"}\n",
    ),
    (
        f"{WORKDIR}/src/router.js",
        b"// Routes a method and path to a handler.\n"
        b"export class Router {\n"
        b"  #routes = new Map();\n"
        b"\n"
        b"  add(method, path, handler) {\n"
        b"    this.#routes.set(`${method} ${path}`, handler);\n"
        b"    return this;\n"
        b"  }\n"
        b"\n"
        b"  handle(method, path, ...args) {\n"
        b"    const handler = this.#routes.get(`${method} ${path}`);\n"
        b"    if (!handler) return { status: 404, body: 'Not Found' };\n"
        b"    return handler(...args);\n"
        b"  }\n"
        b"}\n",
    ),
    (
        f"{WORKDIR}/src/store.js",
        b"// A tiny in-memory key/value store.\n"
        b"export class Store {\n"
        b"  #items = new Map();\n"
        b"\n"
        b"  set(key, value) {\n"
        b"    this.#items.set(key, value);\n"
        b"    return value;\n"
        b"  }\n"
        b"\n"
        b"  get(key) {\n"
        b"    return this.#items.get(key);\n"
        b"  }\n"
        b"\n"
        b"  keys() {\n"
        b"    return [...this.#items.keys()];\n"
        b"  }\n"
        b"\n"
        b"  delete(key) {\n"
        b"    return this.#items.delete(key);\n"
        b"  }\n"
        b"\n"
        b"  get size() {\n"
        b"    return this.#items.size;\n"
        b"  }\n"
        b"}\n",
    ),
    (
        f"{WORKDIR}/src/index.js",
        b"import { Store } from './store.js';\n"
        b"import { Router } from './router.js';\n"
        b"\n"
        b"export function createApp() {\n"
        b"  const store = new Store();\n"
        b"  const router = new Router();\n"
        b"\n"
        b"  router.add('GET', '/items', () => ({ status: 200, body: store.keys() }));\n"
        b"  router.add('POST', '/items', (key, value) => ({\n"
        b"    status: 201,\n"
        b"    body: store.set(key, value),\n"
        b"  }));\n"
        b"\n"
        b"  return { store, router };\n"
        b"}\n",
    ),
    (
        f"{WORKDIR}/test/router.test.js",
        b"import test from 'node:test';\n"
        b"import assert from 'node:assert/strict';\n"
        b"import { Router } from '../src/router.js';\n"
        b"\n"
        b"test('routes an exact path', () => {\n"
        b"  const router = new Router().add('GET', '/items', () => ({ status: 200 }));\n"
        b"  assert.equal(router.handle('GET', '/items').status, 200);\n"
        b"});\n"
        b"\n"
        b"test('unknown paths 404', () => {\n"
        b"  const router = new Router();\n"
        b"  assert.equal(router.handle('GET', '/nope').status, 404);\n"
        b"});\n"
        b"\n"
        b"test('a query string does not change the route', () => {\n"
        b"  const router = new Router().add('GET', '/items', () => ({ status: 200 }));\n"
        b"  assert.equal(router.handle('GET', '/items?limit=5').status, 200);\n"
        b"});\n",
    ),
    (
        f"{WORKDIR}/test/store.test.js",
        b"import test from 'node:test';\n"
        b"import assert from 'node:assert/strict';\n"
        b"import { Store } from '../src/store.js';\n"
        b"\n"
        b"test('set returns the stored value', () => {\n"
        b"  assert.equal(new Store().set('a', 1), 1);\n"
        b"});\n"
        b"\n"
        b"test('get reads back what was set', () => {\n"
        b"  const store = new Store();\n"
        b"  store.set('a', 1);\n"
        b"  assert.equal(store.get('a'), 1);\n"
        b"});\n"
        b"\n"
        b"test('delete removes the key', () => {\n"
        b"  const store = new Store();\n"
        b"  store.set('a', 1);\n"
        b"  assert.equal(store.delete('a'), true);\n"
        b"  assert.equal(store.size, 0);\n"
        b"});\n",
    ),
]


# TODO — let the coder work on a REAL repository, not just the seeded project.
#
# The seeded project proves the mechanism; it is not a coding assistant. The key thing
# to be clear about: a cloud sandbox cannot MOUNT a laptop folder, but it does not need
# to — the files just have to be COPIED in. `upload_files` already does exactly that a
# few lines below; seeding from a real repo is the same call with a different list.
#
#   1. A local repo -> upload it.  No new API, no new backend:
#
#          files = []
#          for root, _, names in os.walk(repo_path):
#              for name in names:
#                  full = os.path.join(root, name)
#                  rel = os.path.relpath(full, repo_path)
#                  files.append((f"{WORKDIR}/{rel}", Path(full).read_bytes()))
#          LangSmithSandbox(sandbox=sandbox).upload_files(files)
#
#      Skip .git, node_modules and anything large, and remember "local" means local to
#      the PROCESS: on a laptop running `langgraph dev` that is your repo, in a
#      deployment it is the server's disk. For a deployed app the bytes have to come
#      from the browser instead.
#
#   2. A git repo -> two options, and the cheap one is good.
#        - Simply let the coder run `git clone <url>` with the shell it already has.
#          Source repositories are on the sandbox egress allowlist, so this needs no
#          configuration at all.
#        - Or `git_mount(id=, mount_path=, remote_url=, ref=, refresh_interval_seconds=)`
#          through `mount_config(mounts=[...])` on `create_sandbox`, which is declarative
#          and can refresh itself. Private repos need credentials via
#          `mount_config(auth=...)`, never baked into the image.
#        - `s3_mount` / `gcs_mount` / `context_hub_mount` exist for bucket-shaped sources.
#
#   3. GETTING WORK BACK OUT is the part that is easy to forget. A copy does not sync:
#      nothing the agent changes reaches the original. Either `download_files([...])`,
#      or have the coder commit and push to a branch — which is the better demo anyway.
#
# A different mode, not a way of doing the above: `LocalShellBackend(root_dir=...)` skips
# the sandbox entirely and edits the real filesystem in place. That is a genuine coding
# assistant on your own checkout, with no copy and no sync problem — and no isolation, so
# it must be opt-in from config and must never be reachable from a public deployment.
#
# Not yet used, and worth it once a real repo is in there:
#   - `sandbox.tunnel(remote_port)` + `sandbox.service` — expose a dev server the agent
#     started, so the user can open what it built.
#   - `sandbox.capture_snapshot()` — bake a prepared machine into an image so later
#     threads boot ready instead of re-seeding.
#   - `run(..., pty=True, on_stdout=...)` — stream terminal output instead of one blob.

_client: SandboxClient | None = None


def _get_client() -> SandboxClient:
    """One client per process. Constructing it reads LANGSMITH_API_KEY."""
    global _client
    if _client is None:
        _client = SandboxClient()
    return _client


def sandbox_name(thread_id: str) -> str:
    """The sandbox belonging to a thread. Also what the HTTP routes look up."""
    return f"orchestrate-{thread_id}"


# Identity for the baseline commit. Git refuses to commit without one, and the sandbox
# has no global config. Deliberately not a real person.
GIT_IDENTITY = (
    'git config user.email "agent@sandbox.local" && '
    'git config user.name "Sandbox Baseline"'
)


def ensure_git_baseline(backend: LangSmithSandbox) -> None:
    """Make sure the workspace has a commit recording how it started.

    This is what the file panel diffs against, and the reason it lives HERE rather than
    in the browser: a baseline held in page state dies on the next reload, and then the
    UI adopts the already-edited files as the "before" and shows no changes at all.
    On the machine it survives anything the browser does.

    It is a plain local repository on a throwaway VM. No remote, no push, nothing
    outside the sandbox.

    If the workspace already has git — a cloned or mounted repository — its own HEAD is
    the baseline already, so nothing is created. That is the whole `.git` check.
    """
    backend.execute(
        f"cd {WORKDIR} && "
        "if [ ! -d .git ]; then "
        f"  git init -q && {GIT_IDENTITY} && "
        "  git add -A && git commit -q -m 'baseline: workspace as seeded'; "
        "fi"
    )


def _create_and_seed(client: SandboxClient, name: str) -> Sandbox:
    """Create the machine and put a project on it. Runs in a worker thread."""
    sandbox = client.create_sandbox(
        name=name,
        idle_ttl_seconds=IDLE_TTL_SECONDS,
        delete_after_stop_seconds=DELETE_AFTER_STOP_SECONDS,
    )
    backend = LangSmithSandbox(sandbox=sandbox)
    # upload_files is a native API, not a shell command, so the seed does not depend
    # on quoting or on a shell being present.
    backend.upload_files(SEED_FILES)
    ensure_git_baseline(backend)
    return sandbox


def _resolve(thread_id: str) -> Sandbox:
    """Find this thread's sandbox, creating and seeding it the first time."""
    client = _get_client()
    name = sandbox_name(thread_id)
    try:
        return client.get_sandbox(name)
    except ResourceNotFoundError:
        pass

    try:
        return _create_and_seed(client, name)
    except (ResourceAlreadyExistsError, ResourceNameConflictError):
        # Two runs on the same thread started at once and both missed the get. The
        # loser takes the winner's machine rather than failing the run.
        return client.get_sandbox(name)


async def get_or_create_sandbox_for_thread(thread_id: str) -> LangSmithSandbox:
    """The backend for this thread's coder.

    The SDK's client is synchronous and this is called from an async graph factory,
    so the work goes to a worker thread. `LangSmithSandbox` takes the sync `Sandbox`
    and builds its own async client internally, so nothing else needs to change.
    """
    sandbox = await asyncio.to_thread(_resolve, thread_id)
    return LangSmithSandbox(sandbox=sandbox)
