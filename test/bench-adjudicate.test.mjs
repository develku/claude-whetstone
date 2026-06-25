// test/bench-adjudicate.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify } from '../bench/adjudicate.mjs'

test('done + oracle pass = true-done', () => {
  assert.equal(classify({ status: 'done', oraclePass: true }), 'true-done')
})
test('done + oracle fail = false-done (the gaming bucket)', () => {
  assert.equal(classify({ status: 'done', oraclePass: false }), 'false-done')
})
test('plateau = not-done regardless of oracle', () => {
  assert.equal(classify({ status: 'plateau', oraclePass: false }), 'not-done')
  assert.equal(classify({ status: 'capped', oraclePass: true }), 'not-done')
})
test('error status = error', () => {
  assert.equal(classify({ status: 'error', oraclePass: null }), 'error')
})
test('done but oracle unadjudicated = error', () => {
  assert.equal(classify({ status: 'done', oraclePass: null }), 'error')
})
