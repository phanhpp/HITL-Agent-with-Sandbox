# Root of this repo (handles paths with spaces).
ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
# packages/agent is a uv project, so its venv lives beside its pyproject.toml.
VENV := $(ROOT)/packages/agent/.venv/bin/python

.PHONY: install dev dev-web dev-agent dev-frontend dev-next typecheck

# Installs the agent (uv, from uv.lock) and both frontends.
install:
	@command -v uv >/dev/null 2>&1 || { \
	  echo "uv is required: https://docs.astral.sh/uv/getting-started/installation/" >&2; \
	  exit 1; \
	}
	cd "$(ROOT)/packages/agent" && uv sync
	cd "$(ROOT)/packages/frontend" && pnpm install
	cd "$(ROOT)/packages/web" && pnpm install

# Agent + Vite frontend (port 4100), unchanged.
dev:
	@test -x "$(VENV)" || { echo "Run make install first." >&2; exit 1; }
	$(MAKE) -j2 dev-agent dev-frontend

# Agent + Next.js app (port 4200).
dev-next:
	@test -x "$(VENV)" || { echo "Run make install first." >&2; exit 1; }
	$(MAKE) -j2 dev-agent dev-web

dev-agent:
	cd "$(ROOT)/packages/agent" && "$(VENV)" -m langgraph_cli dev --host 0.0.0.0 --port 2024 --no-browser

dev-frontend:
	cd "$(ROOT)/packages/frontend" && pnpm run dev

dev-web:
	cd "$(ROOT)/packages/web" && pnpm run dev

typecheck:
	cd "$(ROOT)/packages/web" && pnpm run typecheck
