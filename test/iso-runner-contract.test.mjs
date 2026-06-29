// test/iso-runner-contract.test.mjs — the PURE parent-side contracts of the isolated runner:
// classifyObservation (reason -> scorer-error/score-zero/proceed) and meetsNodeFloor (the registerHooks floor).
// These guard mappings whose comments claim "can't drift" but had no direct test (ultra review MED).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyObservation, meetsNodeFloor } from '../src/iso-runner.mjs'

test('classifyObservation: ok:true proceeds to the oracle (returns null)', () => {
  assert.equal(classifyObservation({ ok: true, results: [] }), null)
})

test('classifyObservation: a bad import is a scorer-error (exit 2), preserving the documented contract', () => {
  const c = classifyObservation({ ok: false, reason: 'import', error: 'boom' })
  assert.equal(c.kind, 'scorer-error')
  assert.match(c.message, /import/i)
})

test('classifyObservation: an unsupported runtime is a scorer-error (clear, not a silent score 0)', () => {
  const c = classifyObservation({ ok: false, reason: 'runtime', error: 'needs Node >= 23.5.0' })
  assert.equal(c.kind, 'scorer-error')
  assert.match(c.message, /node|runtime|23\.5/i)
})

test('classifyObservation: missing-export depends on the per-scorer flag (assert/invariant exit 2; trace/effect score 0)', () => {
  assert.equal(classifyObservation({ ok: false, reason: 'missing-export', name: 'f' }, { missingExportExits: true }).kind, 'scorer-error')
  assert.equal(classifyObservation({ ok: false, reason: 'missing-export', name: 'f' }, { missingExportExits: false }).kind, 'score-zero')
  assert.equal(classifyObservation({ ok: false, reason: 'missing-export', name: 'f' }).kind, 'score-zero') // default
})

test('classifyObservation: artifact/no-frame/spawn/unparseable are score-0 verdicts (a broken/forging child never aborts the gate)', () => {
  for (const reason of ['artifact', 'no-frame', 'spawn', 'unparseable']) {
    const c = classifyObservation({ ok: false, reason, error: 'x' })
    assert.equal(c.kind, 'score-zero', `reason ${reason} must be score-zero`)
    assert.ok(typeof c.critique === 'string' && c.critique.length)
  }
})

test('meetsNodeFloor: registerHooks requires Node >= 23.5.0', () => {
  assert.equal(meetsNodeFloor('23.5.0'), true)
  assert.equal(meetsNodeFloor('23.5.1'), true)
  assert.equal(meetsNodeFloor('24.0.0'), true)
  assert.equal(meetsNodeFloor('26.4.0'), true)
  assert.equal(meetsNodeFloor('23.4.0'), false)
  assert.equal(meetsNodeFloor('22.14.0'), false)
  assert.equal(meetsNodeFloor('18.0.0'), false)
})
