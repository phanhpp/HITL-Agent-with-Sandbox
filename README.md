# human-in-the-loop — LangChain Pattern

This is a standalone **React** + **Python** project for the **human-in-the-loop** LangChain UI pattern.

The repo layout uses a **Makefile** at the project root (no root `package.json`). The only `package.json` is under `packages/frontend` for the Vite app; the agent is Python under `packages/agent`.

The agent server is started with the **Python LangGraph CLI** (`.venv/bin/python -m langgraph_cli dev` via the Makefile), not the Node/npm CLI. `requirements.txt` includes `langgraph-cli[inmem]` so the in-memory dev server from the [local server](https://docs.langchain.com/oss/python/langgraph/local-server) guide is available after `pip install` into the project `.venv`. `make install` creates `.venv` at the repo root (using `python3.12` or `python3.11` on your `PATH`, or Homebrew `python@3.12` when available) and installs dependencies; paths with spaces in the project directory are supported.

## Prerequisites

- Node.js 22+
- [pnpm](https://pnpm.io/) (`npm install -g pnpm`)
- An [Anthropic API key](https://console.anthropic.com/)
- A **Python 3.11+** interpreter discoverable as `python3.12` / `python3.11` or via Homebrew `python@3.12` (required by `langgraph-cli[inmem]`; macOS `/usr/bin/python3` is often too old — install [Homebrew](https://brew.sh/) Python if needed)
- [GNU Make](https://www.gnu.org/software/make/)

If `make install` fails to find a suitable Python, install 3.11+ and ensure `python3.12` is on your `PATH`, or install `python@3.12` via Homebrew. If the wrong Python was used to create `.venv`, run `rm -rf .venv && make install`.

### Node version

Every `make` command that touches the frontend (`install`, `dev`, `dev-frontend`) uses whichever `node` your terminal finds first. With Node older than 22, `pnpm` fails (e.g. `TypeError: URL.canParse is not a function`).

Check with `node -v`. If you use [nvm](https://github.com/nvm-sh/nvm), run this in the repo root **in each new terminal** before `make` (it reads the version from `.nvmrc`):

```bash
nvm use
```

To stop needing this, make sure nvm is loaded **last** in your `~/.zshrc`: if a line after it prepends `/usr/local/bin` or `/opt/homebrew/bin` to `PATH`, an older system Node wins and `nvm alias default` has no effect.

## Setup

1. Copy the environment file and add your API key:
  ```bash
   cp .env.example packages/agent/.env
   # Edit packages/agent/.env and add your ANTHROPIC_API_KEY
  ```
2. Install Python and frontend dependencies:
  ```bash
   make install
  ```



## Running

```bash
make dev
```

This starts both the LangGraph agent server (port 2024) and the Vite frontend (port 4100).

The Vite dev server proxies `/api/langgraph` to `http://127.0.0.1:2024`, and the app uses that same-origin URL for the LangGraph SDK (no browser CORS issues in local dev).

Open [http://localhost:4100](http://localhost:4100) in your browser.

To run the two parts in separate terminals instead:

```bash
make dev-agent      # LangGraph agent server on port 2024
make dev-frontend   # Vite frontend on port 4100
```

Stop either with `Ctrl+C`.