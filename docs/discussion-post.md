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
   (benign: no matching lines — expected, not a failure)
   [exit code: 1]
   ```

   The marker itself is untouched, so the harness UI exit pill keeps showing `1`.

2. **Prompt layer.** A small system-prompt section teaches the benign exit vocabulary (`grep` 1 = no match, `git diff --exit-code` 1 = differences, `test` 1 = condition false, `which` 1 = not found, `jq -e` 1 = false/null, …).

## Honest scope

- **Proven:** the mechanism changes what the model sees, verified against the real harness machinery — 36 unit tests, 10 integration tests in the real `tools/post-execute` pipeline, 6 e2e tests with the real bash tool (real `grep`/`git` subprocesses), including a `parseExitStatus` round-trip (exit pill stays `1`). Install path verified via `dsh plugin add` + boot.
- **Not proven:** no live-LLM ablation yet, so no cost/time impact claim. If you run one, [scripts/measure-before-after.sh](scripts/measure-before-after.sh) does the on/off comparison.
- **Conservative:** only simple foreground commands with documented benign exits are annotated. Compound commands, background `job_output`, terminal channels, and real errors (grep exit 2) are untouched — a real failure is never masked.

## Install

```bash
dsh plugin --profile web add dsh-benign-exit   # once published
# or from source: clone → pnpm install → dsh plugin --profile web add .
```

Tested against `0.1.0-rc.5` (2026-08-17). MIT.

Would love feedback on the benign table — which commands do you see over-investigated most in practice?
