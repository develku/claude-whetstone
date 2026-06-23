import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureLoopDir, writeReview } from '../src/state.mjs'

// Secrets in scorer output (e.g. an artifact that embeds a key, echoed back in the
// critique) must not land in review.json. writeReview must scrub them before writing.

test('writeReview scrubs secrets before writing the review file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whetstone-redact-'))
  ensureLoopDir(dir)
  const rel = writeReview(dir, 1, {
    score: 50,
    critique: 'the file leaked sk-abcdefghij1234567890 in its output',
    findings: [],
  })
  const written = JSON.parse(readFileSync(join(dir, rel), 'utf8'))
  assert.match(written.critique, /\[REDACTED\]/)
  assert.doesNotMatch(written.critique, /sk-abcdefghij/)
})
