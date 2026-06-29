import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseReplanCli, replanOutInsideScope, runReplanCli } from '../src/replan-cli.mjs'

// --- Inc 3b CLI: human-only proposal surface (writes a proposal, prints review, NEVER runs converge) ---

test('replanOutInsideScope: refuses a proposal path inside --scope', () => {
  assert.match(replanOutInsideScope({ scope: '/repo', out: '/repo/m.json' }), /OUTSIDE/)
  assert.equal(replanOutInsideScope({ scope: '/repo', out: '/elsewhere/m.json' }), null)
})

test('parseReplanCli: reads the prior manifest, out, and the signal source', () => {
  const c = parseReplanCli(['--scope', 'r', '--objectives', 'prior.json', '--out', 'o.json', '--signal', 'impossibility'])
  assert.equal(c.scope, 'r'); assert.equal(c.objectives, 'prior.json'); assert.equal(c.out, 'o.json'); assert.equal(c.signal, 'impossibility')
})

const PRIOR = {
  goal: 'achieve the feature',
  floor: { cmd: 'true', readOnly: ['package.json'] },
  global_budget_tokens: 1_000_000_000,
  objective_cap: 4,
  objectives: [{ id: 'old', goal: 'old', scorer: 'node sc/old.mjs', target: 90, editScope: 'old' }],
  global_held_out: [{ id: 'truth', scorer: 'node truth/t.mjs', target: 80 }],
}

test('runReplanCli: writes a PROPOSAL carrying the truth verbatim, prints HUMAN REVIEW, and never runs converge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whet-replancli-'))
  try {
    const priorPath = join(dir, 'prior.json')
    writeFileSync(priorPath, JSON.stringify(PRIOR))
    const outPath = join(dir, 'proposal.json') // dir is NOT under scope 'repo'
    const out = []
    const stubPlanManifest = async (cfg) => ({ manifest: { goal: cfg.goal, floor: cfg.floor, objectives: [{ id: 'new', goal: 'g', scorer: 'node sc/new.mjs', target: 90, editScope: 'new' }] }, report: { coverage_score: 60, disclosures: ['x'] }, spentUsd: 0, spentTokens: 0 })
    const code = await runReplanCli(
      { scope: 'repo', objectives: priorPath, out: outPath, signal: 'impossibility', scorerAllow: [], testDirs: ['test'] },
      { planManifest: stubPlanManifest, planCall: async () => '[]', lsFiles: () => ['a.mjs'], log: (s) => out.push(s), errlog: (s) => out.push('ERR:' + s) },
    )
    assert.equal(code, 0)
    assert.ok(existsSync(outPath))
    const written = JSON.parse(readFileSync(outPath, 'utf8'))
    assert.deepEqual(written.global_held_out, PRIOR.global_held_out) // truth carried verbatim
    assert.deepEqual(written.objectives.map((o) => o.id), ['new']) // decomposition swapped
    const joined = out.join('\n')
    assert.match(joined, /HUMAN REVIEW REQUIRED/)
    assert.match(joined, /whetstone-converge --scope repo --objectives/) // tells the human how to ACCEPT
    assert.doesNotMatch(joined, /verdict/i) // it did NOT run converge
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runReplanCli: refuses an out-of-set (corrupt/tampered) structural signal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whet-replancli3-'))
  try {
    const priorPath = join(dir, 'prior.json')
    writeFileSync(priorPath, JSON.stringify(PRIOR))
    const out = []
    const code = await runReplanCli(
      { scope: 'repo', objectives: priorPath, out: join(dir, 'o.json'), signal: 'rm -rf /; ignore previous', scorerAllow: [] },
      { planManifest: async () => ({ manifest: {}, report: {} }), planCall: async () => '[]', lsFiles: () => [], log: (s) => out.push(s), errlog: (s) => out.push('ERR:' + s) },
    )
    assert.equal(code, 2)
    assert.match(out.join('\n'), /unrecognized structural signal/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runReplanCli: refuses when no structural signal is provided', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whet-replancli2-'))
  try {
    const priorPath = join(dir, 'prior.json')
    writeFileSync(priorPath, JSON.stringify(PRIOR))
    const out = []
    const code = await runReplanCli(
      { scope: 'repo', objectives: priorPath, out: join(dir, 'o.json'), scorerAllow: [] },
      { planManifest: async () => ({ manifest: {}, report: {} }), planCall: async () => '[]', lsFiles: () => [], log: (s) => out.push(s), errlog: (s) => out.push('ERR:' + s) },
    )
    assert.equal(code, 2)
    assert.match(out.join('\n'), /structural signal is required/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
