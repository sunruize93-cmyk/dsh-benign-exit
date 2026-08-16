# dsh-benign-exit

**English** | [简体中文](README.zh.md)

Deterministically annotate benign non-zero bash/pwsh exit codes in DeepSeek Harness so models can stop **over-investigating normal results**.

`grep` exits `1` when nothing matches — that is normal, not a failure. But DeepSeek Harness's bash tool tells the model:

> "Check the `[exit code: N]` marker on every bash result; **investigate failures before moving on**."

A model that runs `grep` and finds nothing sees `[exit code: 1]`, may read the standing instruction as "this failed, investigate", and can re-check a perfectly normal result — burning requests and tokens.

This plugin makes the exit code **self-describing** at the layer the model actually sees: when the leading command is a known tool and the exit code is a documented benign outcome, the model-facing result is annotated so the model sees *why* the exit is normal.

> **Scope of this claim.** The plugin provably changes what the model sees for benign outcomes (verified against the real harness machinery below). A live before/after experiment found a **pooled −20% billed input tokens** on an engineered 4-task set (see below) — but the per-run typical effect is small (~+3%), and the win concentrates in shell-heavy re-verification tasks. Read the full honest breakdown in the experiment section.

## How it works

Two layers:

1. **Result layer (deterministic).** A `tools/post-execute` hook rewrites the model-facing content of `bash` / `pwsh` results, but only when the structured result confirms a real non-zero exit (no signal kill, no timeout, no abort). For example, a real `grep` run that found nothing renders as:

   ```
   (no output)
   (exit 1 = no matching lines — the command's documented meaning)
   [exit code: 1]
   ```

   The model sees the exit marked as expected — a change to what the model *sees*, independent of model mood or prompt wording.

2. **Prompt layer (reinforcement).** A small system-prompt section teaches the benign exit-code vocabulary, so the standing "investigate failures" guidance is read correctly. (The harness's own instruction is not removed; this is a corrective note, not a replacement.)

## What counts as benign

The built-in table only covers **documented** normal outcomes:

| Command | Exit | Meaning |
|---|---|---|
| `grep`, `egrep`, `fgrep`, `rg`, `ack` | 1 | no matching lines |
| `diff`, `cmp`, `comm` | 1 | inputs differ |
| `test`, `[` | 1 | condition is false |
| `which`, `type` | 1 | not found (informational) |
| `jq -e` | 1 | filter evaluated to false or null |
| `git grep` | 1 | no matching lines |
| `git diff --exit-code` / `--quiet` | 1 | differences exist |
| `git diff-index --exit-code` | 1 | differences exist |

The annotation is inserted as a line **above** the real `[exit code: N]` marker — the marker text itself is never rewritten, because the harness's `parseExitStatus` (used by the UI terminal card) requires the marker to stay the literal final line.

## Coverage and limits (read this before judging)

**Conservative by design.** The plugin only annotates a *single, simple, foreground* command whose leading program is a known tool and whose exit code is a documented benign outcome. Deliberately NOT covered:

- **Compound commands** (`grep -q p f && echo yes`, `grep x | head`, `if grep ...; then`, `$(...)`, subshells): the reported exit code is ambiguous there, so they pass through untouched.
- **Background jobs**: `job_output` renders a different format (`[status: completed, exit code: 1]`) via a different tool; not annotated.
- **Terminal channels** (`terminal_send` / `terminal_read`): a different marker format (`exited code=N`); not annotated.
- **Explicit paths** (`./script.sh`): never treated as a known tool.
- **Wrappers** (`sudo`, `env`, `nice`, `nohup`, `timeout`, `sh -c`, `command`, leading env-assignments) and **any redirection** (`>`, `<`, `2>&1`, heredocs): rejected outright — a wrapper or redirect failure settles on exit 1 and must not be attributed to the tool.
- **Real failures** (`grep` exit 2, any unknown command, any exit not in the table): untouched. The built-in table is authoritative — user extra rules can never mask a real failure for a built-in command.
- **Semantic limit:** for `test`/`[`/`which`/`type`/`diff`, exit 1 is the tool's *documented* meaning, but it can still be **task-relevant** (e.g. `test -f /critical/file` missing is the answer). The annotation wording therefore says "report it, don't re-investigate" rather than "this is fine" — the model is told to report the outcome, just not to treat the command as broken. If you need `test`/`which` to never be annotated, set `extraRules` to shadow them is not supported for built-ins; instead disable `annotate` for those cases (or open an issue).
- **Windows pwsh kills**: on Windows a killed pwsh process settles as bare exit 1 with no signal marker, so on Windows hosts the plugin does **not** annotate pwsh results at all (a real kill must not be masked). On macOS/Linux, pwsh kills report a signal and are skipped by the structured-exit gate. pwsh is hooked by design but has no e2e coverage in this repo (no PowerShell here).

Also note: DeepSeek Harness ships a `grep` *tool* (`@deepseek-ai/dsh-tool-fs-search`, in the base bundle) that already steers file-content search away from shell `grep` and returns "0 matches" as a success. The remaining exposure this plugin addresses is therefore mostly **non-file-search greps** (`git grep`, greps over command output), other benign exits (`git diff --exit-code`, `test -f`, `which`, `diff`, `rg`, `jq -e`), and the model's *standing instruction* to investigate every non-zero exit.

## Install

Requires DeepSeek Harness `0.1.0-rc.5+` and Node `^22.19.0 || >=24.0.0`.

```bash
# from npm (once published)
dsh plugin --profile web add dsh-benign-exit

# or from source
git clone https://github.com/sunruize93-cmyk/dsh-benign-exit
cd dsh-benign-exit
pnpm install
dsh plugin --profile web add .
```

The `dsh.bundle` declaration in this package's `package.json` makes `dsh plugin add` register it as an active profile layer automatically (verified against `0.1.0-rc.5`). After adding it, restart the profile.

To verify it is active, either:

```bash
dsh --profile web --dump-config | grep benign-exit     # should show the layer
```

or run a no-match `grep` in the agent and check the result shows
`(exit 1 = no matching lines — the command's documented meaning)` above the exit marker.

### Headless / one-shot tasks

Works for `--profile headless` too:

```bash
dsh plugin --profile headless add dsh-benign-exit
dsh --profile headless "search for getLegacyConfig and report whether it exists"
```

## Configuration

| Key | Type | Default | Meaning |
|---|---|---|---|
| `annotate` | boolean | `true` | Rewrite benign exit markers in tool results |
| `promptSection` | boolean | `true` | Add the benign-exit guidance system-prompt section |
| `extraRules` | `{command, exitCodes, reason}[]` | `[]` | Annotate YOUR tools' benign exits (only for commands not in the built-in table) |

Example:

```yaml
# profile cordis.patch.yml
- insert:
    - id: dsh-benign-exit
      name: 'dsh-benign-exit'
      config:
        annotate: true
        promptSection: true
        extraRules:
          - command: my-checker
            exitCodes: [3]
            reason: 'resource already provisioned'
```

## Verification

> **What is proven / what is not.** The plugin deterministically changes the model-facing text, verified against the real harness machinery below. A live before/after experiment (see the section above) measured token/time deltas on an engineered 4-task set; read its honest caveats before quoting any number. What is *mechanically* proven:

- **36 unit tests** of the parser/annotator (edge cases, compound-command rejection, masking-prevention, structured-exit gating, wrapper forms, last-marker anchoring).
- **10 integration tests** inside the real `ToolRuntime` dispatch pipeline (`tools/post-execute` waterfall): benign markers get annotated; real errors (exit 2), unknown commands, non-bash tools, **exit-0 runs whose output merely contains `[exit code: 1]`**, **signal-killed runs**, and **timed-out runs** all pass through untouched; downstream `additionalContexts` survive; the system-prompt section registers.
- **6 end-to-end tests with the REAL bash tool** (spawning real `grep`/`git` processes): a real no-match `grep` produces model-facing content `(exit 1 = no matching lines — the command's documented meaning)\n[exit code: 1]`; real `grep` error (exit 2) and matching `grep` (exit 0) pass through untouched; `git diff --exit-code` with differences is annotated; and the harness's own `parseExitStatus` still reads the annotated result as exit **1** (UI exit pill intact).

Run them yourself:

```bash
cd dsh-benign-exit && npm test                       # unit tests
# integration + real-bash tests run inside a DeepSeek Harness source checkout:
#   npx vitest run <path-to>/verification/dsh-benign-exit.integration.spec.ts
#   npx vitest run <path-to>/verification/dsh-benign-exit.real-bash.spec.ts
#   (set DSH_BENIGN_EXIT_PATH if the plugin lives elsewhere)
```

### Real before/after experiment (2026-08-17)

We ran a real before/after comparison on `deepseek-v4-flash` (24 headless runs: 4 tasks × 3 rounds × with/without the plugin). Full raw data + report: [`results/experiment-20260817/`](results/experiment-20260817/report.md).

Pooled over the 24 runs: **≈13% fewer steps, ≈20% fewer billed input tokens, ≈22% lower estimated cost** — but this is a token-weighted total dominated by one task. The **per-run typical effect is small (~+3%)**; pooled **excluding the dominant task**: −2%. The one solid signal is a "repeatedly re-verify a huge search surface via shell" task (all 3 after-rounds beat all 3 before-rounds; −38% billed input). The task set was deliberately negative-result-shaped, so these numbers are an **upper bound** for representative bash work, not a lower bound. Answers were equivalent with/without the plugin on every task. The harness steers file-content search to its built-in `grep` tool (out of scope), so bash-averse workflows get ~zero benefit.

Third-party field data (Bohu, 2026-08) measured dsh at 61 vs 32 requests, 10:38 vs 4:55 wall time, and **2.9M vs 548K input tokens**, and $0.17 vs $0.05 cost on the same task vs `pi`. That benchmark compares structurally different harnesses (its attribution to this one mechanism is the author's hypothesis, not an isolated experiment), and we have not reproduced those numbers. The over-investigation loop is the mechanism this plugin targets; it does not claim to close the whole gap.

## Compatibility

- Tested against DeepSeek Harness `0.1.0-rc.5` (`tool-bash`/`dsh-tools`) as of 2026-08-17, cordis `4.0.1`, schemastery `3.18.1`. All verification in this README is pinned to this revision.
- DeepSeek Harness is in developer preview ("THERE WILL BE COMPATIBILITY-BREAKING CHANGES"). Pin versions; this plugin locks to the injected `tools/post-execute` and `systemPrompt` seams, which are core and stable.

## License

MIT
