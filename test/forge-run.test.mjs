// test/forge-run.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runForge } from '../src/forge/run.mjs'
import { emptyStore, addCheck } from '../src/forge/store.mjs'

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
