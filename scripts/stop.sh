#!/usr/bin/env bash
# Stop Kioku's services, or only the ones named (for example: ollama).
# Volumes, and therefore memories, are kept.
set -euo pipefail
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib.sh
source "$PROJECT_DIR/scripts/lib.sh"
DOCKER_BIN="$(find_docker)"
if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  printf 'No .env found; this checkout has not been started yet.\n' >&2
  exit 1
fi
"$DOCKER_BIN" compose --project-name "$KIOKU_COMPOSE_PROJECT" --project-directory "$PROJECT_DIR" \
  --env-file "$PROJECT_DIR/.env" -f "$PROJECT_DIR/compose.yaml" stop "$@"
printf 'Services stopped. All volumes are kept.\n'
