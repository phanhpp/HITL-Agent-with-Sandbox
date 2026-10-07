"""The sandbox file panel: tree, file contents, changed files, and the diff baseline.

The supervisor keeps its files in graph state, so the UI reads those straight from
`stream.values`. The coder's files are on a real machine instead, behind a credential the
browser must never hold — so the agent server reads them and the browser asks it.

All paths are prefixed `/sandbox/{thread_id}`. The query parameter is `filePath`, not
`path`, matching the official deep-agent frontend.

    GET  /tree?filePath=<dir>
         The workspace as a FLAT list; one `find`, pruning .git and node_modules.

    GET  /file?filePath=<f>
         Its contents now. No git, no shell — the SDK's `download_files`.

    GET  /file?filePath=<f>&rev=baseline
         Its contents BEFORE this run:  git show HEAD:<f>

    GET  /changes
         One entry per changed file — status and +/- counts. Three questions in ONE
         shell call (`_changed_files`):

             git diff --numstat HEAD                     modified
             git diff --name-only --diff-filter=D HEAD   deleted
             git ls-files --others --exclude-standard    added, then `wc -l` each,
                                                         since every line is an addition

    POST /baseline
         Fix the "before" for the run about to start:  git add -A && git commit
         --allow-empty. Empty commits allowed so an unchanged workspace still moves
         forward, instead of showing the last run's changes as this run's.

Git is the baseline because a browser can lose a copy on reload and then silently treat
already-edited files as the "before"; it cannot lose a commit. Routes that need it run
`git init` + a commit first, but only when the workspace has no `.git` — a cloned or
mounted repo already has its own HEAD.

Three rules, each load-bearing:

  - `shlex.quote` every path that reaches a shell, or `filePath` can carry a second
    command:  find /workspace/x; cat /etc/passwd  runs two. Quoted, it is one missing
    filename. The official reference interpolates it raw.
  - reject any path outside WORKDIR.
  - never create a sandbox on a GET, or anyone can spend money by guessing thread ids.
"""

import asyncio
import shlex

from langsmith.sandbox import ResourceNotFoundError, SandboxClient
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from agents.sandbox import GIT_IDENTITY, WORKDIR, ensure_git_baseline, sandbox_name
from deepagents.backends import LangSmithSandbox


MAX_FILE_BYTES = 256 * 1024
MAX_TREE_ENTRIES = 500


def _contained(path: str) -> str | None:
    """Return `path` if it is inside WORKDIR, else None.

    `filePath` arrives from the browser, so it is attacker-controlled. The check is
    textual on purpose: there is no local filesystem to resolve against, and the
    sandbox would happily read /etc/shadow if asked.
    """
    # "\x00", not "\\x00". The latter is the four-character sequence, which let a real
    # NUL byte through and rejected the literal text instead — backwards, and it stood
    # until a test was written for it.
    if not path or "\x00" in path:
        return None
    # Reject before normalising, not after: a caller has no legitimate reason to send
    # a relative segment, and accepting one means reasoning about how the remote
    # filesystem resolves it.
    if not path.startswith("/") or ".." in path.split("/"):
        return None
    if path != WORKDIR and not path.startswith(WORKDIR + "/"):
        return None
    return path


_client: SandboxClient | None = None


def _get_client() -> SandboxClient:
    global _client
    if _client is None:
        _client = SandboxClient()
    return _client


def _backend(thread_id: str) -> LangSmithSandbox | None:
    """This thread's sandbox, or None when it has never had one.

    SYNCHRONOUS, so every caller must hand it to a worker thread. `SandboxClient` is the
    sync SDK client, and a blocking socket call inside an async handler stalls the whole
    event loop — `langgraph dev` refuses it outright with a BlockingError, which is how
    this was caught. A Starlette TestClient will not reproduce it.

    Never creates. A GET that boots a machine would let anyone spend money by
    guessing thread ids, and the panel has a perfectly good empty state.
    """
    try:
        return LangSmithSandbox(sandbox=_get_client().get_sandbox(sandbox_name(thread_id)))
    except ResourceNotFoundError:
        return None


async def _tree_entries(backend: LangSmithSandbox, root: str) -> list[dict]:
    """One `find` instead of one `ls` per directory.

    `shlex.quote` is not optional. The official reference interpolates `filePath`
    straight into this command, so `/workspace/x; rm -rf /` would run — the
    containment check above happily accepts it, because textually it is inside the
    workspace.
    """
    # `-prune` on .git and node_modules, not a filter afterwards: the baseline commit
    # puts a .git directory in every workspace, and listing its hooks and objects would
    # bury the project under hundreds of entries nobody wants to browse.
    result = await backend.aexecute(
        f"find {shlex.quote(root)} "
        r"\( -name .git -o -name node_modules \) -prune -o "
        r"-printf '%y\t%s\t%p\n' 2>/dev/null | sort"
    )
    entries: list[dict] = []
    for line in result.output.strip().split("\n"):
        if not line or line.count("\t") != 2:
            continue
        kind, size, path = line.split("\t")
        entries.append(
            {
                "name": path.rsplit("/", 1)[-1],
                "path": path,
                "type": "directory" if kind == "d" else "file",
                "size": int(size) if size.isdigit() else 0,
            }
        )
        if len(entries) >= MAX_TREE_ENTRIES:
            break
    return entries


def _git(backend: LangSmithSandbox, args: str) -> str:
    """Run one git command in the workspace and return its output.

    Git is the record of how the workspace started, so the browser never has to
    remember it. See `ensure_git_baseline` for why that matters.
    """
    return backend.execute(f"cd {shlex.quote(WORKDIR)} && git {args} 2>/dev/null").output


def _changed_files(backend: LangSmithSandbox) -> list[dict]:
    """Every file that differs from the baseline commit, with its line counts.

    ONE shell invocation, not one per question. Each `execute` is a round trip to the
    machine costing about a second, and this used to ask five of them — baseline check,
    numstat, untracked list, a diff per untracked file, then deleted names. Coming back
    to the page took five seconds before the changed-files panel appeared.

    Untracked files are counted with `wc -l` rather than `git diff --no-index`, because
    every line of a new file is an addition and that needs no diff at all.
    """
    script = (
        f"cd {shlex.quote(WORKDIR)} || exit 0; "
        "if [ ! -d .git ]; then "
        f"  git init -q && {GIT_IDENTITY} && "
        "  git add -A && git commit -q -m 'baseline: workspace as seeded'; "
        "fi; "
        "echo '<<<modified>>>'; git diff --numstat HEAD 2>/dev/null; "
        "echo '<<<deleted>>>'; git diff --name-only --diff-filter=D HEAD 2>/dev/null; "
        "echo '<<<added>>>'; "
        "git ls-files --others --exclude-standard 2>/dev/null | "
        '  while IFS= read -r f; do printf "%s\t%s\n" "$(wc -l < "$f" 2>/dev/null)" "$f"; done'
    )
    out = backend.execute(script).output

    sections: dict[str, list[str]] = {"modified": [], "deleted": [], "added": []}
    current = None
    for line in out.splitlines():
        marker = line.strip()
        if marker in ("<<<modified>>>", "<<<deleted>>>", "<<<added>>>"):
            current = marker.strip("<>")
            continue
        if current and line.strip():
            sections[current].append(line)

    entries: dict[str, dict] = {}

    for line in sections["modified"]:
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        added, removed, rel = parts
        entries[rel] = {
            "path": f"{WORKDIR}/{rel}",
            "additions": int(added) if added.isdigit() else 0,
            "deletions": int(removed) if removed.isdigit() else 0,
            "status": "modified",
        }

    for line in sections["added"]:
        count, _, rel = line.partition("\t")
        if not rel:
            continue
        entries[rel] = {
            "path": f"{WORKDIR}/{rel}",
            "additions": int(count.strip()) if count.strip().isdigit() else 0,
            "deletions": 0,
            "status": "added",
        }

    for rel in sections["deleted"]:
        if rel in entries:
            entries[rel]["status"] = "deleted"

    return sorted(entries.values(), key=lambda e: e["path"])


async def changes(request: Request) -> JSONResponse:
    """What the agent has changed since the workspace was baselined.

    One entry per file: its path, whether it was modified, added or deleted, and its
    line counts. This is what fills the "Changed" panel and puts the dots on the tree.
    """
    backend = await asyncio.to_thread(_backend, request.path_params["thread_id"])
    if backend is None:
        return JSONResponse({"files": []})
    return JSONResponse({"files": await asyncio.to_thread(_changed_files, backend)})


async def baseline(request: Request) -> JSONResponse:
    """Mark the workspace as it stands now: this is the "before" for the next run.

    Called when the user sends a message. Committing rather than remembering is the
    point — a reload cannot lose a commit.
    """
    backend = await asyncio.to_thread(_backend, request.path_params["thread_id"])
    if backend is None:
        return JSONResponse({"ok": False, "reason": "no sandbox for this thread"})

    def commit() -> str:
        ensure_git_baseline(backend)
        _git(backend, "add -A")
        # --allow-empty so an unchanged workspace still moves the baseline forward,
        # rather than leaving the previous run's changes showing as this run's.
        _git(backend, "-c user.email=agent@sandbox.local -c user.name=Sandbox "
                      "commit -q --allow-empty -m 'baseline: before agent run'")
        return _git(backend, "rev-parse HEAD").strip()

    return JSONResponse({"ok": True, "head": await asyncio.to_thread(commit)})


async def tree(request: Request) -> JSONResponse:
    """The workspace as a flat list of entries, for the file tree.

    Flat on purpose: the nesting is cheap to build in the browser and awkward to
    serialise. A thread with no sandbox gets an empty list rather than an error, because
    most conversations never ask for code.
    """
    thread_id = request.path_params["thread_id"]
    path = _contained(request.query_params.get("filePath") or WORKDIR)
    if path is None:
        return JSONResponse({"error": "filePath outside the workspace"}, status_code=400)

    backend = await asyncio.to_thread(_backend, thread_id)
    if backend is None:
        # Not an error: most threads never ask for code, so they have no machine.
        return JSONResponse({"path": path, "entries": [], "sandboxId": None})

    entries = await _tree_entries(backend, path)
    return JSONResponse({"path": path, "entries": entries, "sandboxId": backend.id})


async def file(request: Request) -> JSONResponse:
    """One file's contents — now, or as it was before this run.

    `?rev=baseline` returns the version at the baseline commit, which is the left-hand
    side of the diff. Without it you get the file as it stands.
    """
    thread_id = request.path_params["thread_id"]
    path = _contained(request.query_params.get("filePath") or "")
    if path is None:
        return JSONResponse({"error": "filePath outside the workspace"}, status_code=400)

    backend = await asyncio.to_thread(_backend, thread_id)
    if backend is None:
        return JSONResponse({"error": "no sandbox for this thread"}, status_code=404)

    if request.query_params.get("rev") == "baseline":
        # The file as it was before the agent touched it. A deleted or newly created
        # file legitimately has no baseline content, so empty is an answer, not an error.
        rel = path[len(WORKDIR) + 1 :]
        before = await asyncio.to_thread(_git, backend, f"show HEAD:{shlex.quote(rel)}")
        return JSONResponse({"path": path, "content": before})

    # `download_files` returns raw bytes. `read()` would also work but is line
    # paginated and splices a truncation notice into the content, which a file
    # viewer would then display as if it were part of the file.
    results = await backend.adownload_files([path])
    if not results:
        return JSONResponse({"error": "not found"}, status_code=404)

    content = results[0].content
    if len(content) > MAX_FILE_BYTES:
        return JSONResponse({"error": "file too large to preview"}, status_code=413)

    return JSONResponse({"path": path, "content": content.decode("utf-8", errors="replace")})


# The metric name, fixed here rather than taken from the request. A browser-chosen key
# would let anyone write arbitrary metric names into the workspace.


routes = [
    Route("/sandbox/{thread_id}/tree", tree),
    Route("/sandbox/{thread_id}/file", file),
    Route("/sandbox/{thread_id}/changes", changes),
    Route("/sandbox/{thread_id}/baseline", baseline, methods=["POST"]),
]
