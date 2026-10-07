# Root of this repo (handles paths with spaces).
ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
# packages/agent is a uv project, so its venv lives beside its pyproject.toml.
VENV := $(ROOT)/packages/agent/.venv/bin/python

.PHONY: install dev dev-web dev-agent dev-frontend dev-next typecheck test test-agent test-web test-e2e

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

# Unit tests only: no browser, no agent server, no API key, no model calls. Anything
# needing a real sandbox or a real model stays the manual checklist in docs/TESTING.md.
test: test-agent test-web

test-agent:
	cd "$(ROOT)/packages/agent" && uv run --group test pytest -q

test-web:
	cd "$(ROOT)/packages/web" && pnpm run test

# Browser tests against a FAKE agent — no agent process, no API key, no model calls.
# Not part of `make test`: it builds the app and drives a browser, so it is minutes
# rather than seconds.
test-e2e:
	cd "$(ROOT)/packages/web" && pnpm run test:e2e
