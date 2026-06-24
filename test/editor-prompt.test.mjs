import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildEditorPrompt, buildClaudeArgs } from '../src/act-claude.mjs'

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

test('buildClaudeArgs passes --effort through when set, omits it when null', () => {
  // effort is a first-class strength lever (a high-effort model behaves like a different product),
  // so the editor must be able to set it per call — cheap/baseline on forward passes, higher on rescue.
  const withEffort = buildClaudeArgs({ prompt: 'p', model: 'opus', effort: 'high' })
  assert.ok(withEffort.includes('--effort'))
  assert.equal(withEffort[withEffort.indexOf('--effort') + 1], 'high')
  assert.ok(withEffort.includes('--model'))
  assert.ok(withEffort.includes('-p'))
  const noEffort = buildClaudeArgs({ prompt: 'p' })
  assert.ok(!noEffort.includes('--effort'))
})

test('an escalated pass switches to a bolder RESCUE briefing (strategy, not just a bigger model)', () => {
  // The whole point of escalation: a cheaper model plateaued, so the strong editor must change the
  // EDIT STRATEGY (be bolder / reconsider the approach), not make a pricier version of the same
  // local edit. Triggered by state.escalated, which the loop sets when it escalates.
  const base = { goal: 'g', last_critique: 'fix it', best_score: 70, history: [{ pass: 0, score: 50 }, { pass: 1, score: 70 }] }
  const normal = buildEditorPrompt(base, '/x/art.txt')
  const rescue = buildEditorPrompt({ ...base, escalated: true }, '/x/art.txt')
  assert.doesNotMatch(normal, /rescue|plateaued|bolder/i)
  assert.match(rescue, /rescue|plateaued|bolder|different approach/i)
  assert.match(rescue, /BEGIN CRITIQUE/) // still fences the untrusted critique
  assert.match(rescue, /edit ONLY/i) // still scoped to the one artifact (blast radius preserved)
})
