import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { ensureLoopDir, saveState, loadState, safeSnapshotPath, initState, recordPass } from '../src/state.mjs'

// saveState is --resume's only durable input, so it writes atomically (temp file + rename).
// Guard: the content round-trips and no state.json.tmp is left behind — a regression that wrote
// the temp file but forgot to rename would fail loadState (no state.json) here.
test('saveState round-trips and leaves no .tmp behind', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'whetstone-state-')), '.loop')
  ensureLoopDir(dir)
  const state = { goal: 'g', pass: 2, spent_usd: 0.4, history: [{ pass: 0, score: 50 }] }
  saveState(dir, state)
  assert.deepEqual(loadState(dir), state)
  assert.equal(existsSync(join(dir, 'state.json.tmp')), false)
})

test('ensureLoopDir drops a self-ignoring .gitignore so a run dir is never committed', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'whetstone-state-')), 'runs', 'job1')
  ensureLoopDir(dir)
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8').trim(), '*')
})

test('saveState redacts secrets before they land in state.json', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'whetstone-state-')), '.loop')
  ensureLoopDir(dir)
  saveState(dir, { goal: 'g', last_critique: 'leaked sk-ant-api03-AbCdEf123456 in output', history: [] })
  const raw = readFileSync(join(dir, 'state.json'), 'utf8')
  assert.doesNotMatch(raw, /sk-ant/)
  assert.match(raw, /\[REDACTED\]/)
})

test('safeSnapshotPath accepts an internal ref and rejects traversal/absolute refs', () => {
  const dir = '/tmp/whetstone-run/.loop'
  assert.ok(safeSnapshotPath(dir, 'snapshots/iter_000.txt').endsWith('/snapshots/iter_000.txt'))
  assert.throws(() => safeSnapshotPath(dir, '../../../../etc/passwd'), /escapes/)
  assert.throws(() => safeSnapshotPath(dir, '/etc/passwd'), /escapes/)
})

// Token budget is a second, parallel cost dial to spent_usd — initialized and accumulated the same way.
const newState = (over = {}) => initState({ goal: 'g', artifactPath: 'a', scorerCmd: 's', ...over })

test('initState defaults budget_tokens to null and spent_tokens to 0', () => {
  const s = newState()
  assert.equal(s.budget_tokens, null)
  assert.equal(s.spent_tokens, 0)
})

test('initState carries a budget_tokens override', () => {
  assert.equal(newState({ budgetTokens: 500000 }).budget_tokens, 500000)
})

test('recordPass accumulates spent_tokens and tolerates a pre-feature state without it', () => {
  let s = newState()
  s = recordPass(s, { score: 50, tokens: 1000 })
  assert.equal(s.spent_tokens, 1000)
  s = recordPass(s, { score: 60, tokens: 250 })
  assert.equal(s.spent_tokens, 1250)
  // a state.json written before this feature has no spent_tokens -> it must read as 0, not NaN
  const old = { ...s, spent_tokens: undefined }
  assert.equal(recordPass(old, { score: 70, tokens: 5 }).spent_tokens, 5)
})

// The editor runs in dirname(artifact_path) and snapshot/restore/evaluate copy it; a RELATIVE
// artifact_path resolves against whatever cwd the driver (or a later --resume) runs from, so a
// resume from another dir reads/writes the wrong file. Resolve it to absolute once, at init.
test('initState resolves a relative artifact_path to absolute (cwd-stable across a resume)', () => {
  const s = initState({ goal: 'g', artifactPath: 'sub/art.txt', scorerCmd: 's' })
  assert.ok(isAbsolute(s.artifact_path), `expected absolute, got ${s.artifact_path}`)
  assert.match(s.artifact_path, /sub\/art\.txt$/)
})

test('initState leaves an already-absolute artifact_path unchanged', () => {
  assert.equal(initState({ goal: 'g', artifactPath: '/abs/art.txt', scorerCmd: 's' }).artifact_path, '/abs/art.txt')
})
