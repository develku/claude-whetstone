import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureLoopDir, saveState, loadState, safeSnapshotPath } from '../src/state.mjs'

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
