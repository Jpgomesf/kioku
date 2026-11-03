#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
MCP_BIN="$PROJECT_DIR/bin/local-memory-mcp"
if [[ ! -x "$MCP_BIN" ]]; then
  printf 'Build local-memory-mcp and install its binary into %s/bin first. See README.md.\n' "$PROJECT_DIR" >&2
  exit 1
fi
if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  printf 'Run %s/scripts/start.sh first to create .env and start the services.\n' "$PROJECT_DIR" >&2
  exit 1
fi
exec "$MCP_BIN" --env-file "$PROJECT_DIR/.env" serve
