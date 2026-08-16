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
  'command-v': { 1: 'not found' },
  jq: { 1: 'filter evaluated to false or null' },
  'git grep': { 1: 'no matching lines' },
  // git diff / git diff-index are only annotated when the caller used
  // --exit-code / --quiet; parseLeadingCommand gates on that.
  'git diff': { 1: 'differences exist' },
  'git diff-index': { 1: 'differences exist' },
}

const SHELL_WRAPPER = /^(?:bash|sh|zsh|dash)(?:\s+-[a-zA-Z]+)*\s+-c\s+([\s\S]*)$/

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
    if (ch === '<' && cmd[i + 1] === '<') return true // heredoc / here-string
    if (ch === '&') {
      // Allow fd redirects (2>&1, >&2) and the &> combined redirect; reject
      // everything else (backgrounding &&, &, ||).
      const prevPrev = cmd[i - 2]
      const prev = cmd[i - 1]
      const next = cmd[i + 1]
      if (next === '>') continue // &> combined redirect
      if (prev === '>' && /\d/.test(prevPrev ?? '')) continue // 2>&1
      if (prev === '>' && /\d/.test(next ?? '')) continue // >&2
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

function stripOuterQuotes(s) {
  const t = s.trim()
  if (t.length >= 2 && ((t[0] === "'" && t[t.length - 1] === "'") || (t[0] === '"' && t[t.length - 1] === '"'))) {
    return t.slice(1, -1)
  }
  return t
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

  // Strip leading environment assignments (FOO=1 BAR=2 cmd ...) and
  // privilege / no-op wrappers (sudo, nohup, env, nice) with their common
  // option forms, in any interleaving. `command -v` is handled later because
  // it is itself a meaningful leading command (exit 1 = not found).
  for (let i = 0; i < 8; i++) {
    const assign = cmd.match(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/)
    if (assign) { cmd = cmd.slice(assign[0].length); continue }
    // Option parsing is conservative: only options known to TAKE A VALUE
    // consume one. A generic `-\w+\s*\S*` form would greedily swallow the
    // command itself (e.g. `sudo -E grep foo` → "grep" as -E's value), which
    // can misidentify the real command — a false-positive risk, not just a
    // miss. `-u` (sudo) and `-u`/`-C` (env) are the common value-taking ones.
    const sudo = cmd.match(/^sudo(?:\s+-u\s+\S+|\s+-[A-Za-z])*\s+/)
    if (sudo) { cmd = cmd.slice(sudo[0].length); continue }
    const envW = cmd.match(/^env(?:\s+-u\s+\S+|\s+-C\s+\S+|\s+-[A-Za-z])*\s+/)
    if (envW) { cmd = cmd.slice(envW[0].length); continue }
    const nice = cmd.match(/^nice(?:\s+-n\s+\d+(?:\.\d+)?)?\s+/)
    if (nice) { cmd = cmd.slice(nice[0].length); continue }
    const nohup = cmd.match(/^nohup\s+/)
    if (nohup) { cmd = cmd.slice(nohup[0].length); continue }
    break
  }

  // Strip `timeout [opts] DURATION cmd ...` (flags and duration in any form).
  // The main duration is the LAST token that looks like a duration; anything
  // after it is the real command.
  if (/^timeout\b/.test(cmd)) {
    const rest = cmd.slice('timeout'.length).trimStart()
    const toks = rest.split(/\s+/)
    let durationIdx = -1
    for (let i = toks.length - 1; i >= 0; i--) {
      if (/^\d+(?:\.\d+)?[smhd]?$/.test(toks[i])) { durationIdx = i; break }
    }
    if (durationIdx >= 0 && durationIdx < toks.length - 1) {
      cmd = toks.slice(durationIdx + 1).join(' ')
    } else {
      return null // ambiguous timeout form — treat as unknown
    }
  }

  // Unwrap `sh -c '...'` / `bash -c "..."` — the inner command's exit code is
  // what the shell reports, so it is safe (and useful) to inspect the inner
  // leading command.
  const shell = cmd.match(SHELL_WRAPPER)
  if (shell) {
    return parseLeadingCommand(stripOuterQuotes(shell[1]), depth + 1)
  }

  const tokens = firstTokens(cmd, 12)
  if (tokens.length === 0) return null

  const first = tokens[0]
  if (first.includes('/')) return null // explicit path — could be any script

  if (first === 'command') {
    if (tokens[1] === '-v') return { base: 'command-v', flags: [] }
    return null // command SUBCOMMAND — treat as unknown
  }

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
  if (text.includes('(benign:')) return { text, changed: false } // idempotent
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
    text: `${text.slice(0, last.index)}(benign: ${reason} — expected, not a failure)\n${text.slice(last.index)}`,
    changed: true,
  }
}
