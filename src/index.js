// dsh-benign-exit — fix the "investigate every non-zero exit code" over-
// validation loop in DeepSeek Harness.
//
// Mechanism (two layers):
//  1. Result layer (deterministic): a `tools/post-execute` hook rewrites the
//     model-facing content of bash/pwsh results when the leading command is a
//     known tool and the exit code is a documented benign outcome (grep exit 1
//     = no match, git diff --exit-code exit 1 = differences, ...). A line like
//     `(benign: no matching lines — expected, not a failure)` is inserted
//     ABOVE the `[exit code: 1]` marker, so the model SEES the exit marked as
//     expected and does not re-investigate a normal result.
//  2. Prompt layer (reinforcement): a small system-prompt section teaches the
//     benign exit-code vocabulary so the standing "investigate failures"
//     guidance is read correctly.
//
// Conservative by design: only known command + documented benign exit codes
// are annotated; anything ambiguous passes through untouched. Legitimate
// failures are never masked.

import z from '@deepseek-ai/schemastery'
import { annotateBenignExit } from './benign.js'

export const name = 'dsh-benign-exit'
export const inject = ['systemPrompt']

/** The harness's bash and pwsh tools both use a `command` argument. */
const SHELL_TOOLS = new Set(['bash', 'pwsh'])

/**
 * Extract a trustworthy non-zero exit code from a result's structured value,
 * or null. The text marker alone is not trustworthy: the harness appends
 * `[exit code: N]` ONLY for a non-zero exit, so on exit 0 a literal
 * `[exit code: 1]` in the output is content, not the exit. Signal kills and
 * timeouts also render without a real exit marker. This gate is what makes
 * the last text marker reliable.
 */
function realNonZeroExit(value) {
  if (!value || typeof value !== 'object') return null
  const { exitCode, signal, timedOut, aborted } = value
  if (typeof exitCode !== 'number' || !Number.isInteger(exitCode) || exitCode <= 0) return null
  if (signal != null) return null // killed by signal — no real exit code
  if (timedOut === true || aborted === true) return null // cut short — not a normal exit
  return exitCode
}

const IS_WINDOWS = process.platform === 'win32'

export const Config = z.object({
  /** Rewrite benign non-zero exit markers in tool results (the core fix). */
  annotate: z.boolean().default(true),
  /** Add a system-prompt section teaching benign exit codes. */
  promptSection: z.boolean().default(true),
  /** User-extensible rules: [{ command, exitCodes, reason }]. */
  extraRules: z.array(z.object({
    command: z.string(),
    exitCodes: z.array(z.number()),
    reason: z.string(),
  })).default([]),
})

const GUIDANCE = 'Exit codes are information, and a non-zero exit does not automatically mean "something broke". These commands exit 1 as their DOCUMENTED meaning, not as a failure: '
  + 'grep/egrep/fgrep/rg/ack (no matching lines), diff/cmp/comm (inputs differ), test/[ (condition false), '
  + 'git grep (no matches), git diff --exit-code / --quiet (differences exist), which/type (not found), '
  + 'jq -e (filter evaluated to false or null). When a result shows a line like `(exit 1 = no matching lines — the command\'s documented meaning; report it, don\'t re-investigate)` '
  + 'above the `[exit code: 1]` marker, the exit is the command\'s documented outcome — report what it MEANS for the task and continue. The exit may still be task-relevant (e.g. a missing file you were checking for), so report it; just do not re-investigate it as a broken command.'

export function apply(ctx, config) {
  if (config.annotate) {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      // Compose: let the rest of the chain decide first; only override content
      // when no other handler already replaced it.
      const downstream = await next()
      if (downstream.kind !== 'accept') return downstream
      if (downstream.content !== undefined || downstream.value !== undefined) return downstream
      if (!SHELL_TOOLS.has(exec.name)) return downstream
      // On Windows a killed pwsh settles as bare exit 1 with no signal marker,
      // so a "benign" annotation there would mask a real kill. Conservative.
      if (IS_WINDOWS && exec.name === 'pwsh') return downstream

      const args = exec.arguments
      const command = args && typeof args.command === 'string' ? args.command : ''
      if (!command) return downstream

      // Trust only a structured, real non-zero exit (no signal, no timeout,
      // no abort). This prevents annotating output that merely CONTAINS a
      // `[exit code: 1]` line on a successful or interrupted run.
      const exitCode = realNonZeroExit(result.value)
      if (exitCode == null) return downstream

      const content = result.content
      if (!Array.isArray(content)) return downstream

      const blocks = content.map((block) => {
        if (!block || block.type !== 'text' || typeof block.text !== 'string') return block
        const r = annotateBenignExit(block.text, command, config.extraRules, exitCode)
        return r.changed ? { ...block, text: r.text } : block
      })
      const changed = blocks.some((b, i) => b !== content[i])
      if (!changed) return downstream

      // Preserve any context a downstream handler attached (harness merges
      // decision.additionalContexts; dropping it would silently break it).
      const withContext = downstream.additionalContexts?.length
        ? { additionalContexts: downstream.additionalContexts }
        : {}
      return { kind: 'accept', content: blocks, ...withContext }
    })
  }

  if (config.promptSection) {
    ctx.systemPrompt.section({
      name: 'benign-exit:guidance',
      // After the harness's tool guidance (grep 104, bash 105, terminal/jobs
      // 106); 107 keeps it clear of existing order-106 sections.
      order: 107,
      text: GUIDANCE,
    })
  }
}
