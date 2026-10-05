"""Extra HTTP routes served alongside the graphs — the mount point, nothing more.

Registered as `"http": {"app": "./http_app.py:app"}` in `langgraph.json`, which ships
them in the same image as the graphs. That config takes ONE app, not a list, so every
custom route has to hang off this single Starlette object — but only the object is
constrained, not the layout, so the routes themselves live in `routes/`.

Two unrelated jobs, hence two modules:

    routes/sandbox_files.py   the coder's machine: tree, file, changes, baseline
    routes/feedback.py        thumbs up/down, written to LangSmith

Both exist for the same underlying reason: they need a credential the browser must never
hold, so the agent server does the work and the browser asks it. They share nothing else
— different client, different API, different concepts.

Starlette rather than FastAPI because `langgraph-api` already ships it, so this adds
nothing to the image; FastAPI would buy validation these routes do not need. It is still
declared in `pyproject.toml`: arriving only because the server happens to depend on it
is not the same as being a dependency, and `uv sync --no-dev` is where that shows.
"""

from starlette.applications import Starlette

from routes import feedback, sandbox_files

app = Starlette(routes=[*sandbox_files.routes, *feedback.routes])
