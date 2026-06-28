import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  planSchemaValid,
  planTargetFloor,
  planNoJudgeScorer,
  planDataOnlyScorer,
  planObjectiveCount,
  planAllDropped,
  planEditScopeInRepo,
  planRefusal,
  MIN_TARGET,
  MAX_OBJECTIVES,
} from '../src/plan-refuse.mjs'

const proposal = { id: 'o1', goal: 'cover auth', scorerId: 'io-assert', args: ['--case', '1=>1'], editScope: 'src/auth', target: 80 }
// a resolved objective (post-fence shape): { id, goal, scorer, editScope, target }
const obj = (over = {}) => ({ id: 'o1', goal: 'g', scorer: "node '/abs/scorers/io-assert.mjs' '--case'", editScope: 'src/auth', target: 80, ...over })

// --- planSchemaValid (DROP guard) -------------------------------------------------------------------
test('planSchemaValid: a well-formed proposal passes', () => {
  assert.equal(planSchemaValid(proposal), true)
})

test('planSchemaValid: wrong types / missing fields / empties are dropped', () => {
  assert.equal(planSchemaValid({ ...proposal, id: '' }), false)
  assert.equal(planSchemaValid({ ...proposal, id: 42 }), false)
  assert.equal(planSchemaValid({ ...proposal, goal: 123 }), false)
  assert.equal(planSchemaValid({ ...proposal, scorerId: '' }), false)
  assert.equal(planSchemaValid({ ...proposal, args: 'nope' }), false)
  assert.equal(planSchemaValid({ ...proposal, args: ['ok', 5] }), false)
  assert.equal(planSchemaValid({ ...proposal, editScope: '   ' }), false)
  assert.equal(planSchemaValid(null), false)
  assert.equal(planSchemaValid([proposal]), false)
})

test('planSchemaValid: a non-number / NaN / Infinity target is dropped (closes the NaN<floor evasion)', () => {
  assert.equal(planSchemaValid({ ...proposal, target: 'high' }), false)
  assert.equal(planSchemaValid({ ...proposal, target: NaN }), false)
  assert.equal(planSchemaValid({ ...proposal, target: Infinity }), false)
})

test('planSchemaValid: an extra/injected key is dropped', () => {
  assert.equal(planSchemaValid({ ...proposal, cmd: 'rm -rf /' }), false)
  assert.equal(planSchemaValid({ ...proposal, confirmScorer: 'node x.mjs' }), false)
})

// --- planTargetFloor (REFUSE guard) -----------------------------------------------------------------
test('planTargetFloor: an objective below the floor refuses the whole run', () => {
  assert.match(planTargetFloor([obj({ target: 69 })]), /target/)
  assert.equal(planTargetFloor([obj({ target: 70 })]), null) // exactly the floor is allowed
  assert.equal(planTargetFloor([obj({ target: 95 })]), null)
})

test('planTargetFloor: a custom minTarget is honored', () => {
  assert.equal(planTargetFloor([obj({ target: 80 })], 85) === null, false)
  assert.equal(planTargetFloor([obj({ target: 85 })], 85), null)
})

test('planTargetFloor: a non-number target refuses (never silently passed via NaN<floor=false)', () => {
  assert.match(planTargetFloor([obj({ target: 'high' })]), /target/)
  assert.match(planTargetFloor([obj({ target: NaN })]), /target/)
})

// --- planNoJudgeScorer (REFUSE guard) ---------------------------------------------------------------
test('planNoJudgeScorer: a resolved judge-class scorer refuses (defense in depth)', () => {
  assert.match(planNoJudgeScorer([obj({ scorer: "node '/my/llm-judge-helper.mjs'" })]), /judge/i)
  assert.equal(planNoJudgeScorer([obj()]), null) // a data-only scorer is fine
})

// --- planDataOnlyScorer (REFUSE guard, re-assertion) ------------------------------------------------
test('planDataOnlyScorer: a resolved shell scorer that slipped through refuses', () => {
  assert.match(planDataOnlyScorer([obj({ scorer: "node '/x/test-pass-rate.mjs' '--cmd' 'sh'" })]), /shell|data-only/i)
  assert.match(planDataOnlyScorer([obj({ scorer: "node '/x/composite.mjs'" })]), /shell|data-only/i)
  assert.equal(planDataOnlyScorer([obj()]), null) // io-assert is data-only
})

test('planDataOnlyScorer: a data ARG that merely ends in .mjs does NOT false-positive (only the script slot counts)', () => {
  // io-assert does not execute its args — `contains/io-assert ... 'floor.mjs'` must not refuse the run (M1)
  assert.equal(planDataOnlyScorer([obj({ scorer: "node '/x/io-assert.mjs' '--needle' 'floor.mjs'" })]), null)
  assert.equal(planDataOnlyScorer([obj({ scorer: "node '/x/contains.mjs' 'test-pass-rate.mjs'" })]), null)
})

// --- planObjectiveCount (REFUSE guard) --------------------------------------------------------------
test('planObjectiveCount: a fan-out above the cap refuses; at the cap passes', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => obj({ id: `o${i}` }))
  assert.equal(planObjectiveCount(many(MAX_OBJECTIVES)), null)
  assert.match(planObjectiveCount(many(MAX_OBJECTIVES + 1)), /objectives|count|cap/i)
  assert.match(planObjectiveCount(many(3), 2), /objectives|count|cap/i)
})

// --- planAllDropped (REFUSE guard) ------------------------------------------------------------------
test('planAllDropped: an empty resolved set refuses, printing the rejected list', () => {
  const rejected = [{ id: 'a', reason: 'fence' }, { id: 'b', reason: 'schema' }]
  const r = planAllDropped([], rejected)
  assert.match(r, /dropped/i)
  assert.match(r, /a/)
  assert.match(r, /b/)
  assert.equal(planAllDropped([obj()], rejected), null) // at least one survived -> not all-dropped
})

// --- planEditScopeInRepo (REFUSE guard, auditable re-assertion) -------------------------------------
test('planEditScopeInRepo: a non-root in-repo scope passes; a root or escaping one refuses', () => {
  assert.equal(planEditScopeInRepo([obj({ editScope: 'src/auth' })], '/repo'), null)
  assert.match(planEditScopeInRepo([obj({ editScope: '' })], '/repo'), /editScope/)
  assert.match(planEditScopeInRepo([obj({ editScope: '.' })], '/repo'), /editScope/)
  assert.match(planEditScopeInRepo([obj({ editScope: '../etc' })], '/repo'), /editScope/)
})

// --- planRefusal (the aggregator) -------------------------------------------------------------------
test('planRefusal: returns null for a clean manifest', () => {
  assert.equal(planRefusal({ objectives: [obj()], rejected: [], scopeDir: '/repo' }), null)
})

test('planRefusal: a low-target gaming objective is refused at the target guard', () => {
  assert.match(planRefusal({ objectives: [obj({ target: 10 })], rejected: [], scopeDir: '/repo' }), /target/)
})

test('planRefusal: all-dropped is reported before the substantive guards', () => {
  const r = planRefusal({ objectives: [], rejected: [{ id: 'a', reason: 'fence' }], scopeDir: '/repo' })
  assert.match(r, /dropped/i)
})

test('planRefusal: a shell scorer that slipped the allowlist is refused at the data-only guard', () => {
  const sneaky = obj({ scorer: "node '/x/test-pass-rate.mjs' '--cmd' 'sh'" })
  assert.match(planRefusal({ objectives: [sneaky], rejected: [], scopeDir: '/repo' }), /shell|data-only/i)
})

test('planSchemaValid: a __proto__ key injected via JSON.parse is dropped', () => {
  const injected = JSON.parse('{"__proto__":{"x":1},"id":"o1","goal":"g","scorerId":"io-assert","args":[],"editScope":"src/a","target":80}')
  assert.equal(planSchemaValid(injected), false)
})

test('MIN_TARGET and MAX_OBJECTIVES carry the spec defaults', () => {
  assert.equal(MIN_TARGET, 70)
  assert.equal(MAX_OBJECTIVES, 12)
})
