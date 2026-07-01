import test from 'node:test'
import assert from 'node:assert/strict'
import { scorerRunCheck } from '../src/forge/admit.mjs'

// The Forge admission adapter runs an allowlisted candidate scorer and reads its {score}. If the
// candidate exits 0 with empty stdout (the silent-no-op class — e.g. a scorer whose main guard didn't
// fire when launched via a symlink), the bare JSON.parse used to throw a cryptic "Unexpected end of
// JSON input" with no context. `true` ignores the appended --output/--loop-dir/--pass and exits 0 with
// no stdout, reproducing that case deterministically.
test('scorerRunCheck fails LOUD (names the cause), not cryptically, on empty scorer output', () => {
  assert.throws(
    () => scorerRunCheck('true', '/dev/null'),
    (e) => {
      assert.match(e.message, /no output/i)
      assert.doesNotMatch(e.message, /Unexpected end of JSON input/)
      return true
    },
  )
})
