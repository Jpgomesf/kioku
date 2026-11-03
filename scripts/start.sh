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

COMPOSE=("$DOCKER_BIN" compose --project-name "$KIOKU_COMPOSE_PROJECT" --project-directory "$PROJECT_DIR" --env-file "$PROJECT_DIR/.env" -f "$PROJECT_DIR/compose.yaml")
"${COMPOSE[@]}" up -d --wait --wait-timeout 180

# Parse this one value as data; .env is never evaluated by a shell.
EMBEDDING_MODEL_NAME="$("$PYTHON_BIN" - "$PROJECT_DIR/.env" <<'PY'
from pathlib import Path
import sys
values = {}
for line in Path(sys.argv[1]).read_text(encoding='utf-8').splitlines():
    key, separator, value = line.partition('=')
    if separator and not key.lstrip().startswith('#'):
        values[key.strip()] = value.strip().strip('"').strip("'")
if values.get('EMBEDDING_PROVIDER', 'ollama') == 'ollama' and values.get('EMBEDDING_URL', '').rstrip('/') == 'http://127.0.0.1:11435':
    print(values.get('EMBEDDING_MODEL', 'nomic-embed-text'))
PY
)"
if [[ -n "$EMBEDDING_MODEL_NAME" ]]; then
  if ! "${COMPOSE[@]}" exec -T ollama ollama show "$EMBEDDING_MODEL_NAME" >/dev/null 2>&1; then
    "${COMPOSE[@]}" exec -T ollama ollama pull "$EMBEDDING_MODEL_NAME"
  fi
fi

printf '\nKioku services are ready: PostgreSQL 127.0.0.1:15432, Qdrant 127.0.0.1:16333, embeddings 127.0.0.1:11435.\n'
printf 'Next, from %s:\n' "$PROJECT_DIR"
printf '  make install\n'
printf '  ./bin/kioku doctor\n'
printf '  ./bin/kioku ingest --path examples/notes --domain demo\n'
printf '  ./bin/kioku search "Which service replaces the old indexing worker?" --domain demo\n'
