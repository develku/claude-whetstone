import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureLoopDir, saveState, loadState } from '../src/state.mjs'

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
