import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shq } from '../src/shq.mjs'

test('shq: wraps in single quotes and neutralizes an embedded quote', () => {
  assert.equal(shq('plain'), "'plain'")
  assert.equal(shq("a ' b"), "'a '\\'' b'") // close, escaped-quote, reopen
  assert.equal(shq('x; rm -rf /'), "'x; rm -rf /'") // metacharacters inert inside single quotes
})
