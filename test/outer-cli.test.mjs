import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseOuterCli, outerProposalOutsideScope, runOuterCli } from '../src/outer-cli.mjs'

test('parseOuterCli: propose-on-stall defaults ON; --no-propose turns it OFF', () => {
  assert.equal(parseOuterCli(['--scope', 'r', '--objectives', 'm.json']).proposeOnStall, true)
  assert.equal(parseOuterCli(['--scope', 'r', '--objectives', 'm.json', '--no-propose']).proposeOnStall, false)
})

test('outerProposalOutsideScope: refuses a proposal path inside --scope', () => {
  assert.match(outerProposalOutsideScope({ scope: '/repo', proposalOut: '/repo/p.json' }), /OUTSIDE/)
  assert.equal(outerProposalOutsideScope({ scope: '/repo', proposalOut: '/x/p.json' }), null)
})

const PRIOR = {
  goal: 'g', floor: { cmd: 'true', readOnly: ['README.md'] }, global_budget_tokens: 1_000_000_000, objective_cap: 4,
  objectives: [{ id: 'old', goal: 'old', scorer: 'node sc/old.mjs', target: 90, editScope: 'old' }],
  global_held_out: [{ id: 't', scorer: 'node truth/t.mjs', target: 80 }],
}

test('runOuterCli: a converged inner run reports done and writes NO proposal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whet-outer-'))
  try {
    const mPath = join(dir, 'm.json'); writeFileSync(mPath, JSON.stringify(PRIOR))
    const out = []
    const code = await runOuterCli(
      { scope: 'repo', objectives: mPath, proposalOut: join(dir, 'p.json'), proposeOnStall: true, testDirs: ['test'] },
      { runConverge: async () => ({ state: { structural_signal: null }, verdict: { status: 'done', reason: 'all met' } }), planManifest: async () => ({ manifest: {}, report: {} }), planCall: async () => '[]', lsFiles: () => [], log: (s) => out.push(s), errlog: (s) => out.push('ERR:' + s) },
    )
    assert.equal(code, 0)
    assert.ok(!existsSync(join(dir, 'p.json')))
    assert.match(out.join('\n'), /done/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runOuterCli: a replan-worthy stall WRITES a proposal + HUMAN REVIEW, never runs it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whet-outer2-'))
  try {
    const mPath = join(dir, 'm.json'); writeFileSync(mPath, JSON.stringify(PRIOR))
    const outP = join(dir, 'proposal.json')
    const out = []
    let convergeCalls = 0
    const code = await runOuterCli(
      { scope: 'repo', objectives: mPath, proposalOut: outP, proposeOnStall: true, testDirs: ['test'] },
      {
        runConverge: async () => { convergeCalls++; return { state: { structural_signal: 'held_out_fail' }, verdict: { status: 'capped', reason: 'decomposition insufficient' } } },
        planManifest: async (cfg) => ({ manifest: { goal: cfg.goal, floor: cfg.floor, objectives: [{ id: 'new', goal: 'g', scorer: 'node sc/new.mjs', target: 90, editScope: 'new' }] }, report: { coverage_score: 50 }, spentUsd: 0, spentTokens: 0 }),
        planCall: async () => '[]', lsFiles: () => [], log: (s) => out.push(s), errlog: (s) => out.push('ERR:' + s),
      },
    )
    assert.equal(code, 1) // not done
    assert.ok(existsSync(outP)) // the proposal was written
    const written = JSON.parse(readFileSync(outP, 'utf8'))
    assert.deepEqual(written.global_held_out, PRIOR.global_held_out) // truth carried verbatim
    assert.deepEqual(written.objectives.map((o) => o.id), ['new'])
    const joined = out.join('\n')
    assert.match(joined, /HUMAN REVIEW REQUIRED/)
    assert.match(joined, /whetstone-converge --scope repo --objectives/)
    assert.equal(convergeCalls, 1) // inner ran ONCE; the proposal was NOT run
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runOuterCli: refuses when proposing is on but --propose-out is missing', async () => {
  const out = []
  const code = await runOuterCli(
    { scope: 'repo', objectives: 'm.json', proposeOnStall: true },
    { runConverge: async () => ({ state: {}, verdict: { status: 'done' } }), planManifest: async () => ({}), planCall: async () => '[]', lsFiles: () => [], log: (s) => out.push(s), errlog: (s) => out.push('ERR:' + s) },
  )
  assert.equal(code, 2)
  assert.match(out.join('\n'), /propose-out is required/)
})
