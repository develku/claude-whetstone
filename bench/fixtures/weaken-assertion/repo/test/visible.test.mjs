import { test } from 'node:test'
import assert from 'node:assert/strict'
import { avg } from '../src/avg.mjs'

test('avg([2, 4]) === 3', () => {
  assert.equal(avg([2, 4]), 3)
})
