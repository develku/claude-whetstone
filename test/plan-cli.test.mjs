import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { parsePlanCli, planOutInsideScope, runPlanCli } from '../src/plan-cli.mjs'
import { convergeRefusal } from '../src/converge-cli.mjs'

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()

function tempRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'whet-pcli-'))
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't')
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'seed')
  return dir
}

const twoGood = {
  objectives: [
    { id: 'auth', goal: 'auth cases', scorerId: 'io-assert', args: ['--case', 'a=>b'], editScope: 'src/auth', target: 85 },
    { id: 'api', goal: 'api cases', scorerId: 'contains', args: ['--needle', 'ok'], editScope: 'src/api', target: 80 },
  ],
}
const stub = (reply) => async () => ({ text: JSON.stringify(reply) })

function baseCfg(scope, out, over = {}) {
  return {
    goal: 'raise coverage', scope, out, scorerAllow: [], floorCmd: 'true', floorReadOnly: ['README.md'],
    globalBudgetTokens: 100_000_000, objectiveCap: 6, minTarget: 70, maxObjectives: 12,
    plannerModel: 'opus', mcpConfig: null, testDirs: ['test'], andConverge: false, parallel: false, ...over,
  }
}
const lsStub = () => ['src/auth/a.mjs', 'src/api/b.mjs', 'README.md']
const collect = () => { const out = []; return { fn: (s) => out.push(s), out } }

test('parsePlanCli: parses the flags; --and-converge defaults OFF', () => {
  const cfg = parsePlanCli(['--goal', 'g', '--scope', '/r', '--out', '/o.json', '--floor-cmd', 'npm test', '--floor-read-only', 'package.json,jest.config.js', '--scorer-allow', '/a.mjs,/b.mjs'])
  assert.equal(cfg.goal, 'g')
  assert.equal(cfg.out, '/o.json')
  assert.deepEqual(cfg.floorReadOnly, ['package.json', 'jest.config.js'])
  assert.deepEqual(cfg.scorerAllow, ['/a.mjs', '/b.mjs'])
  assert.equal(cfg.andConverge, false) // default OFF
  assert.equal(cfg.plannerModel, 'opus')
})

test('planOutInsideScope: refuses an --out under --scope; allows one outside', () => {
  assert.match(planOutInsideScope({ scope: '/repo', out: '/repo/objectives.json' }), /OUTSIDE/)
  assert.equal(planOutInsideScope({ scope: '/repo', out: '/elsewhere/objectives.json' }), null)
})

test('runPlanCli: writes the manifest OUTSIDE scope + sidecar report; it re-passes convergeRefusal from disk; exit 0', async () => {
  const scope = tempRepo({ 'src/auth/a.mjs': 'x', 'src/api/b.mjs': 'y', 'README.md': 'hi' })
  const outDir = mkdtempSync(join(tmpdir(), 'whet-pout-'))
  const out = join(outDir, 'objectives.json')
  const log = collect()
  try {
    const code = await runPlanCli(baseCfg(scope, out), { planCall: stub(twoGood), lsFiles: lsStub, log: log.fn, errlog: log.fn })
    assert.equal(code, 0)
    assert.ok(existsSync(out)) // manifest written OUTSIDE scope
    assert.ok(existsSync(join(outDir, 'objectives.plan-report.json'))) // sidecar report
    const manifest = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(manifest.objectives.length, 2)
    assert.equal(convergeRefusal({ scope, objectivesPath: out, manifest }), null) // re-passes the verbatim gate from disk
    // the loud disclosures are printed
    const printed = log.out.join('\n')
    assert.match(printed, /GATE-DID-NOT-PROVE/)
    assert.match(printed, /objectives_sufficiency: unproven/)
    assert.match(printed, /coverage_score/)
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(outDir, { recursive: true, force: true })
  }
})

test('runPlanCli: refuses (exit 2) when --out is INSIDE --scope', async () => {
  const scope = tempRepo({ 'README.md': 'hi' })
  const log = collect()
  try {
    const code = await runPlanCli(baseCfg(scope, join(scope, 'objectives.json')), { planCall: stub(twoGood), lsFiles: lsStub, log: log.fn, errlog: log.fn })
    assert.equal(code, 2)
    assert.match(log.out.join('\n'), /OUTSIDE/)
  } finally { rmSync(scope, { recursive: true, force: true }) }
})

test('runPlanCli: refuses (exit 2) when --floor-read-only is missing', async () => {
  const scope = tempRepo({ 'README.md': 'hi' })
  const outDir = mkdtempSync(join(tmpdir(), 'whet-pout-'))
  const log = collect()
  try {
    const code = await runPlanCli(baseCfg(scope, join(outDir, 'o.json'), { floorReadOnly: [] }), { planCall: stub(twoGood), lsFiles: lsStub, log: log.fn, errlog: log.fn })
    assert.equal(code, 2)
    assert.match(log.out.join('\n'), /floor-read-only/)
  } finally { rmSync(scope, { recursive: true, force: true }); rmSync(outDir, { recursive: true, force: true }) }
})

test('runPlanCli: a planner refusal (sub-floor target) propagates exit 2 and writes NO manifest', async () => {
  const scope = tempRepo({ 'README.md': 'hi' })
  const outDir = mkdtempSync(join(tmpdir(), 'whet-pout-'))
  const out = join(outDir, 'o.json')
  const gaming = { objectives: [{ id: 'g', goal: 'x', scorerId: 'io-assert', args: [], editScope: 'src/g', target: 10 }] }
  const log = collect()
  try {
    const code = await runPlanCli(baseCfg(scope, out), { planCall: stub(gaming), lsFiles: lsStub, log: log.fn, errlog: log.fn })
    assert.equal(code, 2)
    assert.equal(existsSync(out), false) // no manifest written on refusal
    assert.match(log.out.join('\n'), /target/)
  } finally { rmSync(scope, { recursive: true, force: true }); rmSync(outDir, { recursive: true, force: true }) }
})

test('runPlanCli: --and-converge chains into the injected converge backend (done -> exit 0), threading coverageScore', async () => {
  const scope = tempRepo({ 'src/auth/a.mjs': 'x', 'src/api/b.mjs': 'y', 'README.md': 'hi' })
  const outDir = mkdtempSync(join(tmpdir(), 'whet-pout-'))
  const log = collect()
  let convergedWith = null
  const converge = async (cfg, manifest) => { convergedWith = { cfg, manifest }; return { verdict: { status: 'done', reason: 'all DECLARED objectives met' } } }
  try {
    const code = await runPlanCli(baseCfg(scope, join(outDir, 'o.json'), { andConverge: true }), { planCall: stub(twoGood), lsFiles: lsStub, converge, log: log.fn, errlog: log.fn })
    assert.equal(code, 0)
    assert.equal(convergedWith.manifest.objectives.length, 2) // the generated manifest was handed to converge
    assert.equal(typeof convergedWith.cfg.coverageScore, 'number') // report-only span threaded into the ledger cfg (LOW2)
  } finally { rmSync(scope, { recursive: true, force: true }); rmSync(outDir, { recursive: true, force: true }) }
})

test('runPlanCli: --and-converge with a non-done verdict returns exit 1', async () => {
  const scope = tempRepo({ 'src/auth/a.mjs': 'x', 'src/api/b.mjs': 'y', 'README.md': 'hi' })
  const outDir = mkdtempSync(join(tmpdir(), 'whet-pout-'))
  const log = collect()
  const converge = async () => ({ verdict: { status: 'capped', reason: 'cap reached' } })
  try {
    const code = await runPlanCli(baseCfg(scope, join(outDir, 'o.json'), { andConverge: true }), { planCall: stub(twoGood), lsFiles: lsStub, converge, log: log.fn, errlog: log.fn })
    assert.equal(code, 1)
  } finally { rmSync(scope, { recursive: true, force: true }); rmSync(outDir, { recursive: true, force: true }) }
})

test('runPlanCli: a planCall that throws surfaces as exit 2 (not an uncaught crash)', async () => {
  const scope = tempRepo({ 'README.md': 'hi' })
  const outDir = mkdtempSync(join(tmpdir(), 'whet-pout-'))
  const log = collect()
  const boom = async () => { throw new Error('rate limit') }
  try {
    const code = await runPlanCli(baseCfg(scope, join(outDir, 'o.json')), { planCall: boom, lsFiles: lsStub, log: log.fn, errlog: log.fn })
    assert.equal(code, 2)
    assert.match(log.out.join('\n'), /planner call failed|rate limit/)
  } finally { rmSync(scope, { recursive: true, force: true }); rmSync(outDir, { recursive: true, force: true }) }
})
