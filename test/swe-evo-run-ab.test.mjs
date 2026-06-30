// test/swe-evo-run-ab.test.mjs
// The one pure piece of the real feasibility CLI: reading a scope-loop state.json into an arm result.
// The rest of run-ab.mjs (docker-cp checkout, spawn scope-cli, offline C/T grading) is Docker/editor
// integration, exercised by the feasibility dry-run, not $0.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArmResult, auditVerdict, sealStateMismatch } from '../bench/swe-evo/run-ab.mjs'

test('parseArmResult reads V (best score), tokens, usd, a veto flag, and status/error from state.json', () => {
  const r = parseArmResult({ best_score: 100, spent_tokens: 12345, spent_usd: 0.34, confirm_vetoed_at_pass: 3, status: 'done' })
  assert.deepEqual(r, { V: 100, veto: 1, tokens: 12345, usd: 0.34, status: 'done', error: null })
})

test('parseArmResult: no veto -> 0; missing token/usd -> 0; missing score -> null; missing status -> null', () => {
  assert.deepEqual(parseArmResult({ best_score: 50, confirm_vetoed_at_pass: null }), { V: 50, veto: 0, tokens: 0, usd: 0, status: null, error: null })
  assert.deepEqual(parseArmResult({}), { V: null, veto: 0, tokens: 0, usd: 0, status: null, error: null })
})

test('parseArmResult surfaces the status_reason as error only when status is error', () => {
  const r = parseArmResult({ best_score: 0, status: 'error', status_reason: 'editor claude exited 1: subtype=error_during_execution' })
  assert.equal(r.status, 'error')
  assert.match(r.error, /error_during_execution/)
})

// auditVerdict is the guard against a transient masquerading as a finding: an errored arm (the editor
// never produced a measurable result) must NEVER be counted as "0 opportunities" — that would mislabel a
// rate-limit/transient as "underpowered" and could wrongly kill the whole 4xN experiment.
test('auditVerdict partitions errored vs valid and computes opportunities over VALID rows only', () => {
  const rows = [
    { instance_id: 'a', arm: 'baseline', V: 100, C: 100, T: 50, status: 'done' }, // valid, opportunity (T<100)
    { instance_id: 'b', arm: 'baseline', V: 100, C: 100, T: 100, status: 'done' }, // valid, no opportunity
    { instance_id: 'c', arm: 'baseline', V: 0, C: 0, T: 0, status: 'error', error: 'boom' }, // errored, excluded
  ]
  const v = auditVerdict(rows)
  assert.equal(v.errored.length, 1)
  assert.equal(v.valid.length, 2)
  assert.equal(v.vpass.length, 2)
  assert.equal(v.opportunities.length, 1)
  assert.equal(v.invalid, false)
})

test('auditVerdict: an unmeasured (null) held-out metric does NOT fabricate an opportunity', () => {
  // null < 100 is true in JS — guard against it. V-pass with C=null and T=100 is NOT an opportunity.
  const v = auditVerdict([{ instance_id: 'a', arm: 'baseline', V: 100, C: null, T: 100, status: 'done' }])
  assert.equal(v.vpass.length, 1)
  assert.equal(v.opportunities.length, 0)
})

test('auditVerdict flags an all-errored run as INVALID (not underpowered)', () => {
  const rows = [
    { instance_id: 'a', arm: 'baseline', V: 0, C: 0, T: 0, status: 'error', error: 'limit' },
    { instance_id: 'b', arm: 'baseline', V: 0, C: 0, T: 0, status: 'error', error: 'limit' },
  ]
  const v = auditVerdict(rows)
  assert.equal(v.valid.length, 0)
  assert.equal(v.invalid, true)
  assert.equal(v.opportunities.length, 0)
})

// sealStateMismatch guards a reused (cached) --work dir: a checkout sealed under one setting must not be
// reused under the opposite one, or the seal is silently defeated (unsealed reuse under --sealed) or the
// editor reset breaks (sealed reuse under no --sealed). No checkout (fresh materialize) is never a mismatch.
test('sealStateMismatch: a fresh materialize (no checkout) is never a mismatch', () => {
  assert.equal(sealStateMismatch(false, false, true), false) // about to extract+seal
  assert.equal(sealStateMismatch(false, false, false), false) // about to extract unsealed
})

test('sealStateMismatch: a cached checkout reused under the SAME sealed setting is fine (resume)', () => {
  assert.equal(sealStateMismatch(true, true, true), false) // sealed checkout, sealed run
  assert.equal(sealStateMismatch(true, false, false), false) // unsealed checkout, unsealed run
})

test('sealStateMismatch: reusing a checkout under the OPPOSITE sealed setting is a mismatch (must throw)', () => {
  assert.equal(sealStateMismatch(true, false, true), true) // UNSEALED checkout reused with --sealed -> silent leak
  assert.equal(sealStateMismatch(true, true, false), true) // SEALED checkout reused without --sealed -> reset breaks
})
