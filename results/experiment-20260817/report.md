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

### Per-task delta (after vs before, negative = saved)

| task | steps | billed input | output | cost | wall |
|---|---|---|---|---|---|
| 0 | **-7%** | **-15%** | **-8%** | **-29%** | **-17%** |
| 1 | +10% | +23% | +19% | +56% | +17% |
| 2 | **+31%** | **+38%** | **+24%** | **+31%** | **+26%** |
| 3 | +0% | +2% | -5% | -2% | -5% |

### Aggregate (all tasks, all rounds)

| metric | before | after | saved |
|---|---|---|---|
| steps | 62 | 54 | **12.9%** |
| billed input tokens | 1,130,507 | 900,784 | **20.3%** |
| output tokens | 26,813 | 23,517 | **12.3%** |
| est cost (V4 Flash off-peak) | $0.0412 | $0.0323 | **21.7%** |
| wall time | 36.7s | 36.5s | 0.6% |

## Honest interpretation

- **The win is real but not universal.** The aggregate savings (≈13% steps,
  ≈20% billed input, ≈22% cost) come mostly from **task 2**, where the model
  repeatedly re-verifies a huge search surface via shell. Task 1 is also
  consistently faster. Task 3 is neutral. **Task 0 is noisy and leans worse**
  (4–7 steps per round in both envs — single-run variance dominates).
- **Mechanism match:** task 2/1 are exactly where benign-exit annotation
  short-circuits redundant re-verification (git diff exit-1 / grep no-match /
  test false). Task 3 (existence check) is trivial enough that both sides
  finish quickly; no loop to break.
- **Variance:** n=3 per task; steps are small integers, so per-task deltas are
  noisy. The aggregate over 24 runs is the more stable estimate. A larger n
  would tighten it.
- **Boundary observed live:** for file-content search, harness steers the model
  to its built-in `grep` tool (not bash), so those calls are out of the
  plugin's scope. The savings are therefore a **conservative lower bound** for
  bash-heavy workflows — and genuinely zero for workflows that never use bash
  for these patterns.

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
