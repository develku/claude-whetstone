// test/forge-run.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runForge } from '../src/forge/run.mjs'
import { emptyStore, addCheck, checkKey } from '../src/forge/store.mjs'

// In-memory store ops so the cycle is tested with no disk.
const memStore = () => {
  let store = emptyStore()
  return { loadStore: () => store, saveStore: (_p, s) => { store = s }, get: () => store }
}
const base = (over = {}) => ({
  goal: 'g', goodArtifact: '/good', badArtifact: '/bad', scorerCatalog: [{ id: 'contains', usage: '' }],
  allowlist: new Map([['contains', '/contains.mjs']]), storePath: '/checks.json', addCheck,
  ...over,
})

test('runForge generates, admits, and stores the admitted checks', async () => {
  const m = memStore()
  const generate = async () => ({ candidates: [{ scorerId: 'contains', args: ['--needle', 'X'], cmd: 'node /contains.mjs --needle X', rationale: 'r' }], rejected: [], costUsd: 0.04, tokens: 11 })
  const admit = async () => ({ admit: true, reason: 'discriminates' })
  const out = await runForge(base({ generate, admit, ...m }))
  assert.equal(out.admitted.length, 1)
  assert.equal(out.admitted[0].cmd, 'node /contains.mjs --needle X')
  assert.equal(m.get().checks.length, 1)
  assert.equal(m.get().checks[0].cmd, 'node /contains.mjs --needle X')
  assert.equal(out.costUsd, 0.04)
  assert.equal(out.tokens, 11)
})

test('runForge excludes admit-rejected candidates and never writes an empty store', async () => {
  const generate = async () => ({ candidates: [{ scorerId: 'contains', args: [], cmd: 'node /contains.mjs', rationale: '' }], rejected: [{ scorerId: 'ghost', reason: 'not in allowlist' }] })
  const admit = async () => ({ admit: false, reason: 'passes a known-bad artifact — trivial' })
  let saved = false
  const out = await runForge(base({ generate, admit, loadStore: () => emptyStore(), saveStore: () => { saved = true } }))
  assert.equal(out.admitted.length, 0)
  assert.equal(out.rejected.length, 2)
  assert.equal(saved, false)
})

test('runForge: corroboration DECLINE returns early (generate never called) with a FULL backward-compatible shape', async () => {
  let genCalls = 0
  const generate = async () => { genCalls++; return { candidates: [], rejected: [] } }
  const corroborate = async () => ({ corroborated: false, conflicts: [{ oracleCmd: 'o', reason: 'disputed' }], excluded: [] })
  const out = await runForge(base({ generate, admit: async () => ({ admit: true }), corroborate, oracleCmds: ['o'], ...memStore() }))
  assert.equal(genCalls, 0) // declined BEFORE the expensive generate ($0)
  // every existing consumer key is present (driver.mjs/bench read admitted/rejected/candidates/costUsd/tokens)
  assert.deepEqual(out, { admitted: [], rejected: [], candidates: [], costUsd: 0, tokens: 0, conflicts: [{ oracleCmd: 'o', reason: 'disputed' }], excluded: [], corroborated: false })
})

test('runForge: corroboration PASS proceeds to generate->admit->store and reports corroborated:true', async () => {
  const m = memStore()
  const generate = async () => ({ candidates: [{ scorerId: 'contains', args: ['--needle', 'X'], cmd: 'node /contains.mjs --needle X', rationale: 'r' }], rejected: [], costUsd: 0.02, tokens: 5 })
  const corroborate = async () => ({ corroborated: true, conflicts: [], excluded: [] })
  const out = await runForge(base({ generate, admit: async () => ({ admit: true, reason: 'ok' }), corroborate, oracleCmds: ['o'], ...m }))
  assert.equal(out.corroborated, true)
  assert.equal(out.admitted.length, 1)
  assert.equal(m.get().checks.length, 1)
})

test('runForge: no corroborate injected -> unchanged behavior, return carries corroborated:true', async () => {
  const m = memStore()
  const generate = async () => ({ candidates: [{ scorerId: 'contains', args: [], cmd: 'node /contains.mjs', rationale: '' }], rejected: [] })
  const out = await runForge(base({ generate, admit: async () => ({ admit: true, reason: 'ok' }), ...m }))
  assert.equal(out.corroborated, true)
  assert.equal(out.admitted.length, 1)
})

test('runForge: kind is threaded to the stored record (scope checks are tagged)', async () => {
  const m = memStore()
  const generate = async () => ({ candidates: [{ scorerId: 'io-assert', args: [], cmd: 'node /io-assert.mjs --rel src/x.mjs --fn f --case 1=>2', rationale: '' }], rejected: [] })
  await runForge(base({ generate, admit: async () => ({ admit: true, reason: 'ok' }), kind: 'scope', ...m }))
  assert.equal(m.get().checks[0].kind, 'scope')
})

test('runForge: a re-proposed PREVIOUSLY-RETIRED check is classified rejected, not admitted (accurate accounting)', async () => {
  const cmd = 'node /contains.mjs --needle X'
  const retiredStore = { version: 1, checks: [], retired: [{ key: checkKey({ cmd, target: 100 }), reason: 'manually retired', ts: 't' }] }
  let saved = false
  const generate = async () => ({ candidates: [{ scorerId: 'contains', args: ['--needle', 'X'], cmd, rationale: 'r' }], rejected: [] })
  const out = await runForge(base({ generate, admit: async () => ({ admit: true, reason: 'discriminates' }), loadStore: () => retiredStore, saveStore: () => { saved = true } }))
  assert.equal(out.admitted.length, 0)
  assert.equal(out.rejected.length, 1)
  assert.match(out.rejected[0].reason, /retired/i)
  assert.equal(saved, false) // nothing newly admitted -> no write
})
