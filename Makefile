# Root of this repo (handles paths with spaces).
ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
VENV := $(ROOT)/.venv/bin/python

.PHONY: install dev dev-agent dev-frontend

# Creates .venv on first run (needs Python 3.11+ on PATH or via Homebrew python@3.12), then installs deps.
install:
	@set -e; cd "$(ROOT)"; \
	if [ ! -x "$(VENV)" ]; then \
	  FOUND=""; \
	  for c in python3.12 python3.11; do \
	    if command -v $$c >/dev/null 2>&1 && $$c -c "import sys; sys.exit(0 if sys.version_info>=(3,11) else 1)" 2>/dev/null; then \
	      FOUND=$$(command -v $$c); break; \
	    fi; \
	  done; \
	  if [ -z "$$FOUND" ] && command -v brew >/dev/null 2>&1; then \
	    B=$$(brew --prefix python@3.12 2>/dev/null)/bin/python3.12; \
	    [ -x "$$B" ] && FOUND=$$B; \
	  fi; \
	  if [ -z "$$FOUND" ]; then \
	    echo "Need Python 3.11 or newer. Install e.g.: brew install python@3.12" >&2; \
	    exit 1; \
	  fi; \
	  "$$FOUND" -m venv .venv; \
	fi; \
	"$(VENV)" -c "import sys; sys.exit(0 if sys.version_info>=(3,11) else 1)" || { \
	  echo "Your .venv is too old. Fix: rm -rf .venv && make install" >&2; \
	  exit 1; \
	}; \
	"$(VENV)" -m pip install -r packages/agent/requirements.txt; \
	cd packages/frontend && pnpm install

dev:
	@test -x "$(VENV)" || { echo "Run make install first." >&2; exit 1; }
	$(MAKE) -j2 dev-agent dev-frontend

dev-agent:
	cd "$(ROOT)/packages/agent" && "$(VENV)" -m langgraph_cli dev --host 0.0.0.0 --port 2024 --no-browser

dev-frontend:
	cd "$(ROOT)/packages/frontend" && pnpm run dev
