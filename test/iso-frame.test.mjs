// test/iso-frame.test.mjs — the cross-process transport leaf (stdlib only, child-safe).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serialize, frameOpen, frameClose, extractPayload } from '../src/iso-frame.mjs'

test('serialize faithfully encodes inert JSON values', () => {
  assert.equal(serialize(null), 'null')
  assert.equal(serialize(5), '5')
  assert.equal(serialize(-0.5), '-0.5')
  assert.equal(serialize(true), 'true')
  assert.equal(serialize('a"b\n'), '"a\\"b\\n"')
  assert.equal(serialize([1, 'x', null]), '[1,"x",null]')
  assert.equal(serialize({ b: 1, a: [2, 3] }), '{"b":1,"a":[2,3]}')
})

// The whole point of serialize over JSON.stringify: it only ever stringifies PRIMITIVE leaves, so a
// polluted Object.prototype.toJSON is never consulted. Pollute it locally and restore.
test('serialize ignores a polluted Object.prototype.toJSON (never invokes toJSON on objects)', () => {
  const saved = Object.prototype.toJSON
  try {
    // eslint-disable-next-line no-extend-native
    Object.prototype.toJSON = () => 'FORGED'
    assert.equal(serialize({ x: 1 }), '{"x":1}')      // not "FORGED"
    assert.equal(JSON.stringify({ x: 1 }), '"FORGED"') // proves the pollution is live
  } finally {
    if (saved === undefined) delete Object.prototype.toJSON
    else Object.prototype.toJSON = saved
  }
})

test('frameOpen/frameClose + extractPayload round-trip a payload by nonce', () => {
  const nonce = 'deadbeefdeadbeef'
  const wire = 'noise' + frameOpen(nonce) + '{"ok":true}' + frameClose(nonce) + 'trailing'
  assert.equal(extractPayload(wire, nonce), '{"ok":true}')
})

test('extractPayload returns null when the nonce frame is absent (forged/suppressed output)', () => {
  assert.equal(extractPayload('{"ok":true,"value":5}', 'deadbeefdeadbeef'), null) // no nonce → not ours
  assert.equal(extractPayload(frameOpen('aaaa') + 'x' + frameClose('aaaa'), 'bbbb'), null) // wrong nonce
})
