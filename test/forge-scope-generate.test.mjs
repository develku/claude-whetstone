// test/forge-scope-generate.test.mjs — the scope generator sees the FULL changed-file list (so it can reason
// about multi-file-emergent invariants) while still proposing checks scoped to the single target `rel`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('scopeGenerateCandidates REJECTS a scorer id not in the allowlist (scope-mode trust gate)', async () => {
  // a model proposing a non-allowlisted id must be rejected and never resolved into a runnable cmd — the
  // multi-file twin of generate.mjs's tested 'ghost' rejection (a recognized standard the scope path must meet).
  const allowlist = new Map([['io-assert', '/abs/io-assert.mjs']])
  const propose = async () => ({ text: JSON.stringify({ candidates: [
    { scorerId: 'io-assert', args: ['--fn', 'f', '--case', '2=>4'] },
    { scorerId: 'evil', args: ['--cmd', 'rm -rf /'] },
  ] }) })
  const { candidates, rejected } = await scopeGenerateCandidates({ goal: 'g', goodArtifact: '/g', badArtifact: '/b', rel: 'src/a.mjs', scorerCatalog: [], allowlist, propose, allChanged: ['src/a.mjs'] })
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].scorerId, 'io-assert')
  assert.deepEqual(rejected, [{ scorerId: 'evil', reason: 'not in allowlist' }])
  assert.ok(candidates.every((c) => !c.cmd.includes('evil'))) // the rejected id never reaches a runnable cmd
})

test('scopeGenerateCandidates handles a file present on only one side (safeRead -> "(absent)", no crash)', async () => {
  // a file added/deleted between the good/bad SHAs makes one readFileSync throw; safeRead must swallow ENOENT
  // to '(absent)' and still fire — a live multi-file path (scope-hook materializes two SHAs).
  const dir = mkdtempSync(join(tmpdir(), 'scope-gen-'))
  const goodRoot = join(dir, 'good'); mkdirSync(join(goodRoot, 'src'), { recursive: true })
  writeFileSync(join(goodRoot, 'src', 'a.mjs'), 'export const f = (n) => n * 2\n') // present on good
  const badRoot = join(dir, 'bad'); mkdirSync(badRoot, { recursive: true }) // src/a.mjs ABSENT on bad
  let seenPrompt = ''
  const propose = async (p) => { seenPrompt = p; return { text: JSON.stringify({ candidates: [{ scorerId: 'io-assert', args: ['--fn', 'f', '--case', '2=>4'] }] }) } }
  const allowlist = new Map([['io-assert', '/abs/io-assert.mjs']])
  const { candidates } = await scopeGenerateCandidates({ goal: 'g', goodArtifact: goodRoot, badArtifact: badRoot, rel: 'src/a.mjs', scorerCatalog: [], allowlist, propose, allChanged: ['src/a.mjs'] })
  assert.equal(candidates.length, 1) // still fired, no throw on the missing side
  assert.match(seenPrompt, /\(absent\)/) // the missing bad side rendered as (absent)
})
