// dsh-benign-exit — fix the "investigate every non-zero exit code" over-
// validation loop in DeepSeek Harness.
//
// Mechanism (two layers):
//  1. Result layer (deterministic): a `tools/post-execute` hook rewrites the
//     model-facing content of bash/pwsh results when the leading command is a
//     known tool and the exit code is a documented benign outcome (grep exit 1
//     = no match, git diff --exit-code exit 1 = differences, ...). The model
//     SEES the exit marked as expected instead of a bare `[exit code: 1]`, so
//     it does not re-investigate a normal result.
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

const GUIDANCE = 'Exit codes are information. Commands that legitimately exit 1 on a normal outcome and must NOT be treated as failures: '
  + 'grep/egrep/fgrep/rg/ack (no matching lines), diff/cmp/comm (inputs differ), test/[ (condition false), '
  + 'git grep (no matches), git diff --exit-code / --quiet (differences exist), which/type/command -v (not found), '
  + 'jq -e (filter evaluated to false or null). When a result marker reads `[exit code: N (benign: ...)]` the exit is expected — '
  + 'report it as a normal outcome and continue; do not re-investigate it as a failure.'

export function apply(ctx, config) {
  if (config.annotate) {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      // Compose: let the rest of the chain decide first; only override content
      // when no other handler already replaced it.
      const downstream = await next()
      if (downstream.kind !== 'accept') return downstream
      if (downstream.content !== undefined || downstream.value !== undefined) return downstream
      if (!SHELL_TOOLS.has(exec.name)) return downstream

      const args = exec.arguments
      const command = args && typeof args.command === 'string' ? args.command : ''
      if (!command) return downstream

      const content = result.content
      if (!Array.isArray(content)) return downstream

      const blocks = content.map((block) => {
        if (!block || block.type !== 'text' || typeof block.text !== 'string') return block
        const r = annotateBenignExit(block.text, command, config.extraRules)
        return r.changed ? { ...block, text: r.text } : block
      })
      const changed = blocks.some((b, i) => b !== content[i])
      if (!changed) return downstream

      return { kind: 'accept', content: blocks }
    })
  }

  if (config.promptSection) {
    ctx.systemPrompt.section({
      name: 'benign-exit:guidance',
      // Just after the harness's own tool guidance (order 105).
      order: 106,
      text: GUIDANCE,
    })
  }
}
