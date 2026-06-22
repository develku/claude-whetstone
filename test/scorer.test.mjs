import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { failureDetail } from '../scorers/test-pass-rate.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const scorer = join(here, '..', 'scorers', 'test-pass-rate.mjs')

test('failureDetail carries the assertion diff (expected vs actual), not just the name', () => {
  // mirrors node --test: the diff lives AFTER the "✖ failing tests:" marker
  const sample = [
    '✖ renders the summary (1.3ms)', // top summary line, no detail
    'ℹ tests 2',
    'ℹ pass 1',
    'ℹ fail 1',
    '',
    '✖ failing tests:',
    '',
    'test at test/x.test.mjs:15:1',
    '✖ renders the summary (1.3ms)',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    "  + '0:50 · running'",
    "  - '#0=50 | best 50@0 | running'",
    '      at TestContext.<anonymous> (file:///x.test.mjs:16:10)',
  ].join('\n')
  const d = failureDetail(sample)
  assert.match(d, /Expected values to be strictly equal/)
  assert.match(d, /#0=50 \| best 50@0 \| running/) // the expected string the editor must match
  assert.doesNotMatch(d, /at TestContext/) // stack frames stripped
})

const run = (cmd) =>
  spawnSync('node', [scorer, '--cmd', cmd, '--output', 'x', '--loop-dir', '.', '--pass', '000'], { encoding: 'utf8' })

test('scores 100 when all tests pass', () => {
  const r = run(`node -e "console.log('ℹ pass 4'); console.log('ℹ fail 0')"`)
  assert.equal(r.status, 0)
  const j = JSON.parse(r.stdout)
  assert.equal(j.score, 100)
  assert.match(j.critique, /all 4 tests pass/)
})

test('scores the pass fraction when some tests fail', () => {
  const r = run(`node -e "console.log('ℹ pass 3'); console.log('ℹ fail 1')"`)
  const j = JSON.parse(r.stdout)
  assert.equal(j.score, 75)
  assert.match(j.critique, /1\/4 tests failing/)
})

test('exits 2 (scorer error) when counts cannot be parsed', () => {
  const r = run(`node -e "console.log('no counts here')"`)
  assert.equal(r.status, 2)
})
