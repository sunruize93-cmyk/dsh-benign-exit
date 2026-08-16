// Integration test: proves the dsh-benign-exit plugin fires inside the real
// harness machinery — the ToolRuntime dispatch pipeline (tools/post-execute
// waterfall), content replacement, structured-exit gating, and the
// system-prompt section.
//
// Run from inside a DeepSeek Harness source checkout:
//   npx vitest run <path>/verification/dsh-benign-exit.integration.spec.ts
// Set DSH_BENIGN_EXIT_PATH if the plugin lives elsewhere.
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'

const PLUGIN_PATH = process.env.DSH_BENIGN_EXIT_PATH
  ?? '/Users/sunruize/Desktop/dsh-benign-exit/src/index.js'

async function mount() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  const plugin = await import(PLUGIN_PATH)
  await ctx.plugin(plugin, { annotate: true, promptSection: true })
  return ctx
}

/** A bash-shaped tool carrying a STRUCTURED value + the rendered text. */
function bashTool({ exitCode = 1, signal = null, timedOut = false, aborted = false, text = `(no output)\n\n[exit code: ${exitCode}]` }) {
  const value = { kind: 'foreground', exitCode, signal, timedOut, aborted, text }
  return {
    name: 'bash',
    description: 'Run a shell command',
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
    output: {
      schema: { type: 'object' },
      render: (_args, v) => [{ type: 'text', text: v.text }],
    },
    execute: () => Promise.resolve(value),
  }
}

async function runBash(ctx, command, tool) {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`c-it-${Math.random().toString(36).slice(2)}`),
    name: 'bash',
    arguments: { command },
  })
  return result
}

function textOf(result) {
  return result.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n')
}

describe('dsh-benign-exit integration', () => {
  it('annotates a benign grep exit 1 in a real tools/post-execute dispatch', async () => {
    const ctx = await mount()
    const tool = bashTool({ exitCode: 1, text: 'scan done\n\n[exit code: 1]' })
    ctx.tools.register(tool)
    const result = await runBash(ctx, 'grep TODO src/index.js', tool)
    expect(textOf(result)).toContain('exit 1 = no matching lines')
  })

  it('annotates git diff --exit-code differences', async () => {
    const ctx = await mount()
    const tool = bashTool({ exitCode: 1 })
    ctx.tools.register(tool)
    const result = await runBash(ctx, 'git diff --exit-code HEAD HEAD~1', tool)
    expect(textOf(result)).toContain('exit 1 = differences exist')
  })

  it('leaves a real grep error (exit 2) untouched', async () => {
    const ctx = await mount()
    const tool = bashTool({ exitCode: 2, text: 'grep: /missing: No such file\n\n[exit code: 2]' })
    ctx.tools.register(tool)
    const result = await runBash(ctx, 'grep foo /missing/file', tool)
    const text = textOf(result)
    expect(text).not.toContain('benign')
    expect(text).toContain('[exit code: 2]')
  })

  it('leaves unknown commands untouched', async () => {
    const ctx = await mount()
    const tool = bashTool({ exitCode: 1 })
    ctx.tools.register(tool)
    const result = await runBash(ctx, 'node script.js', tool)
    expect(textOf(result)).not.toContain('benign')
  })

  it('does NOT annotate a success (exit 0) whose output merely contains "[exit code: 1]"', async () => {
    const ctx = await mount()
    // grep MATCHED (exit 0) and the matching line itself reads "[exit code: 1]".
    const tool = bashTool({ exitCode: 0, text: 'config line [exit code: 1]\n' })
    ctx.tools.register(tool)
    const result = await runBash(ctx, 'grep code config.txt', tool)
    const text = textOf(result)
    expect(text).not.toContain('benign')
    expect(text).toContain('[exit code: 1]') // untouched literal content
  })

  it('does NOT annotate a signal-killed run (no real exit code)', async () => {
    const ctx = await mount()
    const tool = bashTool({ exitCode: null, signal: 'SIGKILL', text: 'partial output\n[exit code: 1]\n[killed by signal: SIGKILL]' })
    ctx.tools.register(tool)
    const result = await runBash(ctx, 'grep foo file', tool)
    expect(textOf(result)).not.toContain('benign')
  })

  it('does NOT annotate a timed-out run', async () => {
    const ctx = await mount()
    const tool = bashTool({ exitCode: 1, timedOut: true, text: 'partial\n[timed out after 10000ms]\n[exit code: 1]' })
    ctx.tools.register(tool)
    const result = await runBash(ctx, 'grep foo file', tool)
    expect(textOf(result)).not.toContain('benign')
  })

  it('forwards additionalContexts from a downstream post-execute handler', async () => {
    const ctx = await mount()
    // A downstream handler attaches context but no content.
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const downstream = await next()
      return {
        kind: 'accept',
        additionalContexts: [createUserMessage({ content: 'downstream-ctx-marker' })],
      }
    })
    const tool = bashTool({ exitCode: 1 })
    ctx.tools.register(tool)
    const result = await runBash(ctx, 'grep TODO src', tool)
    // The annotation must not drop the downstream's context.
    expect(textOf(result)).toContain('exit 1 = no matching lines')
    expect(result.additionalContexts?.some((m) => JSON.stringify(m).includes('downstream-ctx-marker'))).toBe(true)
  })

  it('registers the benign-exit guidance system-prompt section', async () => {
    const ctx = await mount()
    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find((s) => s.name === 'benign-exit:guidance')
    expect(section).toBeDefined()
    expect(section.text).toContain('grep/egrep/fgrep/rg/ack')
  })

  it('does not touch non-bash tools', async () => {
    const ctx = await mount()
    ctx.tools.register({
      name: 'other',
      description: 'another tool',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: () => Promise.resolve('[exit code: 1]'),
    })
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('c-other'),
      name: 'other',
      arguments: {},
    })
    expect(textOf(result)).not.toContain('benign')
  })
})
