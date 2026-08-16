// dsh-benign-exit — pure logic for annotating benign non-zero exit codes.
//
// Conservative by design: we only annotate when the leading command is a
// KNOWN tool and the exit code is a documented BENIGN outcome (information,
// not a failure). Anything ambiguous passes through untouched, so legitimate
// failures are never masked.
//
// This module is dependency-free so it can be unit-tested with `node --test`
// without a build step.

/** Built-in table: leading command → { exitCode: reason }. */
export const BENIGN_CODES = {
  grep: { 1: 'no matching lines' },
  egrep: { 1: 'no matching lines' },
  fgrep: { 1: 'no matching lines' },
  rg: { 1: 'no matching lines' },
  ack: { 1: 'no matching lines' },
  diff: { 1: 'inputs differ' },
  cmp: { 1: 'inputs differ' },
  comm: { 1: 'inputs differ' },
  test: { 1: 'condition is false' },
  '[': { 1: 'condition is false' },
  which: { 1: 'not found' },
  type: { 1: 'not found' },
  jq: { 1: 'filter evaluated to false or null' },
  'git grep': { 1: 'no matching lines' },
  // git diff / git diff-index are only annotated when the caller used
  // --exit-code / --quiet; parseLeadingCommand gates on that.
  'git diff': { 1: 'differences exist' },
  'git diff-index': { 1: 'differences exist' },
}

/** Shells whose exit code belongs to the shell, not a tool. */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'csh', 'ksh', 'fish'])

/** Wrappers/privilege tools whose exit code may reflect the wrapper, not the tool. */
const WRAPPERS = new Set(['sudo', 'env', 'nice', 'nohup', 'timeout', 'command'])

/**
 * Quote-aware scan that rejects command lines with shell composition
 * (pipes, sequences, control operators) at top level. We only annotate
 * simple single-command invocations where the reported exit code belongs
 * unambiguously to the leading command.
 */
function hasTopLevelOperators(cmd) {
  let inS = false
  let inD = false
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (ch === '\\') { i += 1; continue }
    if (ch === "'" && !inD) { inS = !inS; continue }
    if (ch === '"' && !inS) { inD = !inD; continue }
    if (inS || inD) continue
    if (ch === '\n' || ch === '`' || ch === '|' || ch === ';') return true
    if (ch === '$' && cmd[i + 1] === '(') return true
    if (ch === '(' || ch === ')') return true
    if (ch === '{' || ch === '}') return true
    // ANY redirection (<, >, here-doc, here-string, fd redirect) is rejected:
    // a failed redirection exits 1 and the exit code would then belong to the
    // SHELL, not the leading tool. Annotating it as "benign: no match" would
    // mask a real failure (the single worst failure mode for this plugin).
    if (ch === '<' || ch === '>') return true
    if (ch === '&') {
      // &> combined redirect is also a redirect → reject.
      if (cmd[i + 1] === '>') return true
      // Anything else with & is backgrounding / && / || → reject.
      return true
    }
  }
  return false
}

/** Quote-aware extraction of the first n whitespace-separated tokens. */
function firstTokens(cmd, n) {
  const out = []
  let cur = ''
  let inS = false
  let inD = false
  let started = false
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (ch === '\\' && !inS) {
      cur += ch
      if (cmd[i + 1]) { cur += cmd[i + 1]; i += 1 }
      continue
    }
    if (ch === "'" && !inD) { inS = !inS; started = true; continue }
    if (ch === '"' && !inS) { inD = !inD; started = true; continue }
    if ((inS || inD) || !/\s/.test(ch)) { cur += ch; started = true; continue }
    if (started) {
      out.push(cur)
      cur = ''
      started = false
      if (out.length >= n) return out
    }
  }
  if (started) out.push(cur)
  return out
}

/**
 * Identify the leading command of a shell command line.
 * Returns `{ base, flags }` or `null` when the command cannot be identified
 * with confidence. `flags` is the token list after the command name.
 */
export function parseLeadingCommand(raw, depth = 0) {
  let cmd = String(raw ?? '').trim()
  if (!cmd || depth > 3) return null
  if (hasTopLevelOperators(cmd)) return null

  // No wrapper stripping. A wrapper's failure (sudo denied, env error, timeout
  // expiry, sh -c parse error, leading env-assignment failure) exits 1 and the
  // exit code then belongs to the WRAPPER, not the leading tool. Annotating it
  // would mask a real failure. The plugin only annotates the simplest,
  // unambiguous single-command form — that is the price of never lying.

  const tokens = firstTokens(cmd, 12)
  if (tokens.length === 0) return null

  const first = tokens[0]
  if (first.includes('/')) return null // explicit path — could be any script

  // Leading env-assignments and shell builtins/wrappers (`command`, `bash`,
  // `sh`, `sudo`, `env`, ...) whose exit 1 can come from the shell, not a
  // tool: reject.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return null
  if (WRAPPERS.has(first) || SHELLS.has(first)) return null

  if (first === 'git') {
    // Skip global git flags before the subcommand: `-C <dir>`, `--no-pager`,
    // `--paginate`, `--git-dir=X`, `--work-tree=X`.
    let idx = 1
    while (idx < tokens.length) {
      const t = tokens[idx]
      if (t === '-C' || t === '--git-dir' || t === '--work-tree') { idx += 2; continue }
      if (t === '--no-pager' || t === '--paginate') { idx += 1; continue }
      break
    }
    const sub = tokens[idx]
    if (!sub) return null
    const rest = tokens.slice(idx + 1)
    if (sub === 'grep') return { base: 'git grep', flags: rest }
    const hasExitCodeFlag = rest.includes('--exit-code') || rest.includes('--quiet')
    if (sub === 'diff' && hasExitCodeFlag) return { base: 'git diff', flags: rest }
    if (sub === 'diff-index' && hasExitCodeFlag) return { base: 'git diff-index', flags: rest }
    return null
  }

  return { base: first, flags: tokens.slice(1) }
}

/**
 * Resolve the effective benign-exit table for a parsed command.
 *
 * The built-in table is authoritative for KNOWN commands — extra rules never
 * add codes to them, so a user rule can never mask a real failure (e.g. grep
 * exit 2) by declaring it benign. Extra rules apply only to commands with no
 * built-in entry (the user's own tools).
 *
 * Returns null when the command has no benign outcomes worth annotating.
 */
/** Guard: only positive integer exit codes (1–255) are ever annotated. */
function isRealExitCode(code) {
  return Number.isInteger(code) && code > 0 && code < 256
}

export function effectiveTable(parsed, extraRules = []) {
  if (!parsed || !parsed.base) return null
  if (parsed.base === 'jq') {
    const flags = parsed.flags ?? []
    if (!flags.includes('-e') && !flags.includes('--exit-status')) return null
  }
  const builtin = BENIGN_CODES[parsed.base]
  if (builtin) return Object.keys(builtin).length > 0 ? { ...builtin } : null
  const map = {}
  for (const rule of extraRules ?? []) {
    if (!rule || rule.command !== parsed.base || !Array.isArray(rule.exitCodes)) continue
    for (const code of rule.exitCodes) {
      if (isRealExitCode(code)) map[String(code)] = rule.reason
    }
  }
  return Object.keys(map).length > 0 ? map : null
}

const EXIT_MARKER = /\[exit code: (\d+)\]/g

/**
 * Annotate benign non-zero exit markers in a result's text.
 *
 * The annotation is inserted as a line ABOVE the real `[exit code: N]` marker,
 * never into it — the harness's `parseExitStatus` (used by the UI terminal
 * card) requires the marker to remain the literal final line
 * `/\n\[exit code: (\d+)\]$/`, so the marker text itself must not change.
 *
 * `expectedExitCode` (optional) is the structured exit code from the result's
 * value; when given, the last text marker must agree with it. The caller gates
 * on the structured value (non-zero, no signal, no timeout), which is what
 * makes the last text marker trustworthy.
 *
 * Returns the (possibly unchanged) text plus a `changed` flag.
 * Idempotent: text that already contains an annotation is left alone.
 */
export function annotateBenignExit(text, command, extraRules = [], expectedExitCode) {
  if (typeof text !== 'string' || !text.includes('[exit code:')) {
    return { text, changed: false }
  }
  if (text.includes("the command's documented meaning")) return { text, changed: false } // idempotent
  const parsed = parseLeadingCommand(command)
  const table = effectiveTable(parsed, extraRules)
  if (!table) return { text, changed: false }

  // The REAL exit marker is the last `[exit code: N]` in the result text
  // (render.ts appends it as the final line). Earlier occurrences may be
  // literal content echoed from files, so only the last one is annotated.
  const matches = [...text.matchAll(EXIT_MARKER)]
  if (matches.length === 0) return { text, changed: false }
  const last = matches[matches.length - 1]
  const code = last[1]
  if (expectedExitCode !== undefined && String(expectedExitCode) !== code) return { text, changed: false }
  const reason = table[code]
  if (!reason) return { text, changed: false }

  return {
    text: `${text.slice(0, last.index)}(exit ${code} = ${reason} — the command's documented meaning; report it, don't re-investigate)\n${text.slice(last.index)}`,
    changed: true,
  }
}
