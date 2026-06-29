import { test } from 'node:test'
import assert from 'node:assert/strict'
import { replanWorthy, runOuterLoop } from '../src/outer.mjs'

// --- the OUTER LOOP: connect Inc 2 (structural-feedback detect) -> Inc 3b (re-decomposition propose). It runs
// the inner converge; on a replan-WORTHY stall it emits a re-decomposition PROPOSAL for human review. It NEVER
// accepts/runs the proposal — acceptance stays the human's (the second permanently-human atom). Pure-composition,
// deps-injected, $0-testable.

test('replanWorthy: only decomposition-insufficiency signals warrant a replan', () => {
  assert.equal(replanWorthy('impossibility'), true)
  assert.equal(replanWorthy('contradiction'), true)
  assert.equal(replanWorthy('held_out_fail'), true)
  assert.equal(replanWorthy('plateau'), false) // a soft stall, not a wrong-decomposition signal
  assert.equal(replanWorthy(null), false)
  assert.equal(replanWorthy(undefined), false)
})

const MANIFEST = { goal: 'g', floor: { cmd: 'true' }, objectives: [{ id: 'a', editScope: 'a' }], global_held_out: [{ id: 't', scorer: 'node t.mjs', target: 80 }] }
const baseCfg = (over = {}) => ({ manifest: MANIFEST, scopeDir: 'repo', proposeOnStall: true, proposalOut: '/out/proposal.json', ...over })

test('runOuterLoop: a converged inner run emits NO proposal', async () => {
  let proposed = 0, wrote = 0
  const r = await runOuterLoop(baseCfg(), {
    runConverge: async () => ({ state: { structural_signal: null }, verdict: { status: 'done', reason: 'all met' } }),
    proposeReplan: async () => { proposed++; return { manifest: {}, report: {} } },
    writeProposal: () => { wrote++ },
  })
  assert.equal(r.verdict.status, 'done')
  assert.equal(r.proposal, null)
  assert.equal(proposed, 0)
  assert.equal(wrote, 0)
})

test('runOuterLoop: a replan-worthy stall emits a PROPOSAL (written, NOT run)', async () => {
  let convergeCalls = 0, wrote = null
  const r = await runOuterLoop(baseCfg(), {
    runConverge: async () => { convergeCalls++; return { state: { structural_signal: 'held_out_fail' }, verdict: { status: 'capped', reason: 'decomposition insufficient' } } },
    proposeReplan: async (cfg) => { assert.equal(cfg.structuralSignal, 'held_out_fail'); return { manifest: { goal: 'g', objectives: [{ id: 'new', editScope: 'new' }], global_held_out: MANIFEST.global_held_out }, report: { coverage_score: 50 } } },
    writeProposal: (path, m) => { wrote = { path, m } },
  })
  assert.equal(r.verdict.status, 'capped')
  assert.ok(r.proposal)
  assert.equal(r.proposal.path, '/out/proposal.json')
  assert.deepEqual(r.proposal.manifest.objectives.map((o) => o.id), ['new'])
  assert.equal(wrote.path, '/out/proposal.json') // the proposal was WRITTEN
  assert.equal(convergeCalls, 1) // the inner run ran ONCE; the proposal was NOT run (no second converge)
})

test('runOuterLoop: a non-worthy stall (plateau) emits NO proposal', async () => {
  let proposed = 0
  const r = await runOuterLoop(baseCfg(), {
    runConverge: async () => ({ state: { structural_signal: 'plateau' }, verdict: { status: 'plateau', reason: 'stalled' } }),
    proposeReplan: async () => { proposed++; return { manifest: {}, report: {} } },
    writeProposal: () => {},
  })
  assert.equal(r.proposal, null)
  assert.equal(proposed, 0)
  assert.match(r.reason, /plateau/)
})

test('runOuterLoop: proposeOnStall OFF emits NO proposal even on a worthy signal', async () => {
  let proposed = 0
  const r = await runOuterLoop(baseCfg({ proposeOnStall: false }), {
    runConverge: async () => ({ state: { structural_signal: 'impossibility' }, verdict: { status: 'capped', reason: 'x' } }),
    proposeReplan: async () => { proposed++; return { manifest: {}, report: {} } },
    writeProposal: () => {},
  })
  assert.equal(r.proposal, null)
  assert.equal(proposed, 0)
})
