// test/forge-gate.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gateManifestLines, composeConfirm } from '../src/forge/gate.mjs'
import { shq } from '../src/shq.mjs'
import { runFromConfig, resumeFromConfig } from '../src/driver.mjs'
import { recordPass } from '../src/state.mjs'
import { emptyStore, addCheck, saveStore, checkStorePath } from '../src/forge/store.mjs'

// --- pure ---

test('gateManifestLines lists the base confirm then each check cmd', () => {
  assert.deepEqual(
    gateManifestLines('node base.mjs', [{ cmd: 'node a.mjs --needle X' }, { cmd: 'node b.mjs' }]),
    ['node base.mjs', 'node a.mjs --needle X', 'node b.mjs'],
  )
})

test('gateManifestLines is empty when there are no checks', () => {
  assert.deepEqual(gateManifestLines('node base.mjs', []), [])
})

test('composeConfirm writes a manifest and returns a composite cmd when the store has checks', () => {
  let wrote = null
  const cmd = composeConfirm(
    { baseConfirmCmd: 'node base.mjs', storePath: '/s.json', loopDir: '/run', compositePath: '/c/composite.mjs' },
    { loadStore: () => ({}), listChecks: () => [{ cmd: 'node a.mjs --needle X' }], writeManifest: (p, body) => { wrote = { p, body } } },
  )
  assert.equal(cmd, `node ${shq('/c/composite.mjs')} --scorers-file ${shq('/run/gate-checks.txt')}`)
  assert.equal(wrote.p, '/run/gate-checks.txt')
  assert.equal(wrote.body, 'node base.mjs\nnode a.mjs --needle X\n')
})

test('composeConfirm passes through (no write) when the store is empty', () => {
  let wrote = false
  const cmd = composeConfirm(
    { baseConfirmCmd: 'node base.mjs', storePath: '/s.json', loopDir: '/run' },
    { loadStore: () => ({}), listChecks: () => [], writeManifest: () => { wrote = true } },
  )
  assert.equal(cmd, 'node base.mjs')
  assert.equal(wrote, false)
})

test('composeConfirm passes through a null base confirm (nothing to compose onto)', () => {
  const cmd = composeConfirm(
    { baseConfirmCmd: null, storePath: '/s.json', loopDir: '/run' },
    { loadStore: () => ({}), listChecks: () => [{ cmd: 'node a.mjs' }], writeManifest: () => { throw new Error('should not write') } },
  )
  assert.equal(cmd, null)
})

test('composeConfirm consumes only checks of the run kind (no file/scope cross-poison)', () => {
  let store = addCheck(emptyStore(), { cmd: 'node f.mjs', target: 100 })
  store = addCheck(store, { cmd: 'node io-assert.mjs --rel x.mjs --fn f --case 1=>2', target: 100, kind: 'scope' })
  let body = null
  // default kind 'file' -> only the file check (the no-kind one), never the scope check
  composeConfirm({ baseConfirmCmd: 'node base.mjs', storePath: '/s', loopDir: '/run' }, { loadStore: () => store, writeManifest: (_p, b) => { body = b } })
  assert.equal(body, 'node base.mjs\nnode f.mjs\n')
  // kind 'scope' -> only the scope check
  body = null
  composeConfirm({ baseConfirmCmd: 'node base.mjs', storePath: '/s', loopDir: '/run', kind: 'scope' }, { loadStore: () => store, writeManifest: (_p, b) => { body = b } })
  assert.match(body, /--rel x\.mjs/)
  assert.equal(body.includes('node f.mjs\n'), false)
})

// --- driver integration ---

const trivialDeps = (extra = {}) => ({
  buildContext: () => ({
    evaluate: async () => ({ score: 100, critique: '', review: { score: 100, critique: '' } }),
    persist: (s, ev) => recordPass(s, { score: ev.score, critique: ev.critique, snapshot: 'snapshots/iter_000.txt', reviewRef: 'r' }),
    confirm: async () => ({ score: 100, critique: '' }),
  }),
  act: async () => ({ changed: true }),
  log: () => {},
  ...extra,
})

test('a fresh --forge run composes confirm = base + stored checks', async () => {
  const loopDir = mkdtempSync(join(tmpdir(), 'forge-consume-'))
  const storePath = checkStorePath(loopDir)
  saveStore(storePath, addCheck(emptyStore(), { cmd: 'node /x.mjs --needle Y', target: 100, reason: 'r' }))
  const { state } = await runFromConfig(
    { goal: 'g', artifactPath: join(loopDir, 'a.txt'), scorerCmd: 's', confirmScorerCmd: 'node base.mjs', targetScore: 90, hardCap: 3, loopDir, forge: true, forgeStorePath: storePath },
    trivialDeps(),
  )
  // shq single-quotes both paths (the repo lives under an iCloud path with spaces), so assert by parts.
  assert.ok(state.confirm_scorer_cmd.includes('composite.mjs'))
  assert.ok(state.confirm_scorer_cmd.includes('--scorers-file'))
  assert.ok(state.confirm_scorer_cmd.includes('gate-checks.txt'))
  assert.equal(readFileSync(join(loopDir, 'gate-checks.txt'), 'utf8'), 'node base.mjs\nnode /x.mjs --needle Y\n')
})

test('a SCOPE --forge run composes the scope-kind checks only (kind derived from cfg.scope)', async () => {
  const loopDir = mkdtempSync(join(tmpdir(), 'forge-scope-compose-'))
  const storePath = checkStorePath(loopDir)
  let s = addCheck(emptyStore(), { cmd: 'node /file.mjs', target: 100 }) // file check — must be ignored on a scope run
  s = addCheck(s, { cmd: 'node /scope.mjs --rel x.mjs', target: 100, kind: 'scope' })
  saveStore(storePath, s)
  await runFromConfig(
    { goal: 'g', artifactPath: join(loopDir, 'a.txt'), scope: '/some/repo', scorerCmd: 's', confirmScorerCmd: 'node base.mjs', targetScore: 90, hardCap: 3, loopDir, forge: true, forgeStorePath: storePath },
    trivialDeps(),
  )
  const manifest = readFileSync(join(loopDir, 'gate-checks.txt'), 'utf8')
  assert.ok(manifest.includes('node /scope.mjs --rel x.mjs')) // scope check composed
  assert.equal(manifest.includes('node /file.mjs'), false) // file check NOT composed on a scope run
})

test('without --forge the confirm scorer is unchanged', async () => {
  const loopDir = mkdtempSync(join(tmpdir(), 'forge-consume-'))
  const { state } = await runFromConfig(
    { goal: 'g', artifactPath: join(loopDir, 'a.txt'), scorerCmd: 's', confirmScorerCmd: 'node base.mjs', targetScore: 90, hardCap: 3, loopDir, forge: false },
    trivialDeps(),
  )
  assert.equal(state.confirm_scorer_cmd, 'node base.mjs')
})

test('an empty store leaves the confirm scorer unchanged', async () => {
  const loopDir = mkdtempSync(join(tmpdir(), 'forge-consume-'))
  const storePath = checkStorePath(loopDir) // absent file -> loadStore returns empty
  const { state } = await runFromConfig(
    { goal: 'g', artifactPath: join(loopDir, 'a.txt'), scorerCmd: 's', confirmScorerCmd: 'node base.mjs', targetScore: 90, hardCap: 3, loopDir, forge: true, forgeStorePath: storePath },
    trivialDeps(),
  )
  assert.equal(state.confirm_scorer_cmd, 'node base.mjs')
})

// A below-target run never reaches done -> caps (resumable) without needing a veto.
const wipDeps = (extra = {}) => trivialDeps({
  buildContext: () => ({
    evaluate: async () => ({ score: 50, critique: 'wip', review: { score: 50, critique: 'wip' } }),
    persist: (s, ev) => recordPass(s, { score: ev.score, critique: ev.critique, snapshot: 'snapshots/iter_000.txt', reviewRef: 'r' }),
    confirm: async () => ({ score: 100, critique: '' }),
  }),
  ...extra,
})

test('resuming a composed --forge run does NOT double-wrap the confirm scorer (fresh-only guard)', async () => {
  const loopDir = mkdtempSync(join(tmpdir(), 'forge-resume-'))
  const storePath = checkStorePath(loopDir)
  saveStore(storePath, addCheck(emptyStore(), { cmd: 'node /x.mjs --needle Y', target: 100, reason: 'r' }))
  // fresh run: below-target so it caps (resumable); the composite is composed once and persisted
  const { state: s1 } = await runFromConfig(
    { goal: 'g', artifactPath: join(loopDir, 'a.txt'), scorerCmd: 's', confirmScorerCmd: 'node base.mjs', targetScore: 90, hardCap: 2, loopDir, forge: true, forgeStorePath: storePath },
    wipDeps(),
  )
  assert.ok(s1.confirm_scorer_cmd.includes('composite.mjs'))
  // resume WITH forge flags + a raised cap: the !skipBaseline guard must skip re-composition
  const { state: s2 } = await resumeFromConfig(
    { loopDir, overrides: { hard_cap: 4 }, forge: true, forgeStorePath: storePath, noEscalate: true },
    wipDeps(),
  )
  assert.equal(s2.confirm_scorer_cmd, s1.confirm_scorer_cmd) // identical — not a composite-of-a-composite
})

// --- consume-without-base (v1.8.0 easy-done companion) --------------------------------------------
// The invariant composeConfirm passes through when there is no base confirm (gate.mjs:36), so an unwired
// run never consumed stored checks — everything an easy-done run learned would never bite. The non-invariant
// sibling composeConfirmFromStore (forge/hook.mjs) closes that: run N learns -> run N+1 auto-gets a gate.
import { composeConfirmFromStore } from '../src/forge/hook.mjs'

test('composeConfirmFromStore composes a check-only manifest (no base line) and returns a composite cmd', () => {
  let wrote = null
  const cmd = composeConfirmFromStore(
    { storePath: '/s.json', loopDir: '/run', compositePath: '/c/composite.mjs' },
    { loadStore: () => ({}), listChecks: () => [{ cmd: 'node a.mjs --needle X' }, { cmd: 'node b.mjs' }], writeManifest: (p, body) => { wrote = { p, body } } },
  )
  assert.equal(cmd, `node ${shq('/c/composite.mjs')} --scorers-file ${shq('/run/gate-checks.txt')}`)
  assert.equal(wrote.p, '/run/gate-checks.txt')
  assert.equal(wrote.body, 'node a.mjs --needle X\nnode b.mjs\n')
})

test('composeConfirmFromStore returns null (no write) on an empty store', () => {
  let wrote = false
  const cmd = composeConfirmFromStore(
    { storePath: '/s.json', loopDir: '/run' },
    { loadStore: () => ({}), listChecks: () => [], writeManifest: () => { wrote = true } },
  )
  assert.equal(cmd, null)
  assert.equal(wrote, false)
})

test('composeConfirmFromStore consumes only checks of the requested kind', () => {
  let store = addCheck(emptyStore(), { cmd: 'node f.mjs', target: 100 })
  store = addCheck(store, { cmd: 'node s.mjs --rel x.mjs', target: 100, kind: 'scope' })
  let body = null
  composeConfirmFromStore({ storePath: '/s', loopDir: '/run' }, { loadStore: () => store, writeManifest: (_p, b) => { body = b } })
  assert.equal(body, 'node f.mjs\n')
})

test('a fresh --forge run with NO base confirm auto-composes the gate from stored checks', async () => {
  const loopDir = mkdtempSync(join(tmpdir(), 'forge-autogate-'))
  const storePath = checkStorePath(loopDir)
  saveStore(storePath, addCheck(emptyStore(), { cmd: 'node /x.mjs --needle Y', target: 100, reason: 'r' }))
  const { state } = await runFromConfig(
    { goal: 'g', artifactPath: join(loopDir, 'a.txt'), scorerCmd: 's', targetScore: 90, hardCap: 3, loopDir, forge: true, forgeStorePath: storePath },
    trivialDeps(),
  )
  assert.ok(state.confirm_scorer_cmd.includes('composite.mjs'))
  assert.ok(state.confirm_scorer_cmd.includes('gate-checks.txt'))
  assert.equal(readFileSync(join(loopDir, 'gate-checks.txt'), 'utf8'), 'node /x.mjs --needle Y\n') // NO base line
})

test('a SCOPE --forge run with NO base confirm stays unwired (auto-compose is file-mode only this increment)', async () => {
  const loopDir = mkdtempSync(join(tmpdir(), 'forge-autogate-scope-'))
  const storePath = checkStorePath(loopDir)
  saveStore(storePath, addCheck(emptyStore(), { cmd: 'node /s.mjs --rel x.mjs', target: 100, kind: 'scope' }))
  const { state } = await runFromConfig(
    { goal: 'g', artifactPath: join(loopDir, 'a.txt'), scope: '/some/repo', scorerCmd: 's', targetScore: 90, hardCap: 3, loopDir, forge: true, forgeStorePath: storePath },
    trivialDeps(),
  )
  assert.equal(state.confirm_scorer_cmd, null)
})

test('resuming an AUTO-composed --forge run does NOT re-compose (fresh-only guard)', async () => {
  const loopDir = mkdtempSync(join(tmpdir(), 'forge-autogate-resume-'))
  const storePath = checkStorePath(loopDir)
  saveStore(storePath, addCheck(emptyStore(), { cmd: 'node /x.mjs --needle Y', target: 100, reason: 'r' }))
  const { state: s1 } = await runFromConfig(
    { goal: 'g', artifactPath: join(loopDir, 'a.txt'), scorerCmd: 's', targetScore: 90, hardCap: 2, loopDir, forge: true, forgeStorePath: storePath },
    wipDeps(),
  )
  assert.ok(s1.confirm_scorer_cmd.includes('composite.mjs'))
  const { state: s2 } = await resumeFromConfig(
    { loopDir, overrides: { hard_cap: 4 }, forge: true, forgeStorePath: storePath, noEscalate: true },
    wipDeps(),
  )
  assert.equal(s2.confirm_scorer_cmd, s1.confirm_scorer_cmd)
})
