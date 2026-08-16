# dsh-benign-exit

A DeepSeek Harness plugin that stops agents from **over-investigating benign non-zero exit codes**.

`grep` exits `1` when nothing matches — that is normal, not a failure. But DeepSeek Harness's bash tool tells the model:

> "Check the `[exit code: N]` marker on every bash result; **investigate failures before moving on**."

So a model that runs `grep` and finds nothing sees `[exit code: 1]`, reads the standing instruction as "this failed, investigate", and starts re-checking — a self-reinforcing verification loop that burns requests, time, and tokens on a perfectly normal result.

This plugin makes the exit code **self-describing**: when the leading command is a known tool and the exit code is a documented benign outcome, the model-facing result is annotated so the model sees *why* the exit is normal — and is not prompted to investigate it.

## How it works

Two layers:

1. **Result layer (deterministic).** A `tools/post-execute` hook rewrites the model-facing content of `bash` / `pwsh` results. For example, a real `grep` run that found nothing renders as:

   ```
   (no output)
   [exit code: 1 (benign: no matching lines — expected, not a failure)]
   ```

   The model sees the exit explicitly marked as expected — this is a change to what the model *sees*, so it does not depend on the model's mood or the prompt wording.

2. **Prompt layer (reinforcement).** A small system-prompt section teaches the benign exit-code vocabulary, so the standing "investigate failures" guidance is read correctly.

## What counts as benign

The built-in table only covers **documented** normal outcomes:

| Command | Exit | Meaning |
|---|---|---|
| `grep`, `egrep`, `fgrep`, `rg`, `ack` | 1 | no matching lines |
| `diff`, `cmp`, `comm` | 1 | inputs differ |
| `test`, `[` | 1 | condition is false |
| `which`, `type`, `command -v` | 1 | not found (informational) |
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
- **Real failures** (`grep` exit 2, any unknown command, any exit not in the table): untouched. The built-in table is authoritative — user extra rules can never mask a real failure for a built-in command.

Also note: DeepSeek Harness ships a `grep` *tool* (`@deepseek-ai/dsh-tool-fs-search`, in the base bundle) that already steers file-content search away from shell `grep` and returns "0 matches" as a success. The remaining exposure this plugin addresses is therefore mostly **non-file-search greps** (`git grep`, greps over command output), other benign exits (`git diff --exit-code`, `test -f`, `which`, `diff`, `rg`, `jq -e`), and the model's *standing instruction* to investigate every non-zero exit.

## Install

Requires DeepSeek Harness `0.1.0-rc.5+` and Node `^22.19.0 || >=24.0.0`.

```bash
# from npm (once published)
dsh plugin --profile web add dsh-benign-exit

# or from source
git clone https://github.com/<you>/dsh-benign-exit
cd dsh-benign-exit
pnpm install
dsh plugin --profile web add .
```

Or merge the insert row from `cordis.patch.yml` into your profile's `cordis.patch.yml`.

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

> **Honest scope of what has and hasn't been proven.** No end-to-end agent runs with a real LLM have been performed yet — the token/time/cost *impact* therefore is not measured by us. What *is* proven, against the real harness machinery:

- **28 unit tests** of the parser/annotator (edge cases, compound commands, masking-prevention, last-marker anchoring).
- **6 integration tests** inside the real `ToolRuntime` dispatch pipeline (`tools/post-execute` waterfall): benign markers get annotated, real errors and unknown commands pass through, non-bash tools unaffected, the system-prompt section registers.
- **4 end-to-end tests with the REAL bash tool** (spawning real `grep`/`git` processes): a real no-match `grep` produces model-facing content `[exit code: 1 (benign: no matching lines — expected, not a failure)]`; a real `grep` error (exit 2) and a matching `grep` (exit 0) pass through untouched; `git diff --exit-code` with differences is annotated.

Run them yourself:

```bash
cd dsh-benign-exit && npm test                       # unit tests
# integration + real-bash tests live in the harness repo:
#   verification/*.spec.ts  (see README section below)
```

Third-party field data (Bohu, 2026-08) measured dsh at 61 vs 32 requests, 10:38 vs 4:55 wall time, and $0.17 vs $0.05 cost on the same task vs `pi` — consistent with the over-investigation mechanism fixed here. We have **not** reproduced those numbers ourselves; the mechanism, not the magnitude, is what this plugin addresses.

## Compatibility

- Tested against `0.1.0-rc.5` (`tool-bash`/`dsh-tools`), cordis `4.0.1`, schemastery `3.18.1`.
- DeepSeek Harness is in developer preview ("THERE WILL BE COMPATIBILITY-BREAKING CHANGES"). Pin versions; this plugin locks to the injected `tools/post-execute` and `systemPrompt` seams, which are core and stable.

## License

MIT
