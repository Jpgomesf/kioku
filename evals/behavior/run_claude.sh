#!/usr/bin/env bash
# Run every behavior scenario TRIALS times through Claude Code in headless mode,
# then score the server trace. Each trial is a fresh session and server process.
#
# usage: evals/behavior/run_claude.sh TEST_ENV_FILE OUT_DIR [TRIALS] [MODEL]
#
# TEST_ENV_FILE must point at test storage: scenarios write memories. This
# spends Claude usage (about 6 scenarios x TRIALS sessions); --max-budget-usd
# caps each session.
set -euo pipefail

ENV_FILE="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
OUT="$2"
TRIALS="${3:-5}"
MODEL="${4:-opus}"
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN="$ROOT/target/release/kioku"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
TRACE="$OUT/trace.jsonl"
: > "$OUT/answers.jsonl"

cargo build --release --locked --manifest-path "$ROOT/Cargo.toml"
"$BIN" --env-file "$ENV_FILE" ingest --path "$ROOT/evals/retrieval/corpus" --domain tidewater > /dev/null
"$BIN" --env-file "$ENV_FILE" ingest --path "$ROOT/evals/behavior/seed" --domain tidewater > /dev/null

python3 - "$ROOT/evals/behavior/scenarios.json" > "$OUT/scenarios.tsv" <<'PY'
import json, sys
for s in json.load(open(sys.argv[1]))["scenarios"]:
    print(s["id"] + "\t" + s["prompt"])
PY

for trial in $(seq 1 "$TRIALS"); do
  while IFS=$'\t' read -r id prompt; do
    run="$id/$trial"
    config="$OUT/mcp-$id-$trial.json"
    python3 - "$BIN" "$ENV_FILE" "$TRACE" "$run" > "$config" <<'PY'
import json, sys
binary, env_file, trace, run = sys.argv[1:5]
print(json.dumps({"mcpServers": {"kioku": {
    "command": binary, "args": ["--env-file", env_file, "serve"],
    "env": {"MEMORY_TRACE_FILE": trace, "MEMORY_TRACE_RUN": run, "MEMORY_TOOLS": "core"}}}}))
PY
    claude -p "$prompt" \
      --mcp-config "$config" --strict-mcp-config \
      --allowedTools "mcp__kioku__memory_search,mcp__kioku__memory_get,mcp__kioku__memory_save" \
      --permission-mode dontAsk --max-turns 15 --max-budget-usd 1 \
      --model "$MODEL" --output-format json > "$OUT/$id-$trial.json" || true
    python3 - "$OUT/$id-$trial.json" "$run" >> "$OUT/answers.jsonl" <<'PY'
import json, sys
try:
    answer = json.load(open(sys.argv[1])).get("result", "")
except ValueError:
    answer = ""
print(json.dumps({"run": sys.argv[2], "answer": answer}))
PY
  done < "$OUT/scenarios.tsv"
done

python3 "$ROOT/evals/behavior/check_trace.py" "$TRACE" --answers "$OUT/answers.jsonl"
