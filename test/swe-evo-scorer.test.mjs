// test/swe-evo-scorer.test.mjs
// The V/C/T scorer CLI bridges the Docker runner's {node->pass|fail|missing} results map to whetstone's
// loop: it grades a single arm's node-set with computeFixRate and emits the {score,critique,findings}
// contract every whetstone scorer honours. Source-isolation aware: --reveal-nodes gives V the gradient
// detail; without it (C/T) the critique is counts-only so a confirm-veto can't leak held-out node names.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gradeResults } from '../bench/swe-evo/scorer.mjs'

const SCORER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bench', 'swe-evo', 'scorer.mjs')
const tmp = () => mkdtempSync(join(tmpdir(), 'swe-scorer-'))
const writeJson = (dir, name, obj) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(obj)); return p }
// shell-quote for a fixture runner command embedded in a single --runner string
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`

// --- pure core: gradeResults ---------------------------------------------------------------------

test('gradeResults: all FAIL_TO_PASS pass, no regression -> score 100, no findings', () => {
  const g = gradeResults({ results: { 'f::a': 'pass', 'f::b': 'pass', 'p::x': 'pass' }, failNodes: ['f::a', 'f::b'], passToPass: ['p::x'], reveal: true })
  assert.equal(g.score, 100)
  assert.deepEqual(g.findings, [])
  assert.match(g.critique, /100/)
})

test('gradeResults: half failing with reveal -> score 50, finding names the failing node + its status', () => {
  const g = gradeResults({ results: { 'f::a': 'pass', 'f::b': 'fail', 'p::x': 'pass' }, failNodes: ['f::a', 'f::b'], passToPass: ['p::x'], reveal: true })
  assert.equal(g.score, 50)
  assert.equal(g.findings.length, 1)
  assert.equal(g.findings[0].area, 'f::b')
  assert.match(g.critique, /f::b/) // the gradient: the editor sees which behaviour is still failing
})

test('gradeResults: a missing FAIL_TO_PASS node is reported as missing (collection error != assertion fail)', () => {
  const g = gradeResults({ results: { 'f::a': 'pass', 'p::x': 'pass' }, failNodes: ['f::a', 'f::b'], passToPass: ['p::x'], reveal: true })
  assert.equal(g.score, 50) // f::b absent -> not passing
  assert.equal(g.findings[0].area, 'f::b')
  assert.match(g.critique, /missing/i)
})

test('gradeResults: PASS_TO_PASS regression -> hard 0 and the critique flags the regression', () => {
  const g = gradeResults({ results: { 'f::a': 'pass', 'f::b': 'pass', 'p::x': 'fail' }, failNodes: ['f::a', 'f::b'], passToPass: ['p::x'], reveal: true })
  assert.equal(g.score, 0)
  assert.match(g.critique, /regress/i)
})

test('gradeResults: WITHOUT reveal (C/T), the critique is counts-only and leaks NO node names', () => {
  const g = gradeResults({ results: { 'f::a': 'pass', 'f::b': 'fail', 'p::x': 'pass' }, failNodes: ['f::a', 'f::b'], passToPass: ['p::x'], reveal: false })
  assert.equal(g.score, 50)
  assert.deepEqual(g.findings, []) // no per-node findings -> nothing to surface back to the editor
  assert.doesNotMatch(g.critique, /f::a|f::b|p::x/) // source isolation: no held-out node id in the text
  assert.match(g.critique, /50/) // but the scalar gradient is still there
})

// --- CLI: results-file source (offline T grading; $0) --------------------------------------------

test('CLI --results reads a fixture results file and honours the whetstone contract', () => {
  const dir = tmp()
  const nodes = writeJson(dir, 'nodes.json', { failNodes: ['f::a', 'f::b'], passToPass: ['p::x'] })
  const results = writeJson(dir, 'results.json', { 'f::a': 'pass', 'f::b': 'fail', 'p::x': 'pass' })
  const r = spawnSync('node', [SCORER, '--nodes', nodes, '--results', results, '--output', dir, '--loop-dir', dir, '--pass', '0001'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).score, 50)
})

// --- CLI: runner source (in-loop V/C; fresh results each pass) -----------------------------------

test('CLI --runner spawns the runner and grades its stdout results map', () => {
  const dir = tmp()
  const nodes = writeJson(dir, 'nodes.json', { failNodes: ['f::a', 'f::b'], passToPass: ['p::x'] })
  const fixture = { 'f::a': 'pass', 'f::b': 'pass', 'p::x': 'pass' }
  const runner = `node -e ${shq(`process.stdout.write(${JSON.stringify(JSON.stringify(fixture))})`)}`
  const r = spawnSync('node', [SCORER, '--nodes', nodes, '--runner', runner, '--output', dir, '--loop-dir', dir, '--pass', '0001'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).score, 100)
})

test('CLI --reveal-nodes flag surfaces the failing node in the critique', () => {
  const dir = tmp()
  const nodes = writeJson(dir, 'nodes.json', { failNodes: ['f::a', 'f::b'], passToPass: [] })
  const results = writeJson(dir, 'results.json', { 'f::a': 'pass', 'f::b': 'fail' })
  const r = spawnSync('node', [SCORER, '--nodes', nodes, '--results', results, '--reveal-nodes'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(JSON.parse(r.stdout).critique, /f::b/)
})

// --- CLI: error contract (exit 2 on scorer error, never a silent 0) ------------------------------

test('CLI exits 2 when neither --results nor --runner is given', () => {
  const dir = tmp()
  const nodes = writeJson(dir, 'nodes.json', { failNodes: ['f::a'], passToPass: [] })
  assert.equal(spawnSync('node', [SCORER, '--nodes', nodes], { encoding: 'utf8' }).status, 2)
})

test('CLI exits 2 when BOTH --results and --runner are given (ambiguous source)', () => {
  const dir = tmp()
  const nodes = writeJson(dir, 'nodes.json', { failNodes: ['f::a'], passToPass: [] })
  const results = writeJson(dir, 'results.json', { 'f::a': 'pass' })
  assert.equal(spawnSync('node', [SCORER, '--nodes', nodes, '--results', results, '--runner', 'true'], { encoding: 'utf8' }).status, 2)
})

test('CLI exits 2 (scorer error) when the runner itself exits non-zero — never scores it 0', () => {
  const dir = tmp()
  const nodes = writeJson(dir, 'nodes.json', { failNodes: ['f::a'], passToPass: [] })
  const r = spawnSync('node', [SCORER, '--nodes', nodes, '--runner', 'node -e "process.exit(3)"'], { encoding: 'utf8' })
  assert.equal(r.status, 2)
})

test('CLI exits 2 when the runner stdout is not valid JSON', () => {
  const dir = tmp()
  const nodes = writeJson(dir, 'nodes.json', { failNodes: ['f::a'], passToPass: [] })
  const r = spawnSync('node', [SCORER, '--nodes', nodes, '--runner', 'echo not-json'], { encoding: 'utf8' })
  assert.equal(r.status, 2)
})

test('CLI exits 2 when --nodes is missing', () => {
  const dir = tmp()
  const results = writeJson(dir, 'results.json', { 'f::a': 'pass' })
  assert.equal(spawnSync('node', [SCORER, '--results', results], { encoding: 'utf8' }).status, 2)
})

// --- boundary validation (review HIGH/MEDIUM) — a broken config must never read as a pass ----------

test('gradeResults: WITHOUT reveal still reports the regression bit, with NO node name', () => {
  const g = gradeResults({ results: { 'f::a': 'pass', 'p::x': 'fail' }, failNodes: ['f::a'], passToPass: ['p::x'], reveal: false })
  assert.equal(g.score, 0)
  assert.match(g.critique, /regression=true/)
  assert.doesNotMatch(g.critique, /p::x|f::a/)
})

test('CLI exits 2 when --nodes has an EMPTY failNodes array (an arm always has >=1 FAIL_TO_PASS; empty == a bug, never a vacuous 100)', () => {
  const dir = tmp()
  const nodes = writeJson(dir, 'nodes.json', { failNodes: [], passToPass: ['p::x'] })
  const results = writeJson(dir, 'results.json', { 'p::x': 'pass' })
  // computeFixRate would return 100 here (vacuous) — the boundary must refuse it, not score it done
  assert.equal(spawnSync('node', [SCORER, '--nodes', nodes, '--results', results], { encoding: 'utf8' }).status, 2)
})

test('CLI exits 2 when --nodes failNodes is not an array', () => {
  const dir = tmp()
  const nodes = writeJson(dir, 'nodes.json', { failNodes: 'all', passToPass: [] })
  const results = writeJson(dir, 'results.json', { 'f::a': 'pass' })
  assert.equal(spawnSync('node', [SCORER, '--nodes', nodes, '--results', results], { encoding: 'utf8' }).status, 2)
})

test('CLI exits 2 when --nodes passToPass is present but not an array', () => {
  const dir = tmp()
  const nodes = writeJson(dir, 'nodes.json', { failNodes: ['f::a'], passToPass: 'x' })
  const results = writeJson(dir, 'results.json', { 'f::a': 'pass' })
  assert.equal(spawnSync('node', [SCORER, '--nodes', nodes, '--results', results], { encoding: 'utf8' }).status, 2)
})

test('CLI exits 2 when the results map is not a JSON object (array/null), not a misleading 0', () => {
  const dir = tmp()
  const nodes = writeJson(dir, 'nodes.json', { failNodes: ['f::a'], passToPass: [] })
  const arr = writeJson(dir, 'results.json', [])
  assert.equal(spawnSync('node', [SCORER, '--nodes', nodes, '--results', arr], { encoding: 'utf8' }).status, 2)
})
