#!/usr/bin/env bash
# Reproducible before/after experiment driver.
#
# Requires (all via env, never hardcoded):
#   DEEPSEEK_API_KEY        your DeepSeek key
#   DSH_BEFORE_HOME         DSH_HOME for the baseline profile (no plugin)
#   DSH_AFTER_HOME          DSH_HOME for the fixed profile (with dsh-benign-exit)
#   DSH_REPO                path to a DeepSeek Harness source checkout (working dir)
#   DSH_BIN                 the dsh CLI entry (e.g. <repo>/apps/cli/lib/bin.js)
#   DSH_RESULTS_DIR         output dir for stat files
#   DSH_TASKS_FILE          one task per line; blank/comment lines skipped
#
# Each run produces: <results>/<env>_<taskN>_<round>.jsonl  (per-step usage)
# and appends a wall-time line to <results>/timings.tsv.
set -euo pipefail

: "${DEEPSEEK_API_KEY:?set it}"; : "${DSH_BEFORE_HOME:?}"; : "${DSH_AFTER_HOME:?}"
: "${DSH_REPO:?}"; : "${DSH_BIN:?}"; : "${DSH_RESULTS_DIR:?}"; : "${DSH_TASKS_FILE:?}"
mkdir -p "$DSH_RESULTS_DIR"
: > "$DSH_RESULTS_DIR/timings.tsv"
ROUNDS="${DSH_ROUNDS:-2}"

# Read tasks (one per line; strip comments; skip blanks) — bash 3.2 safe.
FILTERED=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%#*}"
  [ -n "$line" ] && FILTERED+=("$line")
done < "$DSH_TASKS_FILE"

run_one() {
  local env="$1" home="$2" task="$3" n="$4" round="$5"
  local stat_file="$DSH_RESULTS_DIR/${env}_${n}_${round}.jsonl"
  local start end wall
  start=$(python3 -c 'import time; print(time.time())')
  DSH_HOME="$home" DSH_EXP_STAT_FILE="$stat_file" \
    node "$DSH_BIN" --profile headless "$task" > "$DSH_RESULTS_DIR/${env}_${n}_${round}.out.txt" 2>&1
  end=$(python3 -c 'import time; print(time.time())')
  wall=$(python3 -c "print(f'{$end-$start:.1f}')")
  printf '%s\t%s\t%s\t%s\n' "$env" "$n" "$round" "$wall" >> "$DSH_RESULTS_DIR/timings.tsv"
}

cd "$DSH_REPO"
for n in "${!FILTERED[@]}"; do
  task="${FILTERED[$n]}"
  for round in $(seq 1 "$ROUNDS"); do
    run_one before "$DSH_BEFORE_HOME" "$task" "$n" "$round"
    run_one after  "$DSH_AFTER_HOME"  "$task" "$n" "$round"
  done
done
echo "done → $DSH_RESULTS_DIR"
