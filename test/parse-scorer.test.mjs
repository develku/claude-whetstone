import test from 'node:test'
import assert from 'node:assert/strict'
import { parseScorerJson } from '../src/parse-scorer.mjs'

test('parseScorerJson: returns the parsed object for valid JSON', () => {
  const res = { status: 0, stdout: '{"score":42,"critique":"x"}', stderr: '' }
  assert.deepEqual(parseScorerJson(res, 'node scorer.mjs'), { score: 42, critique: 'x' })
})

test('parseScorerJson: empty stdout throws a LOUD error naming the cmd, not "Unexpected end of JSON input"', () => {
  const res = { status: 0, stdout: '', stderr: '' }
  assert.throws(
    () => parseScorerJson(res, 'node my-scorer.mjs --needle x'),
    (e) => {
      assert.match(e.message, /no output/i)
      assert.match(e.message, /my-scorer\.mjs/)
      assert.doesNotMatch(e.message, /Unexpected end of JSON input/)
      return true
    },
  )
})

test('parseScorerJson: whitespace-only stdout is treated as empty (loud)', () => {
  const res = { status: 0, stdout: '   \n  ', stderr: '' }
  assert.throws(() => parseScorerJson(res, 'node s.mjs'), /no output/i)
})

test('parseScorerJson: non-JSON stdout throws a LOUD error with cmd + snippet', () => {
  const res = { status: 0, stdout: 'not json here', stderr: '' }
  assert.throws(
    () => parseScorerJson(res, 'node my-scorer.mjs'),
    (e) => {
      assert.match(e.message, /non-JSON/i)
      assert.match(e.message, /my-scorer\.mjs/)
      assert.match(e.message, /not json here/)
      return true
    },
  )
})

test('parseScorerJson: surfaces stderr in the empty-output message when present', () => {
  const res = { status: 0, stdout: '', stderr: 'boom on line 3' }
  assert.throws(() => parseScorerJson(res, 'node s.mjs'), /boom on line 3/)
})
