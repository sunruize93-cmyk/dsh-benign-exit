# dsh-benign-exit: stop the "grep found nothing → investigate forever" loop

**Category: Show your plugins**

The bash tool's system prompt tells every agent:

> *"Check the `[exit code: N]` marker on every bash result; investigate failures before moving on."* (`tool-bash/src/index.ts:236`)

`grep`/`rg` exit **1 when they find nothing** — that's the answer, not a failure. But the standing instruction primes models to read any non-zero exit as "something broke, investigate", so a no-match `grep` can trigger re-checking loops that burn requests and tokens on a perfectly normal result.

## What the plugin does

Two layers, both model-facing:

1. **Result layer (deterministic).** A `tools/post-execute` hook rewrites bash/pwsh results *only* when the structured value confirms a real non-zero exit (no signal kill, no timeout, no abort). A real no-match `grep` then renders as:

   ```
   (no output)
   (exit 1 = no matching lines — the command's documented meaning)
   [exit code: 1]
   ```

   The marker itself is untouched, so the harness UI exit pill keeps showing `1`.

2. **Prompt layer.** A small system-prompt section teaches the benign exit vocabulary (`grep` 1 = no match, `git diff --exit-code` 1 = differences, `test` 1 = condition false, `which` 1 = not found, `jq -e` 1 = false/null, …).

## Honest scope

- **Proven:** the mechanism changes what the model sees, verified against the real harness machinery — 36 unit tests, 10 integration tests in the real `tools/post-execute` pipeline, 6 e2e tests with the real bash tool (real `grep`/`git` subprocesses), including a `parseExitStatus` round-trip (exit pill stays `1`). Install path verified via `dsh plugin add` + boot. A live before/after experiment (4 tasks × 3 rounds, `deepseek-v4-flash`) showed a pooled −20% billed input — but read the report's honest caveats (per-run typical ~+3%, one task carried the win, task set engineered toward the mechanism).
- **Conservative:** only simple foreground commands with documented benign exits are annotated — no wrappers (`sudo`/`env`/`sh -c`), no redirections, no compounds, no background/terminal channels. A wrapper or redirect failure settles on exit 1 and is deliberately never attributed to the tool. Real errors (grep exit 2) are untouched. Reproduce with [scripts/run-before-after.sh](scripts/run-before-after.sh) + [scripts/analyze-results.py](scripts/analyze-results.py).

## Install

```bash
dsh plugin --profile web add dsh-benign-exit   # once published
# or from source: clone → pnpm install → dsh plugin --profile web add .
```

Tested against `0.1.0-rc.5` (2026-08-17). MIT.

Would love feedback on the benign table — which commands do you see over-investigated most in practice?
