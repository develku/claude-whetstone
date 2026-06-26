// test/forge-retire.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { emptyStore, addCheck, retireCheck, findCheckKeys, listActiveChecks, listChecks, loadStore, saveStore, checkStorePath } from '../src/forge/store.mjs'
import { composeConfirm } from '../src/forge/gate.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

// --- store tombstone primitives (pure) ---

test('retireCheck appends a tombstone immutably and idempotently; checks are never removed', () => {
  const s = addCheck(emptyStore(), { cmd: 'node bad.mjs', target: 100, reason: 'r' })
  const key = s.checks[0].key
  const s1 = retireCheck(s, key)
  assert.equal(s.retired, undefined)       // input unchanged
  assert.equal(s1.retired.length, 1)
  assert.equal(s1.retired[0].key, key)
  assert.equal(s1.checks.length, 1)        // the check record is preserved
  assert.equal(retireCheck(s1, key), s1)   // idempotent -> same object
})

test('findCheckKeys resolves a human-readable cmd to its stored key(s)', () => {
  let s = addCheck(emptyStore(), { cmd: 'node a.mjs --needle X', target: 100 })
  s = addCheck(s, { cmd: 'node a.mjs --needle X', target: 90 }) // same cmd, two targets -> two keys
  assert.equal(findCheckKeys(s, 'node a.mjs --needle X').length, 2)
  assert.deepEqual(findCheckKeys(s, 'node  a.mjs   --needle X'), findCheckKeys(s, 'node a.mjs --needle X')) // normalized
  assert.deepEqual(findCheckKeys(s, 'node missing.mjs'), [])
})

test('listActiveChecks folds out retired checks but listChecks still shows all (the record)', () => {
  let s = addCheck(emptyStore(), { cmd: 'node keep.mjs', target: 100, reason: 'k' })
  s = addCheck(s, { cmd: 'node bad.mjs', target: 100, reason: 'b' })
  s = retireCheck(s, findCheckKeys(s, 'node bad.mjs')[0])
  assert.deepEqual(listActiveChecks(s).map((c) => c.cmd), ['node keep.mjs'])
  assert.equal(listChecks(s).length, 2)    // full record intact
})

test('loadStore tolerates an absent or array retired field, rejects a non-array', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-retire-'))
  const noField = join(dir, 'a.json'); writeFileSync(noField, JSON.stringify({ version: 1, checks: [] }))
  assert.deepEqual(loadStore(noField).checks, [])  // old store (no retired) loads fine
  const withArr = join(dir, 'b.json'); writeFileSync(withArr, JSON.stringify({ version: 1, checks: [], retired: [{ key: 'k', reason: 'r', ts: 't' }] }))
  assert.equal(loadStore(withArr).retired.length, 1)
  const bad = join(dir, 'c.json'); writeFileSync(bad, JSON.stringify({ version: 1, checks: [], retired: 'nope' }))
  assert.throws(() => loadStore(bad), /malformed|c\.json/)
  const noKey = join(dir, 'd.json'); writeFileSync(noKey, JSON.stringify({ version: 1, checks: [], retired: [{ reason: 'r' }] }))
  assert.throws(() => loadStore(noKey), /malformed|d\.json/) // a tombstone must carry a key
})

// --- gate folds retired out of the composed manifest (brick 4b consume) ---

test('composeConfirm excludes a retired check from the gate manifest', () => {
  let s = addCheck(emptyStore(), { cmd: 'node keep.mjs', target: 100 })
  s = addCheck(s, { cmd: 'node bad.mjs', target: 100 })
  s = retireCheck(s, findCheckKeys(s, 'node bad.mjs')[0])
  let body = null
  composeConfirm(
    { baseConfirmCmd: 'node base.mjs', storePath: '/s.json', loopDir: '/run' },
    { loadStore: () => s, writeManifest: (_p, b) => { body = b } },
  )
  assert.equal(body, 'node base.mjs\nnode keep.mjs\n') // bad (retired) is gone
})

// --- driver --forge-retire subcommand (end-to-end) ---

test('--forge-retire tombstones a check by cmd; record persists, the gate stops using it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-retire-'))
  const storePath = checkStorePath(dir)
  saveStore(storePath, addCheck(emptyStore(), { cmd: 'node /x.mjs --needle Y', target: 100, reason: 'r' }))
  const res = spawnSync('node', [join(REPO, 'src/driver.mjs'), '--forge-retire', '--forge-store', storePath, '--check', 'node /x.mjs --needle Y'], { encoding: 'utf8' })
  assert.equal(res.status, 0)
  assert.match(res.stdout, /retired 1/)
  const reloaded = loadStore(storePath)
  assert.equal(listActiveChecks(reloaded).length, 0)  // gate no longer sees it
  assert.equal(reloaded.checks.length, 1)             // record preserved
})

test('--forge-retire exits non-zero when no check matches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-retire-'))
  const storePath = checkStorePath(dir)
  saveStore(storePath, addCheck(emptyStore(), { cmd: 'node /x.mjs', target: 100 }))
  const res = spawnSync('node', [join(REPO, 'src/driver.mjs'), '--forge-retire', '--forge-store', storePath, '--check', 'node /nope.mjs'], { encoding: 'utf8' })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /no stored check matches/)
})
