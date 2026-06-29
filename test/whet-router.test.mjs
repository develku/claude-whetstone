import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { routeIntake } from '../src/whet.mjs'

// --- Inc 4: intake router (pure routing) ---
// The router picks the entry point from the input flags; ambiguous / under-specified intent routes UP (the CLI
// prints guidance and exits non-zero) rather than guessing — picking a process never moves goalposts, so this is
// the safe layer above the three measured entry points.

test('routeIntake: --objectives -> converge (most structured wins, even alongside --scope)', () => {
  assert.equal(routeIntake(['--objectives', 'm.json', '--scope', 'd']).mode, 'converge')
  assert.equal(routeIntake(['--objectives', 'm.json']).mode, 'converge')
})

test('routeIntake: --scope (no objectives) -> scope; --artifact -> driver', () => {
  assert.equal(routeIntake(['--scope', 'repo']).mode, 'scope')
  assert.equal(routeIntake(['--artifact', 'file.txt', '--scorer', 'true']).mode, 'driver')
})

test('routeIntake: both --scope and --artifact is ambiguous -> route UP (null)', () => {
  const r = routeIntake(['--scope', 'd', '--artifact', 'f'])
  assert.equal(r.mode, null)
  assert.match(r.reason, /exactly one/)
})

test('routeIntake: no target flag -> route UP (null) with guidance', () => {
  const r = routeIntake(['--goal', 'do a thing'])
  assert.equal(r.mode, null)
  assert.match(r.reason, /no target/)
})

// --- the CLI shell: route-up exits 2 with guidance; a valid target delegates into the entry point ---

const WHET = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'whet.mjs')
const run = (...args) => spawnSync('node', [WHET, ...args], { encoding: 'utf8' })

test('whet (no args) routes UP: exit 2 + cannot-route guidance', () => {
  const r = run()
  assert.equal(r.status, 2)
  assert.match(r.stderr, /cannot route/)
  assert.match(r.stderr, /no target/)
})

test('whet --scope + --artifact routes UP: exit 2 + "exactly one" guidance', () => {
  const r = run('--scope', 'd', '--artifact', 'f')
  assert.equal(r.status, 2)
  assert.match(r.stderr, /cannot route/)
  assert.match(r.stderr, /exactly one/)
})

test('whet --objectives delegates INTO converge-cli (past the router, not a route-up error)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whet-route-')) // a non-git dir -> converge-cli refuses, proving delegation
  try {
    const r = run('--objectives', join(dir, 'missing.json'), '--scope', dir)
    assert.notEqual(r.status, 0)
    assert.doesNotMatch(r.stderr, /cannot route/) // got PAST the router into the converge entry
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
