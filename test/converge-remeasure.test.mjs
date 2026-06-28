import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { reMeasureAll } from '../src/converge.mjs'

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'whet-rm-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 't@e.com')
  git(dir, 'config', 'user.name', 't')
  writeFileSync(join(dir, 'seed'), '1')
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'seed')
  return dir
}

// stub materialize/cleanup so the CONTROL logic is tested without real worktrees
const fakeWt = (deps = {}) => ({ materialize: () => '/fake/wt', cleanup: () => {}, ...deps })
const sha = 'a'.repeat(40)

// --- floor FIRST + short-circuit: a failing floor blocks and the objective scorers are NEVER run ---

test('reMeasureAll runs the floor FIRST and short-circuits — objective scorers never invoked on floor fail', () => {
  let scorerCalls = 0
  const r = reMeasureAll(
    '/repo', sha,
    [{ id: 'a', scorer: 'node a.mjs', judgeClass: false }],
    { cmd: 'npm test' },
    fakeWt({
      runFloor: () => ({ score: 0, critique: 'build broken' }),
      runScorer: () => { scorerCalls++; return { score: 100 } },
    }),
  )
  assert.equal(r.blocked, true)
  assert.equal(r.floor.score, 0)
  assert.equal(r.vector, null)
  assert.equal(scorerCalls, 0) // the expensive objective scorers are NOT run when the floor fails
})

// --- floor replica-gate: fail-then-pass is a flake (no block); fail-twice is a real failure ---

test('reMeasureAll re-runs the floor once: fail-then-pass is a flake and does NOT block', () => {
  let n = 0
  const r = reMeasureAll('/repo', sha, [{ id: 'a', scorer: 'x', judgeClass: false }], { cmd: 'c' },
    fakeWt({ runFloor: () => ({ score: ++n === 1 ? 0 : 100 }), runScorer: () => ({ score: 80 }) }))
  assert.equal(r.blocked, false)
  assert.equal(r.floor.score, 100)
  assert.equal(r.floor.replicas, 2)
})

test('reMeasureAll blocks only when the floor fails on BOTH replicas', () => {
  const r = reMeasureAll('/repo', sha, [{ id: 'a', scorer: 'x', judgeClass: false }], { cmd: 'c' },
    fakeWt({ runFloor: () => ({ score: 0 }), runScorer: () => ({ score: 80 }) }))
  assert.equal(r.blocked, true)
  assert.equal(r.floor.replicas, 2)
})

// --- the full vector: deterministic uses primary, judge runs+uses its held-out confirm ---

test('reMeasureAll measures every objective; judge runs its confirm, deterministic does not', () => {
  const calls = []
  const r = reMeasureAll('/repo', sha,
    [
      { id: 'det', scorer: 'node det.mjs', judgeClass: false },
      { id: 'judge', scorer: 'node judge.mjs', confirmScorer: 'node held.mjs', judgeClass: true },
    ],
    { cmd: 'c' },
    fakeWt({
      runFloor: () => ({ score: 100 }),
      runScorer: (cmd) => { calls.push(cmd); return { score: cmd.includes('held') ? 88 : 95, critique: 'x' } },
    }),
  )
  assert.equal(r.blocked, false)
  const det = r.vector.find((v) => v.id === 'det')
  const judge = r.vector.find((v) => v.id === 'judge')
  assert.equal(det.primaryScore, 95)
  assert.equal(det.confirmScore, null) // deterministic: no confirm run
  assert.equal(judge.primaryScore, 95)
  assert.equal(judge.confirmScore, 88) // judge: the held-out confirm
  assert.ok(calls.includes('node held.mjs')) // the confirm WAS run for the judge
  assert.ok(!calls.some((c) => c === 'node held.mjs' && false)) // sanity
})

// --- REAL GIT: each objective scores in its OWN fresh worktree (no cwd cache cross-contamination) ---

test('reMeasureAll gives each objective a FRESH worktree — one scorer cannot see another scorer cache', () => {
  const dir = tempRepo()
  const sdir = mkdtempSync(join(tmpdir(), 'whet-rmsc-'))
  const candidate = git(dir, 'rev-parse', 'HEAD')
  // scorer A writes cache.json into cwd and scores 100; scorer B scores 0 IF it sees cache.json, else 100
  const aPath = join(sdir, 'a.mjs')
  const bPath = join(sdir, 'b.mjs')
  writeFileSync(aPath, "import {writeFileSync} from 'node:fs'\nwriteFileSync('cache.json','x')\nprocess.stdout.write(JSON.stringify({score:100,critique:''}))\n")
  writeFileSync(bPath, "import {existsSync} from 'node:fs'\nprocess.stdout.write(JSON.stringify({score: existsSync('cache.json')?0:100, critique:''}))\n")
  try {
    const r = reMeasureAll(dir, candidate,
      [{ id: 'a', scorer: `node ${aPath}`, judgeClass: false }, { id: 'b', scorer: `node ${bPath}`, judgeClass: false }],
      { cmd: 'true' }, // floor passes (real floor.mjs)
    )
    assert.equal(r.blocked, false)
    assert.equal(r.vector.find((v) => v.id === 'a').primaryScore, 100)
    assert.equal(r.vector.find((v) => v.id === 'b').primaryScore, 100) // B did NOT see A's cache -> fresh worktree
  } finally {
    rmSync(dir, { recursive: true, force: true }); rmSync(sdir, { recursive: true, force: true })
  }
})

test('reMeasureAll real floor: a failing floor command blocks (score 0) via the real floor.mjs', () => {
  const dir = tempRepo()
  const candidate = git(dir, 'rev-parse', 'HEAD')
  try {
    const r = reMeasureAll(dir, candidate, [{ id: 'a', scorer: 'true', judgeClass: false }], { cmd: 'false' })
    assert.equal(r.blocked, true)
    assert.equal(r.floor.score, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
