#!/usr/bin/env bash
# Measure the over-validation fix: run the SAME headless task with and without
# dsh-benign-exit, and compare wall time + request/token counts.
#
# Requires:
#   - DeepSeek Harness CLI (`dsh`) working in headless mode, with an API key
#     configured (the key's usage dashboard gives exact cost numbers).
#   - The plugin installed into a profile that headless runs can use.
#
# Usage:
#   DSH_TASK="find TODO comments in src and fix them" \
#   DSH_PROFILE_BASELINE=headless \
#   DSH_PROFILE_FIXED=headless-benign-exit \
#   bash scripts/measure-before-after.sh [runs]
#
# NOTE: exact cost must be read from your provider's usage dashboard (request
# counts and tokens are reported here; we deliberately don't guess $/token).

set -euo pipefail

TASK="${DSH_TASK:-list all *.py files under this repo, count them, and report the number}"
PROFILE_BASELINE="${DSH_PROFILE_BASELINE:-headless}"
PROFILE_FIXED="${DSH_PROFILE_FIXED:-headless-benign-exit}"
RUNS="${1:-3}"

log() { printf '\n== %s\n' "$*"; }

run_one() {
  local profile="$1" i="$2"
  local start end wall
  start=$(python3 -c 'import time; print(time.time())')
  dsh --profile "$profile" "$TASK" >/tmp/dsh-mb.out 2>&1 || true
  end=$(python3 -c 'import time; print(time.time())')
  wall=$(python3 -c "print(f'{$end-$start:.1f}')")
  local reqs tokens
  # Session JSONL lives under $DSH_HOME (default ~/.dsh); count model requests
  # and input/output tokens from the most recent session file.
  reqs=$(find "${DSH_HOME:-$HOME/.dsh}" -name '*.jsonl' -newermt '-10 minutes' -type f 2>/dev/null \
    | head -1 | xargs -I{} sh -c 'wc -l < "{}"' 2>/dev/null || echo "?")
  tokens="?"  # fill from your provider dashboard
  printf '%-22s run %d: wall=%ss requests=%s tokens=%s\n' "$profile" "$i" "$wall" "$reqs" "$tokens"
}

log "Task: $TASK"
log "Baseline profile ($PROFILE_BASELINE) — plugin OFF"
for i in $(seq 1 "$RUNS"); do run_one "$PROFILE_BASELINE" "$i"; done
log "Fixed profile ($PROFILE_FIXED) — plugin ON"
for i in $(seq 1 "$RUNS"); do run_one "$PROFILE_FIXED" "$i"; done

cat <<'EOF'

Interpretation
--------------
- Fewer requests + lower wall time on the fixed profile = less over-validation.
- Read exact cost / token totals from your provider's usage dashboard.
- Use tasks that NATURALLY hit benign exit 1 (grep/rg/git-diff), e.g.:
  "search for 'FIXME' in src and report where it appears (there are some)"
  The more greps a task needs, the larger the delta.
EOF
