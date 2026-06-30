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

test('exits 2 when the test command exits non-zero but reports no failures (a masked crash)', () => {
  // a crash / SIGKILL-137 / coverage-or-lint gate that still printed all-pass counts must NOT score
  // 100 — that would let the loop declare victory on a broken run. exit≠0 with fail===0 is the tell.
  const r = run(`echo 'ℹ pass 5'; echo 'ℹ fail 0'; exit 99`)
  assert.equal(r.status, 2)
})

test('still scores normally when tests FAIL (non-zero exit WITH failures is the normal case)', () => {
  // failing tests legitimately exit non-zero; only the contradiction (exit≠0 AND fail===0) is the bug.
  const r = run(`echo 'ℹ pass 2'; echo 'ℹ fail 1'; exit 1`)
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout).score, 66.67)
})

test('exits 2 when a run collected ZERO tests (pass 0 + fail 0) — a NaN-score guard, not score 0', () => {
  // a glob that matched no files prints 'pass 0 / fail 0'; total===0 would divide-by-zero into a NaN
  // score that the gate mis-handles. This is distinct from the masked-crash case (which needs exit≠0).
  const r = run(`node -e "console.log('ℹ pass 0'); console.log('ℹ fail 0')"`)
  assert.equal(r.status, 2)
})

test('extracts failing test names into the findings array (the gate-facing JSON)', () => {
  const r = run(`node -e "console.log('✖ test alpha (1ms)'); console.log('✖ test beta (1ms)'); console.log('ℹ pass 1'); console.log('ℹ fail 2')"`)
  const j = JSON.parse(r.stdout)
  assert.deepEqual(
    j.findings.map((f) => f.area),
    ['test alpha', 'test beta'],
  )
  assert.equal(j.findings[0].severity, 'high')
})

// --- F4: portable parsing for non-node:test runners (pytest) ---
// The reference scorer claimed to be "the most portable scorer" but parsed only node:test
// output (`ℹ pass N`). A pytest/jest/go-test project could not use it. node:test patterns are
// tried FIRST so existing node:test behavior is unchanged; pytest is a fallback.

test('parses a pytest summary and scores the pass fraction (portability)', () => {
  const r = run(`echo '2 failed, 98 passed in 1.27s'; exit 1`)
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout).score, 98)
})

test('parses an all-passing pytest summary as 100', () => {
  const r = run(`echo '5 passed in 0.10s'`)
  assert.equal(r.status, 0)
  const j = JSON.parse(r.stdout)
  assert.equal(j.score, 100)
  assert.match(j.critique, /all 5 tests pass/)
})

test('counts pytest collection errors as failures (not silently dropped)', () => {
  // "1 error" during collection means the suite did NOT fully pass; it must lower the score.
  const r = run(`echo '1 error in 0.10s'; exit 2`)
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout).score, 0)
})

test('failureDetail narrows pytest output to the assertion gradient, dropping noise', () => {
  const sample = [
    'tests/test_x.py::test_foo FAILED',
    '    def test_foo():',
    '>       assert grouped == expected',
    'E       AssertionError: assert 1 == 2',
    'FAILED tests/test_x.py::test_foo - AssertionError: assert 1 == 2',
    '1 failed, 3 passed in 0.20s',
  ].join('\n')
  const d = failureDetail(sample)
  assert.match(d, /E\s+AssertionError: assert 1 == 2/) // keeps the expected-vs-actual gradient
  assert.match(d, /assert grouped == expected/) // keeps the failing expression
  assert.match(d, /FAILED tests\/test_x\.py::test_foo/)
  assert.doesNotMatch(d, /def test_foo/) // drops surrounding source noise
  assert.doesNotMatch(d, /passed in/) // drops the summary line
})

test('extracts pytest FAILED test names into findings', () => {
  const r = run(`printf 'FAILED tests/test_x.py::test_foo - boom\\n1 failed, 2 passed in 0.10s\\n'; exit 1`)
  const j = JSON.parse(r.stdout)
  assert.deepEqual(
    j.findings.map((f) => f.area),
    ['tests/test_x.py::test_foo'],
  )
})
