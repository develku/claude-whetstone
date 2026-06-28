import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coverageScore, coverageDetail, PLAN_DISCLOSURES } from '../src/plan-coverage.mjs'

const surface = ['src/a/x.mjs', 'src/a/y.mjs', 'src/b/z.mjs', 'src/c/w.mjs']
const manifest = (scopes) => ({ objectives: scopes.map((editScope, i) => ({ id: `o${i}`, editScope })) })

test('coverageScore: broad disjoint scopes covering the whole surface score 100', () => {
  assert.equal(coverageScore(manifest(['src/a', 'src/b', 'src/c']), surface), 100)
})

test('coverageScore: a single tiny scope scores low', () => {
  assert.equal(coverageScore(manifest(['src/a']), surface), 50) // src/a covers 2 of 4
  assert.equal(coverageScore(manifest(['src/b/z.mjs']), surface), 25) // one file of 4
})

test('coverageScore: overlap adds ZERO (set-union over files, leaf-multiplication-resistant)', () => {
  const base = coverageScore(manifest(['src/a']), surface)
  const overlapped = coverageScore(manifest(['src/a', 'src/a/x.mjs']), surface) // x.mjs already under src/a
  assert.equal(overlapped, base)
})

test('coverageScore: empty surface scores 0 (no divide-by-zero)', () => {
  assert.equal(coverageScore(manifest(['src/a']), []), 0)
})

test('coverageScore: a scope covering nothing in the surface scores 0', () => {
  assert.equal(coverageScore(manifest(['src/zzz']), surface), 0)
})

test('coverageScore: scope/file path normalization (./ , trailing /, redundant //) is canonicalized', () => {
  assert.equal(coverageScore(manifest(['./src/a/']), surface), 50)
  assert.equal(coverageScore(manifest(['src//a']), surface), 50)
})

test('coverageDetail: discloses the denominator (surface size) and the covered set', () => {
  const d = coverageDetail(manifest(['src/a']), surface)
  assert.equal(d.surfaceSize, 4)
  assert.equal(d.coveredSize, 2)
  assert.equal(d.score, 50)
  assert.deepEqual(d.coveredFiles.sort(), ['src/a/x.mjs', 'src/a/y.mjs'])
})

test('coverageScore is REPORT-ONLY — returns a plain number, never a verdict shape', () => {
  const s = coverageScore(manifest(['src/a']), surface)
  assert.equal(typeof s, 'number')
  assert.ok(s >= 0 && s <= 100)
})

test('PLAN_DISCLOSURES carries the loud GATE-DID-NOT-PROVE residuals', () => {
  assert.ok(Array.isArray(PLAN_DISCLOSURES) && PLAN_DISCLOSURES.length >= 4)
  const joined = PLAN_DISCLOSURES.join('\n').toLowerCase()
  assert.match(joined, /unproven/) // sufficiency stays unproven (§11.1)
  assert.match(joined, /misassign|tautolog|semantic/) // the headline misassignment residual (§11.2)
  assert.match(joined, /structural|span/) // coverage is a structural proxy (§11.3)
  assert.match(joined, /operator/) // scorer-menu adequacy is the operator's contract (§11.4)
})
