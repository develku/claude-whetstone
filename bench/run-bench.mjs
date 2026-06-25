// bench/run-bench.mjs
// The benchmark orchestrator. `sweep` is the pure-ish core: it walks fixture x arm x trial, charges
// each run against a hard total budget (aborting the tail rather than overspending — and counting what
// it dropped, never a silent truncation), and folds the outcomes through aggregate(). The real per-run
// I/O (`runArm`) and the CLI are added in later tasks; `sweep` takes runArm injected so it is unit-
// testable with a fake.
import { aggregate } from './aggregate.mjs'
import { readFileSync, mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { classify } from './adjudicate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SCOPE_CLI = join(REPO, 'src', 'scope-cli.mjs')
const SCORER = join(REPO, 'scorers', 'test-pass-rate.mjs')
const MCP = join(REPO, 'empty-mcp.json')
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' })

export const ARMS = ['fence-on', 'fence-off']

export async function sweep(fixtures, { trials = 3, runArm, totalBudget = Infinity, log = () => {} } = {}) {
  const records = []
  let spent = 0
  let dropped = 0
  for (const fx of fixtures) {
    for (const arm of ARMS) {
      for (let t = 0; t < trials; t++) {
        if (spent >= totalBudget) { dropped++; continue }
        const { bucket, spentUsd = 0 } = await runArm(fx, arm, { trial: t })
        spent += spentUsd
        records.push({ fixture: fx.id, arm, trial: t, bucket })
      }
    }
  }
  if (dropped > 0) log(`budget ${totalBudget} reached after $${spent.toFixed(2)} — dropped ${dropped} planned run(s)`)
  return { records, aggregate: aggregate(records), spent, dropped }
}

export function loadFixture(dir) {
  const meta = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8'))
  return { ...meta, dir }
}

// Run ONE arm on a fresh copy of the fixture repo. fence-on adds --read-only test/ (the only variable).
// Returns the classified record; charges spend to the caller regardless of whether edits were kept.
export async function runArm(fixture, arm, { model = 'haiku', perRunBudget = 1, trial = 0 } = {}) {
  const work = mkdtempSync(join(tmpdir(), `bench-${fixture.id}-`))
  const loopDir = mkdtempSync(join(tmpdir(), `bench-loop-${fixture.id}-`))
  try {
    cpSync(join(fixture.dir, 'repo'), work, { recursive: true })
    git(work, 'init', '-q'); git(work, 'config', 'user.email', 'b@e.com'); git(work, 'config', 'user.name', 'b')
    git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', 'seed')

    const scorer = `node ${shq(SCORER)} --cmd ${shq(fixture.testCmd)}`
    const args = [SCOPE_CLI, fixture.goal, '--scope', work, '--scorer', scorer,
      '--target', String(fixture.target ?? 100), '--cap', String(fixture.cap ?? 4),
      '--budget', String(perRunBudget), '--model', model, '--no-escalate',
      '--mcp-config', MCP, '--loop-dir', loopDir]
    if (arm === 'fence-on') args.push('--read-only', 'test/')
    // Strip node:test worker env vars so nested `node --test` invocations (the fixture scorer)
    // are not silently skipped by Node's recursion guard (NODE_TEST_CONTEXT / NODE_TEST_WORKER_ID).
    const childEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('NODE_TEST_'))
    )
    spawnSync('node', args, { encoding: 'utf8', cwd: work, env: childEnv, timeout: 10 * 60 * 1000, killSignal: 'SIGKILL' })

    let status = 'error', spentUsd = 0, spentTokens = 0
    try {
      const st = JSON.parse(readFileSync(join(loopDir, 'state.json'), 'utf8'))
      status = st.status; spentUsd = st.spent_usd ?? 0; spentTokens = st.spent_tokens ?? 0
    } catch { /* no state.json -> error status */ }

    let oraclePass = null
    if (status === 'done') {
      try { execFileSync('node', [join(fixture.dir, 'oracle', 'oracle.mjs'), work], { stdio: 'pipe' }); oraclePass = true }
      catch { oraclePass = false }
    }
    return { fixture: fixture.id, arm, trial, status, oraclePass, bucket: classify({ status, oraclePass }), spentUsd, spentTokens }
  } finally {
    rmSync(work, { recursive: true, force: true })
    rmSync(loopDir, { recursive: true, force: true })
  }
}
