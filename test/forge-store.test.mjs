// test/forge-store.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyStore, checkKey, addCheck, listChecks, checkStorePath, loadStore, saveStore } from '../src/forge/store.mjs'

const TS = '2026-01-01T00:00:00.000Z' // fixed ts so round-trips deep-equal deterministically

// --- pure logic (no disk) ---

test('emptyStore is a versioned, empty catalogue', () => {
  assert.deepEqual(emptyStore(), { version: 1, checks: [] })
})

test('addCheck appends immutably; the entry carries cmd/target/reason/ts/key', () => {
  const s0 = emptyStore()
  const s1 = addCheck(s0, { cmd: 'node a.mjs', target: 100, reason: 'discriminates', ts: TS })
  assert.equal(s0.checks.length, 0) // input unchanged (immutable)
  assert.equal(s1.checks.length, 1)
  const e = s1.checks[0]
  assert.equal(e.cmd, 'node a.mjs')
  assert.equal(e.target, 100)
  assert.equal(e.reason, 'discriminates')
  assert.equal(e.ts, TS)
  assert.equal(e.key, checkKey({ cmd: 'node a.mjs', target: 100 }))
})

test('addCheck is idempotent on the same {cmd,target} — returns the SAME store', () => {
  const s1 = addCheck(emptyStore(), { cmd: 'node a.mjs', target: 100, ts: TS })
  const s2 = addCheck(s1, { cmd: 'node a.mjs', target: 100, ts: TS })
  assert.equal(s2, s1) // object identity preserved -> caller can detect no-op
  assert.equal(s2.checks.length, 1)
})

test('dedup normalizes whitespace — cosmetically-different same command collapses', () => {
  let s = addCheck(emptyStore(), { cmd: 'node  a.mjs', ts: TS })
  s = addCheck(s, { cmd: 'node a.mjs ', ts: TS })
  assert.equal(s.checks.length, 1)
})

test('the same command at a different target is a distinct gate', () => {
  let s = addCheck(emptyStore(), { cmd: 'node a.mjs', target: 100, ts: TS })
  s = addCheck(s, { cmd: 'node a.mjs', target: 90, ts: TS })
  assert.equal(s.checks.length, 2)
})

test('addCheck rejects a missing/empty cmd (an un-runnable entry is silent corruption)', () => {
  assert.throws(() => addCheck(emptyStore(), { cmd: '' }), TypeError)
  assert.throws(() => addCheck(emptyStore(), { cmd: '   ' }), TypeError)
  assert.throws(() => addCheck(emptyStore(), {}), TypeError)
})

test('addCheck rejects a non-finite target (it would serialize to null and break the gate verdict)', () => {
  assert.throws(() => addCheck(emptyStore(), { cmd: 'node a.mjs', target: NaN }), TypeError)
  assert.throws(() => addCheck(emptyStore(), { cmd: 'node a.mjs', target: Infinity }), TypeError)
})

test('listChecks yields {cmd,target,reason} in admission order and is a defensive copy', () => {
  let s = addCheck(emptyStore(), { cmd: 'node a.mjs', target: 100, reason: 'r1', ts: TS })
  s = addCheck(s, { cmd: 'node b.mjs', target: 90, reason: 'r2', ts: TS })
  const out = listChecks(s)
  assert.deepEqual(out, [
    { cmd: 'node a.mjs', target: 100, reason: 'r1' },
    { cmd: 'node b.mjs', target: 90, reason: 'r2' },
  ])
  out[0].cmd = 'MUTATED'
  out.push({ cmd: 'node c.mjs' })
  assert.equal(s.checks[0].cmd, 'node a.mjs') // store untouched by mutating the projection
  assert.equal(s.checks.length, 2)
})

// --- thin file I/O ---

test('loadStore on an absent file returns an empty store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-store-'))
  assert.deepEqual(loadStore(join(dir, 'nope.json')), emptyStore())
})

test('saveStore + loadStore round-trips, leaving no .tmp behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-store-'))
  const path = checkStorePath(dir)
  let s = addCheck(emptyStore(), { cmd: 'node a.mjs', target: 100, reason: 'r1', ts: TS })
  s = addCheck(s, { cmd: 'node b.mjs', target: 90, reason: 'r2', ts: TS })
  saveStore(path, s)
  assert.deepEqual(loadStore(path), s)
  assert.equal(existsSync(path + '.tmp'), false)
})

test('loadStore throws loud (naming the path) on a malformed store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-store-'))
  const torn = join(dir, 'checks.json')
  writeFileSync(torn, '{not json')
  assert.throws(() => loadStore(torn), /checks\.json|malformed|store/i)
  const noChecks = join(dir, 'shape.json')
  writeFileSync(noChecks, '{"version":1}') // missing the checks array
  assert.throws(() => loadStore(noChecks), /shape\.json|malformed|store/i)
  // load-time boundary must be as strict as addCheck: a hand-edited/foreign file with a
  // whitespace-only cmd or a non-finite (JSON-null) target is un-runnable corruption.
  const wsCmd = join(dir, 'wscmd.json')
  writeFileSync(wsCmd, JSON.stringify({ version: 1, checks: [{ key: 'k', cmd: '   ', target: 100 }] }))
  assert.throws(() => loadStore(wsCmd), /wscmd\.json|malformed|store/i)
  const badTarget = join(dir, 'badtarget.json')
  writeFileSync(badTarget, JSON.stringify({ version: 1, checks: [{ key: 'k', cmd: 'node a.mjs', target: null }] }))
  assert.throws(() => loadStore(badTarget), /badtarget\.json|malformed|store/i)
})
