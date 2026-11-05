#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib.sh
source "$PROJECT_DIR/scripts/lib.sh"
DOCKER_BIN="$(find_docker)"
if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python3)"
elif [[ -x /usr/bin/python3 ]]; then
  PYTHON_BIN=/usr/bin/python3
else
  printf 'Python 3 is required once, to create .env with random credentials.\n' >&2
  exit 1
fi

"$PYTHON_BIN" - "$PROJECT_DIR" <<'PY'
import os
from pathlib import Path
import secrets
import sys

project = Path(sys.argv[1])
notes_root = project / 'notes'
notes_root.mkdir(exist_ok=True)
env_file = project / '.env'
if not env_file.exists():
    content = (project / '.env.example').read_text(encoding='utf-8')
    content = content.replace('CHANGE_ME_POSTGRES_PASSWORD', secrets.token_hex(32))
    content = content.replace('CHANGE_ME_QDRANT_API_KEY', secrets.token_hex(32))
    content = content.replace('CHANGE_ME_NOTES_ROOT', str(notes_root).replace('\\', '\\\\').replace('"', '\\"'))
    descriptor = os.open(env_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
        handle.write(content)
    print('Created private .env with unique local service credentials.')
elif 'CHANGE_ME_' in env_file.read_text(encoding='utf-8'):
    sys.exit('.env still contains template credentials. Set unique values before starting.')
PY

# Where embeddings come from decides whether the Ollama container is needed.
# Parse these values as data; .env is never evaluated by a shell.
#   container: Ollama in Docker on 127.0.0.1:11435 (CPU only on macOS)
#   native:    an Ollama on this machine, such as `brew services start ollama`
#              (on Apple silicon it runs on the GPU)
#   external:  any other embedding service
read -r EMBEDDING_MODE EMBEDDING_MODEL_NAME EMBEDDING_ENDPOINT < <("$PYTHON_BIN" - "$PROJECT_DIR/.env" <<'PY'
from pathlib import Path
from urllib.parse import urlsplit
import sys
import ipaddress
values = {}
for line in Path(sys.argv[1]).read_text(encoding='utf-8').splitlines():
    key, separator, value = line.partition('=')
    key = key.strip().removeprefix('export ').strip()
    if not separator or key.startswith('#'):
        continue
    value = value.strip()
    quote = value[:1]
    if quote in (chr(34), chr(39)) and quote in value[1:]:
        value = value[1:].split(quote, 1)[0]
    else:
        value = value.split(chr(32) + chr(35), 1)[0].strip()
    values[key] = value
# Empty means the default, as in the Kioku configuration.
provider = values.get('EMBEDDING_PROVIDER') or 'ollama'
url = (values.get('EMBEDDING_URL') or 'http://127.0.0.1:11435').rstrip('/')
model = values.get('EMBEDDING_MODEL') or 'nomic-embed-text'
parts = urlsplit(url)
host = (parts.hostname or '').lower()
try:
    loopback = host == 'localhost' or ipaddress.ip_address(host).is_loopback
except ValueError:
    loopback = False
try:
    port = parts.port
except ValueError:
    port = None
if provider != 'ollama' or not loopback:
    mode = 'external'
elif port == 11435:
    mode = 'container'
else:
    mode = 'native'
print(mode, model, url)
PY
)

COMPOSE=("$DOCKER_BIN" compose --project-name "$KIOKU_COMPOSE_PROJECT" --project-directory "$PROJECT_DIR" --env-file "$PROJECT_DIR/.env" -f "$PROJECT_DIR/compose.yaml")
if [[ "$EMBEDDING_MODE" == container ]]; then
  "${COMPOSE[@]}" up -d --wait --wait-timeout 180
  if ! "${COMPOSE[@]}" exec -T ollama ollama show "$EMBEDDING_MODEL_NAME" >/dev/null 2>&1; then
    "${COMPOSE[@]}" exec -T ollama ollama pull "$EMBEDDING_MODEL_NAME"
  fi
else
  "${COMPOSE[@]}" up -d --wait --wait-timeout 180 postgres qdrant
fi

if [[ "$EMBEDDING_MODE" == native ]]; then
  if ! curl -sf --max-time 5 "$EMBEDDING_ENDPOINT/api/version" >/dev/null; then
    printf 'No Ollama answers at %s. Start it first (brew services start ollama, or open Ollama.app), then retry.\n' "$EMBEDDING_ENDPOINT" >&2
    exit 1
  fi
  if command -v ollama >/dev/null 2>&1; then
    if ! OLLAMA_HOST="$EMBEDDING_ENDPOINT" ollama show "$EMBEDDING_MODEL_NAME" >/dev/null 2>&1; then
      OLLAMA_HOST="$EMBEDDING_ENDPOINT" ollama pull "$EMBEDDING_MODEL_NAME"
    fi
  else
    printf 'The ollama command is not on PATH; make sure %s is pulled in that Ollama.\n' "$EMBEDDING_MODEL_NAME" >&2
  fi
  if [[ -n "$("${COMPOSE[@]}" ps --status running --quiet ollama 2>/dev/null)" ]]; then
    printf 'The Docker Ollama is still running but no longer used; stop it with: make stop-docker-ollama\n'
  fi
fi

printf '\nKioku services are ready: PostgreSQL 127.0.0.1:15432, Qdrant 127.0.0.1:16333, embeddings %s (%s).\n' "$EMBEDDING_ENDPOINT" "$EMBEDDING_MODE"
printf 'Next, from %s:\n' "$PROJECT_DIR"
printf '  make install\n'
printf '  ./bin/kioku doctor\n'
printf '  ./bin/kioku ingest --path examples/notes --domain demo\n'
printf '  ./bin/kioku search "Which service replaces the old indexing worker?" --domain demo\n'
