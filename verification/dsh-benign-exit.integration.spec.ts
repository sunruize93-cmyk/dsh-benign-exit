// Integration test: proves the dsh-benign-exit plugin fires inside the real
// harness machinery — the ToolRuntime dispatch pipeline (tools/post-execute
// waterfall), content replacement, and the system-prompt section.
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'

const PLUGIN_PATH = '/Users/sunruize/Desktop/dsh-benign-exit/src/index.js'

async function mount() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  const plugin = await import(PLUGIN_PATH)
  await ctx.plugin(plugin, { annotate: true, promptSection: true })
  return ctx
}

/** A bash-shaped tool whose render produces the given output text. */
function bashTool(output) {
  return {
    name: 'bash',
    description: 'Run a shell command',
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: () => Promise.resolve(output),
  }
}

async function runBash(ctx, command, output) {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`c-it-${Math.random().toString(36).slice(2)}`),
    name: 'bash',
    arguments: { command },
  })
  const first = result.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(result.content)
}

describe('dsh-benign-exit integration', () => {
  it('annotates a benign grep exit 1 in a real tools/post-execute dispatch', async () => {
    const ctx = await mount()
    ctx.tools.register(bashTool('scan done\n\n[exit code: 1]'))
    const text = await runBash(ctx, 'grep TODO src/index.js', '')
    expect(text).toContain('benign: no matching lines')
  })

  it('annotates git diff --exit-code differences', async () => {
    const ctx = await mount()
    ctx.tools.register(bashTool('[exit code: 1]'))
    const text = await runBash(ctx, 'git diff --exit-code HEAD HEAD~1', '')
    expect(text).toContain('benign: differences exist')
  })

  it('leaves a real grep error (exit 2) untouched', async () => {
    const ctx = await mount()
    ctx.tools.register(bashTool('grep: /missing: No such file\n\n[exit code: 2]'))
    const text = await runBash(ctx, 'grep foo /missing/file', '')
    expect(text).not.toContain('benign')
    expect(text).toContain('[exit code: 2]')
  })

  it('leaves unknown commands untouched', async () => {
    const ctx = await mount()
    ctx.tools.register(bashTool('[exit code: 1]'))
    const text = await runBash(ctx, 'node script.js', '')
    expect(text).not.toContain('benign')
  })

  it('registers the benign-exit guidance system-prompt section', async () => {
    const ctx = await mount()
    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find((s) => s.name === 'benign-exit:guidance')
    expect(section).toBeDefined()
    expect(section.text).toContain('grep/egrep/fgrep/rg/ack')
  })

  it('does not crash when the plugin is mounted before tools register bash', async () => {
    const ctx = await mount()
    // Non-bash tool must pass through untouched.
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
    const first = result.content[0]
    expect(first.type === 'text' ? first.text : '').not.toContain('benign')
  })
})
