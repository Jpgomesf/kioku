#!/usr/bin/env bash
# Start the Kioku MCP server over stdio with this checkout's .env. MCP clients
# run this script; extra arguments go to `kioku serve`, for example --tools all.
# Diagnostics go to stderr: stdout carries only MCP messages.
set -euo pipefail
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
MCP_BIN="${KIOKU_BIN:-$PROJECT_DIR/bin/kioku}"
if [[ ! -x "$MCP_BIN" ]]; then
  printf 'Kioku is not installed at %s. Run "make install" in %s first.\n' "$MCP_BIN" "$PROJECT_DIR" >&2
  exit 1
fi
if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  printf 'Run "make start" in %s first to create .env and start the services.\n' "$PROJECT_DIR" >&2
  exit 1
fi
exec "$MCP_BIN" --env-file "$PROJECT_DIR/.env" serve "$@"
