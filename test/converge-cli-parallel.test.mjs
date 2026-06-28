import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { parseConvergeCli, acquireRunLock } from '../src/converge-cli.mjs'

// Track B inc 6 — the --parallel CLI flags + the per-run advisory lock (O_EXCL), all $0 (parse + lock only,
// no run, no spend). The entry-routing smoke spawns the CLI on a refusal path (exit 2 before any child).

// --- parseConvergeCli: the new parallel flags ---

test('parseConvergeCli defaults to sequential (parallel off) with maxParallel 2', () => {
  const cfg = parseConvergeCli(['--scope', '/r', '--objectives', '/m.json'])
  assert.equal(cfg.parallel, false)
  assert.equal(cfg.maxParallel, 2)
  assert.equal(cfg.maxBatchRegressions, 2)
  assert.equal(cfg.flakeCap, 3)
})

test('parseConvergeCli enables parallel and reads --max-parallel / --max-batch-regressions / --flake-cap', () => {
  const cfg = parseConvergeCli(['--scope', '/r', '--objectives', '/m.json', '--parallel', '--max-parallel', '4', '--max-batch-regressions', '3', '--flake-cap', '5'])
  assert.equal(cfg.parallel, true)
  assert.equal(cfg.maxParallel, 4)
  assert.equal(cfg.maxBatchRegressions, 3)
  assert.equal(cfg.flakeCap, 5)
})

// --- acquireRunLock: O_EXCL advisory lock with PID-liveness staleness ---

test('acquireRunLock creates the lock, refuses a second live acquire, and frees it on release', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whet-lock-'))
  try {
    const release = acquireRunLock(dir)
    assert.ok(existsSync(join(dir, 'converge.lock')))
    assert.throws(() => acquireRunLock(dir), /another converge run|refus/i) // our own (live) pid holds it
    release()
    assert.equal(existsSync(join(dir, 'converge.lock')), false)
    const release2 = acquireRunLock(dir) // freed -> re-acquirable
    release2()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('acquireRunLock STEALS a stale lock whose owner pid is dead (so a crashed run can resume)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whet-lock-'))
  try {
    const dead = spawnSync('node', ['-e', '']) // runs and exits -> dead.pid is now dead
    writeFileSync(join(dir, 'converge.lock'), String(dead.pid))
    const release = acquireRunLock(dir) // dead owner -> stolen, not refused
    assert.ok(release)
    release()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- entry smoke: --parallel still guards (refuses a bad manifest before any run, no spend) ---

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'converge-cli.mjs')
const git = (d, ...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8' }).trim()

test('converge-cli --parallel still refuses (exit 2) a manifest with no floor — flag parses, entry guards', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whet-clip-'))
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't')
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'init')
  const mdir = mkdtempSync(join(tmpdir(), 'whet-clip-m-'))
  const p = join(mdir, 'objectives.json')
  writeFileSync(p, JSON.stringify({ goal: 'g', objectives: [{ id: 'a', goal: 'g', scorer: 'node x.mjs', target: 90, editScope: 'a' }] }))
  try {
    let code = 0
    let stderr = ''
    try { execFileSync('node', [CLI, '--scope', dir, '--objectives', p, '--parallel'], { encoding: 'utf8' }) } catch (e) { code = e.status; stderr = e.stderr }
    assert.equal(code, 2)
    assert.match(stderr, /refusing to start/)
    assert.match(stderr, /floor/)
  } finally {
    rmSync(dir, { recursive: true, force: true }); rmSync(mdir, { recursive: true, force: true })
  }
})
