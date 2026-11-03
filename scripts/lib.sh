#!/usr/bin/env bash
# Shared by start.sh and stop.sh.
# The Compose project name owns the data volumes: never rename it.
# shellcheck disable=SC2034 # used by the scripts that source this file
KIOKU_COMPOSE_PROJECT=local-memory

find_docker() {
  if [[ -d /Applications/Docker.app/Contents/Resources/bin ]]; then
    PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
    export PATH
  fi
  if ! command -v docker >/dev/null 2>&1; then
    printf 'Docker is required. Install Docker Desktop (or Docker Engine with Compose), start it, and retry.\n' >&2
    exit 1
  fi
  command -v docker
}
