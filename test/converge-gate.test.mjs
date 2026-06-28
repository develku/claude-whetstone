import { test } from 'node:test'
import assert from 'node:assert/strict'
import { globalVerdict, objectiveMet, objectiveScore, globalRegressed } from '../src/converge-gate.mjs'

// Track C global gate: CODE owns the repo-level stop over a VECTOR of objectives.
// globalVerdict mirrors gate.mjs precedence (floor-veto > error > done > capped > plateau > running)
// but is multi-objective: DONE = every objective MET (held-out confirm for judge-class, primary for
// deterministic) AND the deterministic floor held. It is PURE — stability + budget + regression-rollback
// are the orchestrator's job (mirroring how loop.mjs wraps the pure gateVerdict).

function obj(id, { target = 90, judgeClass = false, primary = null, confirm = null, met = false, pre = null } = {}) {
  return { id, target, judgeClass, primaryScore: primary, confirmScore: confirm, met, pre_integration_score: pre }
}

function gstate(objectives, overrides = {}) {
  return {
    objectives,
    floor: { cmd: 'npm test', last_score: 100 },
    global_pass: 0,
    global_cap: 10,
    global_plateau_window: 3,
    global_min_progress: 1,
    binding_history: [],
    ...overrides,
  }
}

// --- decision score: confirm for judge-class, primary for deterministic ---

test('objectiveScore reads the held-out confirm for a judge-class objective', () => {
  assert.equal(objectiveScore(obj('a', { judgeClass: true, primary: 95, confirm: 70 })), 70)
})

test('objectiveScore reads the primary for a deterministic objective', () => {
  assert.equal(objectiveScore(obj('a', { judgeClass: false, primary: 95, confirm: 70 })), 95)
})

test('objectiveMet uses the confirm not the primary for a judge objective (anti-gaming)', () => {
  // primary 95 >= target 90 would be "met", but the held-out confirm is 70 < 90 -> NOT met
  assert.equal(objectiveMet(obj('a', { judgeClass: true, target: 90, primary: 95, confirm: 70 })), false)
})

test('objectiveMet uses the primary for a deterministic objective (its scorer is ground truth)', () => {
  assert.equal(objectiveMet(obj('a', { judgeClass: false, target: 90, primary: 95 })), true)
})

test('objectiveMet is false when the decision score is invalid', () => {
  assert.equal(objectiveMet(obj('a', { judgeClass: false, target: 90, primary: null })), false)
  assert.equal(objectiveMet(obj('a', { judgeClass: false, target: 90, primary: NaN })), false)
})

// --- floor veto precedence (the §6.3 mandate) ---

test('floor veto: floor score 0 blocks even when EVERY objective is at target', () => {
  const g = gstate([obj('a', { confirm: 100, judgeClass: true, target: 90 })], { floor: { cmd: 'npm test', last_score: 0 } })
  assert.equal(globalVerdict(g).status, 'blocked')
})

test('floor veto beats error: floor 0 reported as blocked even with an invalid objective score', () => {
  const g = gstate([obj('a', { primary: NaN })], { floor: { cmd: 'npm test', last_score: 0 } })
  assert.equal(globalVerdict(g).status, 'blocked')
})

// --- error tier ---

test('error when an objective decision score is out of range / NaN', () => {
  assert.equal(globalVerdict(gstate([obj('a', { primary: 140 })])).status, 'error')
  assert.equal(globalVerdict(gstate([obj('a', { judgeClass: true, confirm: NaN })])).status, 'error')
})

// --- done: boolean-AND of MET on the held-out signal, NEVER MIN(scores) ---

test('done when every objective is met (differing targets) and the floor held', () => {
  const g = gstate([
    obj('a', { judgeClass: true, target: 80, confirm: 80 }),
    obj('b', { judgeClass: false, target: 100, primary: 100 }),
  ])
  assert.equal(globalVerdict(g).status, 'done')
})

test('done reason is honest: names DECLARED objectives, disclaims repo-goal sufficiency', () => {
  const g = gstate([obj('a', { judgeClass: false, target: 90, primary: 95 })])
  const v = globalVerdict(g)
  assert.equal(v.status, 'done')
  assert.match(v.reason, /DECLARED/)
  assert.match(v.reason, /NOT repo-goal sufficiency/)
})

test('NOT done with differing targets when one is unmet — never MIN>=min-target', () => {
  // confirm 80>=target 80 (met) but confirm 95 < target 100 (unmet). A MIN(80,95)=80>=80 reading would
  // wrongly pass; the boolean-AND of per-objective MET must read this as running.
  const g = gstate([
    obj('a', { judgeClass: true, target: 80, confirm: 80 }),
    obj('b', { judgeClass: true, target: 100, confirm: 95 }),
  ])
  assert.equal(globalVerdict(g).status, 'running')
})

// --- capping is GLOBAL-only: MET is the pure >= comparison, not a wrapped gateVerdict ---

test('done beats capped: all objectives met on the final allowed cycle is success', () => {
  const g = gstate([obj('a', { judgeClass: false, target: 90, primary: 95 })], { global_pass: 10, global_cap: 10 })
  assert.equal(globalVerdict(g).status, 'done')
})

test('an at-target objective is MET even at the global cap (capping is global-only, not per-objective)', () => {
  // proves MET does not wrap gateVerdict (which would import capped/plateau tiers per-objective)
  assert.equal(objectiveMet(obj('a', { judgeClass: false, target: 90, primary: 95 })), true)
})

test('capped when objectives remain below target and the global cap is reached', () => {
  const g = gstate([obj('a', { judgeClass: false, target: 90, primary: 60 })], { global_pass: 10, global_cap: 10 })
  assert.equal(globalVerdict(g).status, 'capped')
})

// --- global plateau over the binding (worst-unmet) score ---

test('plateau when the binding objective score has not improved across the window', () => {
  const g = gstate([obj('a', { judgeClass: false, target: 90, primary: 70 })], {
    binding_history: [50, 70, 70, 70, 70],
    global_plateau_window: 3,
  })
  assert.equal(globalVerdict(g).status, 'plateau')
})

test('running when the binding objective score is still climbing within the window', () => {
  const g = gstate([obj('a', { judgeClass: false, target: 90, primary: 86 })], {
    binding_history: [50, 70, 80, 82, 84, 86],
    global_plateau_window: 3,
  })
  assert.equal(globalVerdict(g).status, 'running')
})

test('running when objectives remain below target with cap and progress left', () => {
  const g = gstate([obj('a', { judgeClass: false, target: 90, primary: 60 })], { binding_history: [40, 50, 60] })
  assert.equal(globalVerdict(g).status, 'running')
})

test('every verdict carries a human-readable reason', () => {
  for (const g of [
    gstate([obj('a', { primary: 95 })]),
    gstate([obj('a', { primary: 60 })], { global_pass: 10, global_cap: 10 }),
    gstate([obj('a', { primary: NaN })]),
  ]) {
    const v = globalVerdict(g)
    assert.equal(typeof v.reason, 'string')
    assert.ok(v.reason.length > 0)
  }
})

// --- globalRegressed: the FULL-VECTOR monotonic guard (DCA refinement #1) ---

test('regressed when the deterministic floor failed', () => {
  assert.equal(globalRegressed([obj('a', { primary: 95, pre: 95 })], 0, 1), true)
})

test('regressed when a previously-MET objective falls below its target', () => {
  // a met objective at 100 drops to 91 with target 90: still >= target? 91>=90 true — NOT a target breach,
  // but it dropped 9 points which is > min_delta, so it regresses on the monotonic rule below.
  // Here test the strict target breach: met objective drops below target.
  const o = obj('a', { judgeClass: false, target: 90, primary: 85, met: true, pre: 100 })
  assert.equal(globalRegressed([o], 100, 1), true)
})

test('regressed when ANY objective drops more than min_delta below its pre-integration score (met 100->91, target 90)', () => {
  // the predicate gate.mjs-style "below target" MISSES this (91>=90); the full-vector rule catches the 9-pt drop
  const o = obj('a', { judgeClass: false, target: 90, primary: 91, met: true, pre: 100 })
  assert.equal(globalRegressed([o], 100, 1), true)
})

test('regressed when an UNMET objective drops more than min_delta below its pre-integration score (F2P frontier)', () => {
  const o = obj('a', { judgeClass: false, target: 90, primary: 50, met: false, pre: 70 })
  assert.equal(globalRegressed([o], 100, 1), true)
})

test('NOT regressed when an objective drops within min_delta of its pre-integration score', () => {
  const o = obj('a', { judgeClass: false, target: 90, primary: 69.5, met: false, pre: 70 })
  assert.equal(globalRegressed([o], 100, 1), false)
})

test('NOT regressed when scores hold or improve and the floor passed', () => {
  const objs = [
    obj('a', { judgeClass: false, target: 90, primary: 95, met: true, pre: 92 }),
    obj('b', { judgeClass: false, target: 90, primary: 70, met: false, pre: 60 }),
  ]
  assert.equal(globalRegressed(objs, 100, 1), false)
})
