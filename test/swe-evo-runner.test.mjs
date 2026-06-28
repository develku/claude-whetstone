// test/swe-evo-runner.test.mjs
// The task runner's $0-testable surface: a FAITHFUL port of SWE-bench's parse_log_pytest (so the in-loop
// grade matches the official evaluate_instance.py cross-check), the PASSED->pass projection, the
// container script builder, and the injectable STUB seam that lets the A/B run end-to-end at $0. The real
// `docker run` path is exercised in the feasibility/pilot phase, not here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseLogPytest, toResultsMap, buildContainerScript } from '../bench/swe-evo/runner.mjs'

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bench', 'swe-evo', 'runner.mjs')

// a realistic `pytest --continue-on-collection-errors -n0 -rA` tail: run-body lines (path-first, must be
// IGNORED) then the short-summary (status-first, parsed). Includes the FAILED " - reason", a file-level
// collection ERROR, a SKIPPED summary line (which pytest formats as "SKIPPED [n] file:line: reason" — it
// mis-keys to "[1]", so the real node reads as missing; faithful to the official parser), and an XFAIL.
const LOG = `
tests/test_a.py::test_one PASSED                                         [ 25%]
tests/test_b.py::test_three FAILED                                       [ 50%]
============================= short test summary info ==========================
PASSED tests/test_a.py::test_one
PASSED tests/test_a.py::test_two
FAILED tests/test_b.py::test_three - AssertionError: assert 1 == 2 - extra
ERROR tests/test_c.py - ImportError: cannot import name 'x'
SKIPPED [1] tests/test_d.py:10: needs network
XFAIL tests/test_e.py::test_five - known bug
========================= 1 failed, 2 passed, 1 error in 0.5s ==================
`

test('parseLogPytest parses status-first summary lines and IGNORES path-first run-body lines', () => {
  const m = parseLogPytest(LOG)
  assert.equal(m['tests/test_a.py::test_one'], 'PASSED')
  assert.equal(m['tests/test_a.py::test_two'], 'PASSED')
  assert.equal(m['tests/test_b.py::test_three'], 'FAILED')
  assert.equal(m['tests/test_e.py::test_five'], 'XFAIL')
})

test('parseLogPytest strips the FAILED " - reason" so the node id is test_case[1] (all " - " removed)', () => {
  const m = parseLogPytest('FAILED pkg/test.py::test_x - AssertionError: a - b - c')
  assert.equal(m['pkg/test.py::test_x'], 'FAILED')
})

test('parseLogPytest keys a file-level collection ERROR by the file (so the NODE stays missing)', () => {
  const m = parseLogPytest(LOG)
  assert.equal(m['tests/test_c.py'], 'ERROR')
  assert.equal(m['tests/test_c.py::test_four'], undefined) // node not reported -> missing downstream
})

test('parseLogPytest replicates the -rA SKIPPED mis-key quirk (node stays missing, matching official)', () => {
  const m = parseLogPytest(LOG)
  assert.equal(m['tests/test_d.py::test_skip'], undefined)
  assert.equal(m['[1]'], 'SKIPPED') // the quirk: the bracketed count is keyed, not the node
})

test('toResultsMap projects PASSED->pass and everything else (FAILED/ERROR/XFAIL)->fail', () => {
  const r = toResultsMap({ a: 'PASSED', b: 'FAILED', c: 'ERROR', d: 'XFAIL', e: 'SKIPPED' })
  assert.deepEqual(r, { a: 'pass', b: 'fail', c: 'fail', d: 'fail', e: 'fail' })
})

test('buildContainerScript resets to base_commit, applies CODE then TEST patch, then runs test_cmds — in order', () => {
  const s = buildContainerScript({ repoDir: '/testbed', baseCommit: 'abc123', codePatch: '/w/code.patch', testPatch: '/w/test.patch', testCmds: 'pytest -rA' })
  const iReset = s.indexOf('abc123')
  const iCode = s.indexOf('/w/code.patch')
  const iTest = s.indexOf('/w/test.patch')
  const iCmd = s.indexOf('pytest -rA')
  assert.ok(iReset >= 0 && iCode >= 0 && iTest >= 0 && iCmd >= 0, 'all parts present')
  assert.ok(iReset < iCode && iCode < iTest && iTest < iCmd, `order: reset<code<test<cmd (${iReset},${iCode},${iTest},${iCmd})`)
  assert.match(s, /cd \/testbed/)
})

test('buildContainerScript skips the code-patch apply when there is no editor diff yet (empty codePatch)', () => {
  const s = buildContainerScript({ repoDir: '/testbed', baseCommit: 'abc', codePatch: null, testPatch: '/w/test.patch', testCmds: 'pytest -rA' })
  assert.doesNotMatch(s, /code\.patch/)
  assert.match(s, /test\.patch/)
})

// --- the injectable STUB seam: the runner CLI prints a canned results map at $0 (no Docker) ----------

test('runner CLI --stub prints the canned results map (the $0 end-to-end seam)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swe-runner-'))
  const canned = { 'f::a': 'pass', 'f::b': 'fail' }
  const stub = join(dir, 'stub.json')
  writeFileSync(stub, JSON.stringify(canned))
  const inst = join(dir, 'inst.json')
  writeFileSync(inst, JSON.stringify({ image: 'x', baseCommit: 'abc', testCmds: 'pytest -rA', testPatch: '', repoDir: '/testbed' }))
  const r = spawnSync('node', [RUNNER, '--instance-json', inst, '--test-files', 'tests/t.py', '--stub', stub], { encoding: 'utf8', cwd: dir })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), canned)
})

test('runner CLI exits 2 when neither --stub nor a usable instance/docker path is given', () => {
  const r = spawnSync('node', [RUNNER], { encoding: 'utf8' })
  assert.equal(r.status, 2)
})
