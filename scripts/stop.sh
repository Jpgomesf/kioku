#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -d /Applications/Docker.app/Contents/Resources/bin ]]; then
  export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
fi
if command -v docker >/dev/null 2>&1; then
  DOCKER_BIN="$(command -v docker)"
elif [[ -x /Applications/Docker.app/Contents/Resources/bin/docker ]]; then
  DOCKER_BIN=/Applications/Docker.app/Contents/Resources/bin/docker
else
  printf 'Docker was not found.\n' >&2
  exit 1
fi
if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  printf 'No .env found; this project has not been initialized.\n' >&2
  exit 1
fi
"$DOCKER_BIN" compose --project-name local-memory --project-directory "$PROJECT_DIR" --env-file "$PROJECT_DIR/.env" -f "$PROJECT_DIR/compose.yaml" stop
printf 'Services stopped. All persistent volumes are retained.\n'
