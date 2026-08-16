// End-to-end proof with the REAL bash tool: a real grep invocation that exits
// 1 (no match) must produce model-facing content annotated as benign by the
// dsh-benign-exit plugin; real errors (exit 2) and matches (exit 0) must pass
// through untouched; the harness's own parseExitStatus must still read the
// annotated result's exit code correctly (UI terminal pill stays 1).
//
// Run from inside a DeepSeek Harness source checkout:
//   npx vitest run <path>/verification/dsh-benign-exit.real-bash.spec.ts
// Set DSH_BENIGN_EXIT_PATH if the plugin lives elsewhere.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { parseExitStatus } from '@deepseek-ai/dsh-shell'

const PLUGIN_PATH = process.env.DSH_BENIGN_EXIT_PATH
  ?? '/Users/sunruize/Desktop/dsh-benign-exit/src/index.js'

const spillDir = mkdtempSync(join(tmpdir(), 'dsh-benign-exit-'))

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  ;(ctx.subprocess).internals = { spillDir }
  await ctx.plugin(BashEnvPlugin)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, graceMs: 200 })
  await ctx.plugin(ToolBash)
  const plugin = await import(PLUGIN_PATH)
  await ctx.plugin(plugin, { annotate: true, promptSection: false })
  return ctx
}

function registerFakeAgent(ctx, sessionId) {
  const scopeFiber = ctx.plugin(() => {})
  const id = SessionId(sessionId)
  const agent = {
    id,
    ctx: scopeFiber.ctx,
    inject: () => {},
    session: { id, header: { version: 0, id, createdAt: 0 } },
  }
  ctx.agents.register(agent)
  return agent
}

let callCounter = 0
function call(ctx, args, agent) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`real-${++callCounter}`),
    name: 'bash',
    arguments: args,
    agent,
  })
}

function textOf(result) {
  return result.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n')
}

describe('dsh-benign-exit with the real bash tool', () => {
  it('renders a real grep no-match exit 1 as annotated benign', async () => {
    const ctx = await setup()
    const agent = registerFakeAgent(ctx, 'sess-1')
    const file = join(spillDir, 'real-bash-test.txt')
    writeFileSync(file, 'alpha\nbeta\ngamma\n')

    const result = await call(ctx, { command: `grep zeta ${file}`, description: "search for zeta" }, agent)
    const text = textOf(result)
    expect(text).toContain('exit 1 = no matching lines')
    expect(text).toContain('documented meaning')
  })

  it('leaves a real grep error (exit 2) untouched', async () => {
    const ctx = await setup()
    const agent = registerFakeAgent(ctx, 'sess-2')
    const result = await call(ctx, { command: "grep zeta /definitely/missing/file", description: "search missing file" }, agent)
    const text = textOf(result)
    expect(text).toContain('[exit code: 2]')
    expect(text).not.toContain('benign')
  })

  it('leaves a matching grep (exit 0) untouched', async () => {
    const ctx = await setup()
    const agent = registerFakeAgent(ctx, 'sess-3')
    const file = join(spillDir, 'real-bash-test.txt')
    writeFileSync(file, 'alpha\nbeta\n')

    const result = await call(ctx, { command: `grep alpha ${file}`, description: "search for alpha" }, agent)
    const text = textOf(result)
    expect(text).toContain('alpha')
    expect(text).not.toContain('benign')
    expect(text).not.toContain('exit code') // exit 0 renders no marker
  })

  it('annotates git diff --exit-code when files differ', async () => {
    const ctx = await setup()
    const agent = registerFakeAgent(ctx, 'sess-4')
    const a = join(spillDir, 'a.txt')
    const b = join(spillDir, 'b.txt')
    writeFileSync(a, 'one\n')
    writeFileSync(b, 'two\n')

    const result = await call(ctx, { command: `git diff --no-index --exit-code ${a} ${b}`, description: "diff two files" }, agent)
    const text = textOf(result)
    expect(text).toContain('exit 1 = differences exist')
    expect(text).toContain('documented meaning')
  })

  it('preserves the harness parseExitStatus contract: annotated result still reads exit 1', async () => {
    const ctx = await setup()
    const agent = registerFakeAgent(ctx, 'sess-5')
    const file = join(spillDir, 'parse-exit.txt')
    writeFileSync(file, 'alpha\nbeta\n')

    const result = await call(ctx, { command: `grep zeta ${file}`, description: "search for zeta" }, agent)
    const text = textOf(result)
    expect(text).toContain('(exit 1 = no matching lines')
    // The real exit marker must remain the literal final line, so the UI
    // terminal card (parseExitStatus) still shows exit 1.
    const parsed = parseExitStatus(text)
    expect(parsed.exitCode).toBe(1) // UI pill stays 1 — contract preserved
    expect(parsed.body).toContain('exit 1 = no matching lines') // model still sees it
    expect(parsed.body).not.toContain('[exit code: 1]') // marker parsed out of the body
  })

  it('does NOT annotate when a matching line itself reads "[exit code: 1]" (real exit 0)', async () => {
    const ctx = await setup()
    const agent = registerFakeAgent(ctx, 'sess-6')
    const file = join(spillDir, 'marker-line.txt')
    writeFileSync(file, 'config line [exit code: 1]\n')

    // grep MATCHES the file (exit 0); the matched content contains the string
    // "[exit code: 1]" but it is NOT a real exit marker.
    const result = await call(ctx, { command: `grep code ${file}`, description: "search for code" }, agent)
    const text = textOf(result)
    expect(text).toContain('[exit code: 1]')
    expect(text).not.toContain('benign')
  })
})
