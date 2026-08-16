# Before/after experiment — dsh-benign-exit (2026-08-17)

Real LLM comparison on DeepSeek Harness headless, `deepseek-v4-flash`, with the
official DeepSeek API. Raw data: `*.jsonl` (per-step usage) + `*.out.txt`
(agent stdout) + `timings.tsv` in this directory.

## Setup

Two profiles, identical except the plugin:

- **before**: headless + `dsh-exp-stat` (usage statistician; listens to
  `session/event`, records official usage fields).
- **after**: headless + `dsh-exp-stat` + **dsh-benign-exit** (`annotate: true`,
  `promptSection: true`).

4 tasks × 3 rounds each, alternating before/after. Billed input =
`inputTokens + cacheWriteTokens + cacheReadTokens` (DeepSeek's raw prompt
count already folds cache in, per the harness's TokenUsage contract; DeepSeek's
`prompt_tokens` is split back out by the adapter).

## Tasks

0. Search the codebase for `getLegacyConfig`; report where defined/used, else NOT_FOUND.
1. Check whether the working tree differs from the last commit; report DIFF or SAME.
2. Verify no file in `src/` imports `"react"`; report PASS or FAIL.
3. Does `nonexistent-module.ts` exist under `src/`? Report YES or NO.

All tasks are "no-match / negative-result" shaped — the over-investigation
scenario. Task 2 additionally forces repeated shell verification on a huge
search surface (react is genuinely present; the model re-confirms many times).

## Answer quality

Before and after produce **equivalent answers** on every task and every round
(verified from `*.out.txt`). The difference is efficiency, not correctness.

## Results (all rounds pooled)

| task | env | steps | billed input (tk) | output (tk) | est $ | wall (s) |
|---|---|---|---|---|---|---|
| 0 | before | 14 | 206,830 | 3,977 | 0.0052 | 70.3 |
| 0 | after | 15 | 236,764 | 4,306 | 0.0067 | 82.1 |
| 1 | before | 10 | 161,656 | 2,887 | 0.0059 | 9.8 |
| 1 | after | 9 | 123,795 | 2,350 | 0.0026 | 8.1 |
| 2 | before | 26 | 573,785 | 14,008 | 0.0235 | 46.7 |
| 2 | after | 18 | 355,773 | 10,601 | 0.0162 | 34.8 |
| 3 | before | 12 | 188,236 | 5,941 | 0.0066 | 20.1 |
| 3 | after | 12 | 184,452 | 6,260 | 0.0067 | 21.0 |

### Per-task delta (positive = saved; computed as (before − after)/before)

| task | steps | billed input | output | cost | wall |
|---|---|---|---|---|---|
| 0 | −7% | −15% | −8% | −29% | −17% |
| 1 | +10% | +23% | +19% | +56% | +17% |
| 2 | **+31%** | **+38%** | **+24%** | **+31%** | **+26%** |
| 3 | +0% | +2% | −5% | −2% | −5% |

Positive = saved, negative = regressed. Note task 1's "+23% billed input" is
**entirely one cold-cache round** (`before_1_1`: 12,941 uncached input vs ~300
in the other 5 rounds); rounds 2 and 3 of task 1 are actually slightly worse
after. Treat task 1 as noise, not a stable win.

### Aggregate (all tasks, all rounds)

| metric | before | after | saved |
|---|---|---|---|
| steps | 62 | 54 | **12.9%** |
| billed input tokens | 1,130,507 | 900,784 | **20.3%** |
| output tokens | 26,813 | 23,517 | **12.3%** |
| est cost (V4 Flash off-peak) | $0.0412 | $0.0323 | **21.7%** |
| wall time | 36.7s | 36.5s | 0.6% |

## Honest interpretation

- **The headline number is real but is a pooled, task-weighted total — not the
  typical run.** Pooled all-tasks billed input: −20.3%. But the **typical
  (mean-per-run) delta is ~+3%** (median +7.8%, min −128%, max +49%; 6 of 12
  pairs saved, 6 got worse). Pooled **excluding task 2**: −2.1%. The −20%
  headline is dominated by task 2 (≈51% of before's billed tokens).
- **The one solid signal is task 2.** Its 3 after-rounds (110K/143K/102K billed)
  all beat its 3 before-rounds (155K/231K/188K) — no overlap. Task 2 is a
  "repeatedly re-verify a huge search surface via shell" task, exactly where the
  annotation short-circuits redundant re-verification. It is n=3.
- **Tasks 1 and 3 are noise.** Task 1's apparent +23% is one cold-cache round
  (before_1_1); its rounds 2–3 are slightly worse after. Task 3 is ~flat.
  **Task 0 leans worse** (single-run variance dominates; 4–7 steps both envs).
- **The task sample was engineered toward the mechanism** (all 4 are
  "negative-result shaped"), so these numbers are an **upper bound** for
  representative bash work, not a lower bound. The honest statement is: "this
  is a measurement of 4 engineered tasks."
- **Boundary observed live:** for file-content search, harness steers the model
  to its built-in `grep` tool (not bash), out of the plugin's scope. Workflows
  that never use bash for these patterns get ~zero benefit.
- **Caveat on attribution:** the after profile enabled BOTH `annotate` and
  `promptSection`; the prompt section alone could carry part of the behavioral
  effect. We did not ablate the two layers. We also did not log tool calls, so
  "the annotation fired" in the after runs is inferred from behavior, not
  directly observed.

## Method notes (for the adversarial review)

- Profiles differ ONLY by the presence of dsh-benign-exit. Same stat plugin,
  same model, same tasks, same order.
- Tokens come from the API's own `usage` object (via `assistant/message`),
  not estimated.
- Cost uses DeepSeek V4 Flash **off-peak** rates (2026-08-17 revision):
  input miss $0.22/M, cache hit $0.007/M, output $0.66/M.
- We do **not** claim the aggregate as "the plugin's effect on all workloads."
  It is a measurement of these 4 tasks. Reproduce with
  `scripts/run-before-after.sh` + `scripts/analyze-results.py`.
