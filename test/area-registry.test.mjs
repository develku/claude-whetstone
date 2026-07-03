import { test } from 'node:test'
import assert from 'node:assert/strict'
import { updateAreaRegistry, qualifyStale, renderTriedAreas, withAreaLedger } from '../src/area-registry.mjs'

// The fence-safe discard-memory: a code-owned registry of scorer-authored finding-areas, so the editor
// can be told which areas were ALREADY attacked with no score gain. CODE decides which areas qualify
// (numbers only: seen_count + best-score comparison); the area STRINGS themselves are scorer-authored
// (an indirect capture channel) so they render only inside a nonce fence — never the trusted region.

// --- updateAreaRegistry ---------------------------------------------------------------------------

test('a first sighting creates the entry with first/last pass and the best at first sighting', () => {
  const r = updateAreaRegistry([], [{ area: 'error handling' }], { pass: 1, best_score: 70 })
  assert.deepEqual(r, [{ area: 'error handling', first_pass: 1, last_pass: 1, seen_count: 1, best_at_first: 70 }])
})

test('a repeat sighting increments seen_count and moves last_pass but never best_at_first', () => {
  const r1 = updateAreaRegistry([], [{ area: 'x' }], { pass: 1, best_score: 70 })
  const r2 = updateAreaRegistry(r1, [{ area: 'x' }], { pass: 3, best_score: 75 })
  assert.deepEqual(r2, [{ area: 'x', first_pass: 1, last_pass: 3, seen_count: 2, best_at_first: 70 }])
})

test('duplicate areas within ONE findings array count once', () => {
  const r = updateAreaRegistry([], [{ area: 'x' }, { area: 'x' }, { area: 'y' }], { pass: 1, best_score: 50 })
  assert.equal(r.find((e) => e.area === 'x').seen_count, 1)
  assert.equal(r.length, 2)
})

test('malformed findings are skipped or coerced, never crash', () => {
  const r = updateAreaRegistry([], [null, {}, { area: '' }, { area: 42 }], { pass: 1, best_score: 50 })
  assert.deepEqual(r.map((e) => e.area), ['42']) // String coercion matches decompose.mjs's key
})

test('non-array registry/findings read as empty; non-finite pass/best stored as null', () => {
  assert.deepEqual(updateAreaRegistry(null, null, { pass: 1, best_score: 50 }), [])
  const r = updateAreaRegistry(undefined, [{ area: 'x' }], { pass: NaN, best_score: 'no' })
  assert.deepEqual(r, [{ area: 'x', first_pass: null, last_pass: null, seen_count: 1, best_at_first: null }])
})

test('updateAreaRegistry never mutates its inputs (immutability contract)', () => {
  const orig = [{ area: 'x', first_pass: 0, last_pass: 0, seen_count: 1, best_at_first: 50 }]
  const snapshot = JSON.parse(JSON.stringify(orig))
  updateAreaRegistry(orig, [{ area: 'x' }], { pass: 2, best_score: 60 })
  assert.deepEqual(orig, snapshot)
})

// --- qualifyStale ---------------------------------------------------------------------------------

const entry = (over = {}) => ({ area: 'x', first_pass: 1, last_pass: 2, seen_count: 2, best_at_first: 70, ...over })

test('an area seen twice with no best-score gain qualifies', () => {
  assert.deepEqual(qualifyStale([entry()], 70), [{ area: 'x', seen_count: 2, first_pass: 1 }])
})

test('does not qualify when seen once, when best improved, or when best_at_first is unknown', () => {
  assert.deepEqual(qualifyStale([entry({ seen_count: 1 })], 70), []) // one sighting is not a pattern
  assert.deepEqual(qualifyStale([entry()], 80), []) // best moved past best_at_first — progress happened
  assert.deepEqual(qualifyStale([entry({ best_at_first: null })], 70), []) // no baseline to compare
})

test('returns [] when best_score is not finite (early passes)', () => {
  assert.deepEqual(qualifyStale([entry()], null), [])
})

test('caps the list at 8 most-recently-seen entries', () => {
  const reg = Array.from({ length: 9 }, (_, i) => entry({ area: `a${i}`, last_pass: i }))
  const q = qualifyStale(reg, 70)
  assert.equal(q.length, 8)
  assert.equal(q[0].area, 'a8') // most-recent last_pass first
  assert.equal(q.find((e) => e.area === 'a0'), undefined) // the oldest dropped
})

// --- renderTriedAreas -----------------------------------------------------------------------------

test('renders one line per qualified area with the numbers', () => {
  const s = renderTriedAreas([{ area: 'error handling', seen_count: 3, first_pass: 1 }])
  assert.equal(s, '- error handling — attacked 3x since pass 1, best score unchanged')
})

test('returns null on an empty list (no fence block at all)', () => {
  assert.equal(renderTriedAreas([]), null)
})

test('collapses whitespace and truncates huge area strings at render only', () => {
  const huge = `a  b\nc${'x'.repeat(200)}`
  const s = renderTriedAreas([{ area: huge, seen_count: 2, first_pass: 0 }])
  assert.doesNotMatch(s, /\n.*x/) // newline collapsed
  assert.match(s, /a b c/) // whitespace-collapsed
  assert.ok(s.length < 180) // truncated
  assert.match(s, /…/)
})

// --- withAreaLedger (the ONE helper both persists call) --------------------------------------------

test('withAreaLedger threads the review findings into next.area_ledger', () => {
  const prev = { area_ledger: [] }
  const next = { pass: 1, best_score: 70 }
  const out = withAreaLedger(prev, next, { findings: [{ area: 'x' }] })
  assert.equal(out.pass, 1)
  assert.deepEqual(out.area_ledger, [{ area: 'x', first_pass: 1, last_pass: 1, seen_count: 1, best_at_first: 70 }])
})

test('withAreaLedger tolerates a pre-feature prev state and a findings-less review', () => {
  const out = withAreaLedger({}, { pass: 0, best_score: 50 }, { score: 50 })
  assert.deepEqual(out.area_ledger, [])
})
