// test/forge-scope-generate.test.mjs — the scope generator sees the FULL changed-file list (so it can reason
// about multi-file-emergent invariants) while still proposing checks scoped to the single target `rel`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildScopeGeneratorPrompt, scopeGenerateCandidates } from '../src/forge/scope-generate.mjs'

test('buildScopeGeneratorPrompt lists all changed files as context but scopes to rel', () => {
  const p = buildScopeGeneratorPrompt({ goal: 'g', rel: 'src/a.mjs', goodContent: 'good', badContent: 'bad', critique: '', scorerCatalog: [{ id: 'io-assert', usage: 'u' }], allChanged: ['src/a.mjs', 'src/b.mjs'] })
  assert.match(p, /Changed file: src\/a\.mjs/)
  assert.match(p, /src\/b\.mjs/) // the sibling changed file appears as context
  assert.doesNotMatch(p, /Exactly ONE file/)
})

test('scopeGenerateCandidates still prepends --rel for the single target', async () => {
  const allowlist = new Map([['io-assert', '/abs/io-assert.mjs']])
  const propose = async () => ({ text: JSON.stringify({ candidates: [{ scorerId: 'io-assert', args: ['--fn', 'f', '--case', '2=>4'], rationale: 'r' }] }) })
  const { candidates } = await scopeGenerateCandidates({ goal: 'g', goodArtifact: '/g', badArtifact: '/b', rel: 'src/a.mjs', scorerCatalog: [], allowlist, propose, allChanged: ['src/a.mjs', 'src/b.mjs'] })
  assert.equal(candidates.length, 1)
  assert.match(candidates[0].cmd, /--rel 'src\/a\.mjs'/)
})
