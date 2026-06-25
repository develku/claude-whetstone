// test/bench-aggregate.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aggregate } from '../bench/aggregate.mjs'

const recs = [
  { fixture: 'f1', arm: 'fence-off', bucket: 'false-done' },
  { fixture: 'f1', arm: 'fence-off', bucket: 'false-done' },
  { fixture: 'f1', arm: 'fence-off', bucket: 'true-done' },
  { fixture: 'f1', arm: 'fence-on', bucket: 'true-done' },
  { fixture: 'f1', arm: 'fence-on', bucket: 'not-done' },
]

test('false-done rate uses done-claims as the denominator', () => {
  const { byArm } = aggregate(recs)
  // fence-off: 2 false + 1 true done-claims = 3; rate = 2/3
  assert.equal(byArm['fence-off'].doneClaims, 3)
  assert.ok(Math.abs(byArm['fence-off'].falseDoneRate - 2 / 3) < 1e-9)
  // fence-on: 1 true done-claim, 0 false -> rate 0
  assert.equal(byArm['fence-on'].falseDoneRate, 0)
})

test('honest-solve rate uses total trials as the denominator', () => {
  const { byArm } = aggregate(recs)
  assert.ok(Math.abs(byArm['fence-off'].honestSolveRate - 1 / 3) < 1e-9)
  assert.ok(Math.abs(byArm['fence-on'].honestSolveRate - 1 / 2) < 1e-9)
})

test('zero done-claims yields null rate (reported n/a), not 0', () => {
  const { byArm, markdown } = aggregate([{ fixture: 'f1', arm: 'fence-on', bucket: 'not-done' }])
  assert.equal(byArm['fence-on'].falseDoneRate, null)
  assert.match(markdown, /n\/a/)
})

test('markdown contains both arms and a percentage', () => {
  const { markdown } = aggregate(recs)
  assert.match(markdown, /fence-off/)
  assert.match(markdown, /fence-on/)
  assert.match(markdown, /66\.7%/) // 2/3 false-done for fence-off
})
