// test/floor.test.mjs
// The deterministic floor (H4): "never ship a judge-only top gate; always keep one deterministic floor
// (repo still builds)." floor.mjs runs a deterministic command — exit 0 -> 100, non-zero -> 0 — and
// optionally chains the real confirm ONLY when the floor passes. scope-cli --floor wires it as the
// confirm so the floor is enforced at the done-edge even with a judge-only primary scorer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gradeFloor, floorConfirmCmd } from '../scorers/floor.mjs'
import { parseScopeCli, buildAllowlist } from '../src/scope-cli.mjs'

const FLOOR = join(dirname(fileURLToPath(import.meta.url)), '..', 'scorers', 'floor.mjs')
const tmp = () => mkdtempSync(join(tmpdir(), 'floor-'))
const run = (args) => spawnSync('node', [FLOOR, ...args, '--output', tmp(), '--pass', '0001'], { encoding: 'utf8' })

// --- pure: gradeFloor ----------------------------------------------------------------------------

test('gradeFloor: a FAILING floor (non-zero exit) -> score 0 with the failure in the critique', () => {
  const g = gradeFloor({ floorExit: 1, floorOutput: 'build error: missing semicolon' })
  assert.equal(g.score, 0)
  assert.match(g.critique, /floor failed/i)
  assert.match(g.critique, /missing semicolon/)
})

test('gradeFloor: a PASSING floor with no chained scorer -> score 100', () => {
  assert.deepEqual(gradeFloor({ floorExit: 0 }), { score: 100, critique: 'deterministic floor passed', findings: [] })
})

test('gradeFloor: a PASSING floor RETURNS the chained scorer review (the held-out confirm runs only above the floor)', () => {
  const andReview = { score: 42, critique: 'held-out behaviour still failing', findings: [{ area: 'x' }] }
  assert.deepEqual(gradeFloor({ floorExit: 0, andReview }), andReview)
})

// --- pure: scope-cli wiring helper ---------------------------------------------------------------

test('floorConfirmCmd wires the floor as a confirm; composes --and with an existing confirm scorer', () => {
  const a = floorConfirmCmd({ floorPath: '/s/floor.mjs', floorCmd: 'npm run build' })
  assert.match(a, /floor\.mjs' --cmd 'npm run build'/)
  assert.doesNotMatch(a, /--and/) // no existing confirm -> floor alone
  const b = floorConfirmCmd({ floorPath: '/s/floor.mjs', floorCmd: 'make', confirmCmd: 'node c.mjs --nodes x' })
  assert.match(b, /--and 'node c\.mjs --nodes x'/) // existing confirm chained above the floor
})

// --- CLI -----------------------------------------------------------------------------------------

test('floor CLI: a passing command (true) scores 100', () => {
  const r = run(['--cmd', 'true'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).score, 100)
})

test('floor CLI: a failing command (false) scores 0 — the floor blocks done', () => {
  const r = run(['--cmd', 'false'])
  assert.equal(r.status, 0, r.stderr) // a failing FLOOR is a valid score 0, not a scorer error
  assert.equal(JSON.parse(r.stdout).score, 0)
})

test('floor CLI: --and runs the chained scorer ONLY when the floor passes', () => {
  const dir = tmp()
  const andScorer = join(dir, 'and.mjs')
  writeFileSync(andScorer, 'process.stdout.write(JSON.stringify({score:88,critique:"chained",findings:[]}))\n')
  const and = `node ${andScorer}`
  // floor passes -> chained scorer's 88 flows through
  assert.equal(JSON.parse(run(['--cmd', 'true', '--and', and]).stdout).score, 88)
  // floor fails -> 0, chained scorer NOT consulted (its 88 never appears)
  assert.equal(JSON.parse(run(['--cmd', 'false', '--and', and]).stdout).score, 0)
})

test('floor CLI exits 2 when --cmd is missing', () => {
  assert.equal(run([]).status, 2)
})

// --- scope-cli wiring ----------------------------------------------------------------------------

test('scope-cli --floor wires floor.mjs as the confirm; composes any existing --confirm-scorer above it', () => {
  const base = ['node', 'scope-cli.mjs', 'goal', '--scope', '/r', '--scorer', 'node primary.mjs', '--floor', 'npm run build']
  const cfg = parseScopeCli(base)
  assert.match(cfg.confirmScorerCmd, /floor\.mjs' --cmd 'npm run build'/) // floor activates the done-edge confirm (path is shq'd)
  assert.doesNotMatch(cfg.confirmScorerCmd, /--and/) // no held-out confirm to chain
  const cfg2 = parseScopeCli([...base, '--confirm-scorer', 'node c.mjs --nodes x'])
  assert.match(cfg2.confirmScorerCmd, /--and 'node c\.mjs --nodes x'/) // held-out confirm runs above the floor
})

test('floor.mjs is DENIED as a decompose sub-gate (model-chosen --cmd would be shell injection)', () => {
  const m = buildAllowlist()
  assert.equal(m.has('floor'), false)
  assert.equal(m.has('composite'), false) // the existing denial still holds
  assert.equal(m.has('contains'), true) // a normal deterministic scorer stays allowed
})
