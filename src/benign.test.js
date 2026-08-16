// Unit tests for the pure benign-exit logic. Run with `node --test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { annotateBenignExit, parseLeadingCommand } from './benign.js'

const EXIT1 = 'output\n\n[exit code: 1]'
const EXIT2 = 'output\n\n[exit code: 2]'
const EXIT0 = 'output\n\n[exit code: 0]'

// --- parser ---

test('parse: grep is identified', () => {
  assert.deepEqual(parseLeadingCommand('grep TODO src/index.js'), { base: 'grep', flags: ['TODO', 'src/index.js'] })
})

test('parse: git diff only when --exit-code present', () => {
  assert.equal(parseLeadingCommand('git diff HEAD HEAD~1'), null)
  assert.equal(parseLeadingCommand('git diff --exit-code HEAD HEAD~1')?.base, 'git diff')
  assert.equal(parseLeadingCommand('git diff --quiet')?.base, 'git diff')
})

test('parse: git grep identified', () => {
  assert.equal(parseLeadingCommand('git grep FIXME src')?.base, 'git grep')
})

test('parse: wrapper unwrapping (bash -c, sudo, env, timeout)', () => {
  assert.equal(parseLeadingCommand("bash -c 'grep foo file'")?.base, 'grep')
  assert.equal(parseLeadingCommand("sh -c \"rg bar dir\"")?.base, 'rg')
  assert.equal(parseLeadingCommand('sudo grep foo /etc/passwd')?.base, 'grep')
  assert.equal(parseLeadingCommand('env FOO=1 grep foo file')?.base, 'grep')
  assert.equal(parseLeadingCommand('timeout 10s grep foo file')?.base, 'grep')
  assert.equal(parseLeadingCommand('FOO=1 BAR=2 env grep foo file')?.base, 'grep')
})

test('parse: compound commands rejected (exit code is ambiguous)', () => {
  assert.equal(parseLeadingCommand('grep foo a | grep bar'), null)
  assert.equal(parseLeadingCommand('grep foo a && echo yes'), null)
  assert.equal(parseLeadingCommand('grep foo a || echo no'), null)
  assert.equal(parseLeadingCommand('grep foo a; echo done'), null)
  assert.equal(parseLeadingCommand('if grep -q foo a; then echo x; fi'), null)
  assert.equal(parseLeadingCommand('$(grep foo a)'), null)
  assert.equal(parseLeadingCommand('(cd /tmp && grep foo a)'), null)
})

test('parse: fd redirects still allowed', () => {
  assert.equal(parseLeadingCommand('grep foo file 2>&1')?.base, 'grep')
  assert.equal(parseLeadingCommand('grep foo file 2>/dev/null')?.base, 'grep')
  assert.equal(parseLeadingCommand('grep foo file >/dev/null 2>&1')?.base, 'grep')
})

test('parse: explicit paths and scripts are unknown', () => {
  assert.equal(parseLeadingCommand('./script.sh foo'), null)
  assert.equal(parseLeadingCommand('/usr/bin/grep foo file'), null)
})

test('parse: command -v is meaningful, command SUBCOMMAND is not', () => {
  assert.equal(parseLeadingCommand('command -v node')?.base, 'command-v')
  assert.equal(parseLeadingCommand('command -v node')?.base === 'command-v', true)
  assert.equal(parseLeadingCommand('command ls'), null)
})

test('parse: test and [ are identified', () => {
  assert.equal(parseLeadingCommand('test -f package.json')?.base, 'test')
  assert.equal(parseLeadingCommand('[ -f package.json ]')?.base, '[')
})

test('parse: wrapper option forms (sudo -u, sudo -E, env -i, nice)', () => {
  assert.equal(parseLeadingCommand('sudo -u deploy grep foo file')?.base, 'grep')
  assert.equal(parseLeadingCommand('sudo -E grep foo file')?.base, 'grep')
  assert.equal(parseLeadingCommand('env -i grep foo file')?.base, 'grep')
  assert.equal(parseLeadingCommand('nice -n 5 grep foo file')?.base, 'grep')
})

test('parse: timeout flag forms', () => {
  assert.equal(parseLeadingCommand('timeout -k 1 10 grep foo file')?.base, 'grep')
  assert.equal(parseLeadingCommand('timeout --signal=KILL 5m grep foo file')?.base, 'grep')
  assert.equal(parseLeadingCommand('timeout 10s grep foo file')?.base, 'grep')
})

test('parse: git -C and --no-pager before subcommand', () => {
  assert.equal(parseLeadingCommand('git -C repo diff --exit-code HEAD')?.base, 'git diff')
  assert.equal(parseLeadingCommand('git --no-pager grep FIXME src')?.base, 'git grep')
})

test('annotate: jq --exit-status works like -e', () => {
  const r = annotateBenignExit(EXIT1, "jq --exit-status '.foo' x.json")
  assert.equal(r.changed, true)
})

// --- annotation ---

test('annotate: grep exit 1 → marked benign', () => {
  const r = annotateBenignExit(EXIT1, 'grep TODO src/index.js')
  assert.equal(r.changed, true)
  // Annotation sits ABOVE the marker; the marker stays the literal last line.
  assert.match(r.text, /\(benign: no matching lines — expected, not a failure\)\n\[exit code: 1\]$/)
})

test('annotate: marker text itself is never rewritten (UI exit-status contract)', () => {
  const r = annotateBenignExit('out\n\n[exit code: 1]', 'grep foo file')
  assert.match(r.text, /\n\[exit code: 1\]$/)
})

test('annotate: grep exit 2 (real error) untouched', () => {
  const r = annotateBenignExit(EXIT2, 'grep foo /missing/file')
  assert.equal(r.changed, false)
  assert.equal(r.text, EXIT2)
})

test('annotate: exit 0 untouched', () => {
  const r = annotateBenignExit(EXIT0, 'grep foo file')
  assert.equal(r.changed, false)
})

test('annotate: unknown command untouched', () => {
  const r = annotateBenignExit(EXIT1, 'node script.js')
  assert.equal(r.changed, false)
  assert.equal(r.text, EXIT1)
})

test('annotate: git diff --exit-code exit 1 → benign', () => {
  const r = annotateBenignExit(EXIT1, 'git diff --exit-code HEAD HEAD~1')
  assert.equal(r.changed, true)
  assert.match(r.text, /benign: differences exist/)
})

test('annotate: git diff without --exit-code untouched', () => {
  const r = annotateBenignExit(EXIT1, 'git diff HEAD HEAD~1')
  assert.equal(r.changed, false)
})

test('annotate: git grep exit 1 → benign', () => {
  const r = annotateBenignExit(EXIT1, 'git grep FIXME src')
  assert.equal(r.changed, true)
})

test('annotate: which not-found → benign (informational)', () => {
  const r = annotateBenignExit(EXIT1, 'which nonexistent-tool')
  assert.equal(r.changed, true)
  assert.match(r.text, /benign: not found/)
})

test('annotate: jq needs -e; without it untouched', () => {
  assert.equal(annotateBenignExit(EXIT1, "jq '.foo' x.json").changed, false)
  const r = annotateBenignExit(EXIT1, "jq -e '.foo' x.json")
  assert.equal(r.changed, true)
})

test('annotate: pipeline / compound never annotated', () => {
  assert.equal(annotateBenignExit(EXIT1, 'grep foo a | grep bar').changed, false)
  assert.equal(annotateBenignExit(EXIT1, 'grep foo a && echo yes').changed, false)
})

test('annotate: bash -c wrapper unwraps to grep', () => {
  const r = annotateBenignExit(EXIT1, "bash -c 'grep foo file'")
  assert.equal(r.changed, true)
  assert.match(r.text, /benign: no matching lines/)
})

test('annotate: idempotent — already-annotated marker untouched', () => {
  const once = annotateBenignExit(EXIT1, 'grep foo file')
  const twice = annotateBenignExit(once.text, 'grep foo file')
  assert.equal(twice.changed, false)
  assert.equal(twice.text, once.text)
})

test('annotate: multiple markers — only the LAST (real) marker changes', () => {
  const r = annotateBenignExit('a\n[exit code: 2]\nb\n[exit code: 1]', 'grep foo file')
  assert.equal(r.changed, true)
  assert.match(r.text, /\[exit code: 2\]/)
  assert.match(r.text, /benign: no matching lines/)
})

test('annotate: literal marker inside content is NOT annotated — only trailing real marker', () => {
  const r = annotateBenignExit('line [exit code: 1] from file\n\n[exit code: 1]', 'grep foo file')
  assert.equal(r.changed, true)
  assert.equal(r.text.split('benign:').length, 2) // exactly one annotation
  assert.match(r.text, /line \[exit code: 1\] from file/) // content line untouched
})

test('annotate: if the REAL (last) exit is an error, nothing is annotated', () => {
  const r = annotateBenignExit('matched [exit code: 1]\n\n[exit code: 2]', 'grep foo file')
  assert.equal(r.changed, false)
})

test('annotate: no marker → untouched', () => {
  const r = annotateBenignExit('plain text output', 'grep foo file')
  assert.equal(r.changed, false)
})

test('annotate: extraRules extend the table', () => {
  const r = annotateBenignExit(EXIT1, 'mytool run', [{
    command: 'mytool', exitCodes: [1], reason: 'no changes to apply',
  }])
  assert.equal(r.changed, true)
  assert.match(r.text, /benign: no changes to apply/)
})

test('annotate: expectedExitCode mismatch prevents annotation', () => {
  // exit-0 run whose output merely contains "[exit code: 1]" — no annotation.
  const r = annotateBenignExit('match line\n[exit code: 1]', 'grep foo file', [], 0)
  assert.equal(r.changed, false)
})

test('annotate: expectedExitCode agreement annotates', () => {
  const r = annotateBenignExit('(no output)\n[exit code: 1]', 'grep foo file', [], 1)
  assert.equal(r.changed, true)
})

test('annotate: non-integer extra exit codes are ignored', () => {
  const r = annotateBenignExit(EXIT1, 'mytool run', [{
    command: 'mytool', exitCodes: [1.5, -3, NaN, 1], reason: 'edge',
  }])
  assert.equal(r.changed, true)
  assert.match(r.text, /benign: edge/)
})

test('annotate: extraRules cannot override a REAL error for grep', () => {
  // grep exit 2 is a real failure; an extra rule must not mask it.
  const r = annotateBenignExit(EXIT2, 'grep foo file', [{
    command: 'grep', exitCodes: [2], reason: 'deliberately masked',
  }])
  assert.equal(r.changed, false)
})

test('annotate: empty/undefined inputs are safe', () => {
  assert.equal(annotateBenignExit('', 'grep foo').changed, false)
  assert.equal(annotateBenignExit(undefined, 'grep foo').changed, false)
  assert.equal(annotateBenignExit(EXIT1, '').changed, false)
  assert.equal(annotateBenignExit(EXIT1, undefined).changed, false)
})
