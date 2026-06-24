import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildEditorPrompt } from '../src/act-claude.mjs'

// The editor prompt is built purely from state so it can be unit-tested without spawning claude.
// It must carry: the goal, the critique FENCED as untrusted data, and — once there is a trajectory
// — the code-owned ledger (trusted) so the editor stops repeating failed edits.

test('includes the goal, the fenced critique, and the ledger once a trajectory exists', () => {
  const state = {
    goal: 'raise the score',
    last_critique: 'fix the empty-input case',
    best_score: 70,
    history: [{ pass: 0, score: 50 }, { pass: 1, score: 70 }],
  }
  const p = buildEditorPrompt(state, '/x/art.txt')
  assert.match(p, /raise the score/)
  assert.match(p, /BEGIN CRITIQUE/) // critique fenced as untrusted data
  assert.match(p, /fix the empty-input case/)
  assert.match(p, /Score trajectory/) // ledger present (two scored passes)
  assert.match(p, /\+20/)
})

test('omits the ledger before two scores exist, without crashing, and still fences a default critique', () => {
  const state = { goal: 'g', last_critique: null, best_score: null, history: [] }
  const p = buildEditorPrompt(state, '/x/art.txt')
  assert.doesNotMatch(p, /Score trajectory/)
  assert.match(p, /BEGIN CRITIQUE/)
})
