import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assembleReplanManifest, replanTruthPreserved, replanGoal, proposeReplan } from '../src/replan.mjs'

// --- Inc 3b: automate the re-decomposition PROPOSAL on a stall — proposer-only, HUMAN-ONLY acceptance, and the
// immutable GLOBAL held-out truth is CARRIED VERBATIM (a replan revises the decomposition, never the truth bar).
// a cross-model design review, Option B. proposeReplan NEVER runs converge; it returns a manifest for human review.

const PRIOR = {
  goal: 'achieve the feature',
  floor: { cmd: 'true', readOnly: ['package.json'] },
  global_budget_tokens: 1_000_000_000,
  objective_cap: 4,
  objectives: [{ id: 'old', goal: 'old way', scorer: 'node old/s.mjs', target: 90, editScope: 'old' }],
  global_held_out: [{ id: 'truth', scorer: 'node truth/t.mjs', target: 80 }],
}

test('assembleReplanManifest: carries goal/floor/caps/global_held_out, swaps ONLY the objectives', () => {
  const m = assembleReplanManifest(PRIOR, [{ id: 'new', goal: 'g', scorer: 'node new/s.mjs', target: 90, editScope: 'new' }])
  assert.equal(m.goal, PRIOR.goal)
  assert.deepEqual(m.floor, PRIOR.floor)
  assert.equal(m.objective_cap, 4)
  assert.equal(m.global_budget_tokens, 1_000_000_000)
  assert.deepEqual(m.global_held_out, PRIOR.global_held_out) // truth carried VERBATIM
  assert.deepEqual(m.objectives.map((o) => o.id), ['new']) // decomposition swapped
})

test('replanTruthPreserved: true when the held-out hash matches, false when a check is weakened/dropped', () => {
  const same = assembleReplanManifest(PRIOR, [{ id: 'new', goal: 'g', scorer: 'node new/s.mjs', target: 90, editScope: 'new' }])
  assert.equal(replanTruthPreserved(PRIOR, same), true)
  const weakened = { ...same, global_held_out: [{ id: 'truth', scorer: 'node truth/t.mjs', target: 10 }] }
  assert.equal(replanTruthPreserved(PRIOR, weakened), false)
  const dropped = { ...same, global_held_out: [] }
  assert.equal(replanTruthPreserved(PRIOR, dropped), false)
})

test('replanGoal: enriches the goal with the stall signal so the planner re-decomposes differently', () => {
  const g = replanGoal('achieve X', 'impossibility', 'binding stuck at 0')
  assert.match(g, /achieve X/)
  assert.match(g, /\[REPLAN\]/)
  assert.match(g, /impossibility/)
})

test('proposeReplan: invokes the planner with the enriched goal + prior floor, carries the truth, returns a PROPOSAL (never runs)', async () => {
  let seen = null
  const stubPlanManifest = async (cfg) => {
    seen = cfg
    return { manifest: { goal: cfg.goal, floor: cfg.floor, objectives: [{ id: 'new1', goal: 'g1', scorer: 'node sc/new1.mjs', target: 90, editScope: 'new1' }] }, report: { coverage_score: 50 }, spentUsd: 0, spentTokens: 0 }
  }
  const r = await proposeReplan(
    { priorManifest: PRIOR, scopeDir: 'repo', structuralSignal: 'impossibility', signalDetail: 'binding stuck' },
    { planManifest: stubPlanManifest, planCall: async () => '[]', allowlist: [] },
  )
  assert.match(seen.goal, /\[REPLAN\]/) // planner saw the enriched goal
  assert.match(seen.goal, /impossibility/)
  assert.deepEqual(seen.floor, PRIOR.floor) // prior floor passed through (never model-generated)
  assert.deepEqual(r.manifest.global_held_out, PRIOR.global_held_out) // truth carried verbatim
  assert.deepEqual(r.manifest.objectives.map((o) => o.id), ['new1'])
  assert.equal(r.accepted, false) // a PROPOSAL — never auto-applied
  assert.equal(r.report.replan_signal, 'impossibility')
})

test('proposeReplan: REFUSES a proposed decomposition whose editScope collides the held-out truth scorer', async () => {
  const stubPlanManifest = async (cfg) => ({ manifest: { goal: cfg.goal, floor: cfg.floor, objectives: [{ id: 'bad', goal: 'g', scorer: 'node truth/s.mjs', target: 90, editScope: 'truth' }] }, report: {}, spentUsd: 0, spentTokens: 0 })
  await assert.rejects(
    proposeReplan({ priorManifest: PRIOR, scopeDir: 'repo', structuralSignal: 'contradiction' }, { planManifest: stubPlanManifest, planCall: async () => '[]', allowlist: [] }),
    /editScope|held-out|convergeRefusal/,
  )
})
