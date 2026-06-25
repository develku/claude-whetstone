import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sign } from '../src/sign.mjs'

test('sign(5) === 1', () => {
  assert.equal(sign(5), 1)
})
