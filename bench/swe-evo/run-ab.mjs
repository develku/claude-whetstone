#!/usr/bin/env node
// bench/swe-evo/run-ab.mjs
// The REAL feasibility/audit/pilot CLI: wires ab.mjs's runAB with Docker+editor seams under design B
// (the editor's checkout is base-only; the runner applies the full gold test_patch in its container).
//
// Modes:
//   --audit   baseline-only veto-opportunity audit: run baseline, grade C+T offline, report
//             P(C or T fail | V pass). The cost FIREBREAK before any 4xN spend.
//   --run     the full 4-arm A/B.
// Common: --instances a,b,c (subset; default all eligible) --cap N --budget-tokens N --model sonnet
//         --effort medium --out <jsonl> --work <dir>.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadInstances } from './dataset.mjs'
import { planSplit } from './split.mjs'
import { dockerRun } from './runner.mjs'
import { computeFixRate, isResolved } from './fixrate.mjs'
import { planArms, buildArmCommand, runAB } from './ab.mjs'
import { formatReport, summarize } from './report.mjs'
import { formatSpend } from '../../src/spend-format.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCOPE_CLI = join(REPO, 'src', 'scope-cli.mjs')
const SCORER = join(REPO, 'bench', 'swe-evo', 'scorer.mjs')
const RUNNER = join(REPO, 'bench', 'swe-evo', 'runner.mjs')

// --- pure: read a finished scope-loop's state.json into an arm result ----------------------------
export function parseArmResult(state) {
  return {
    V: state.best_score ?? null,
    veto: state.confirm_vetoed_at_pass != null ? 1 : 0,
    tokens: state.spent_tokens ?? 0,
    usd: state.spent_usd ?? 0,
  }
}

const git = (dir, ...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' })

// docker cp the repo out of the instance image at base_commit (design B: base only, no gold tests).
function extractCheckout(instance, dest) {
  const name = `whet_${instance.instanceId.replace(/[^a-zA-Z0-9_]/g, '_')}`
  spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' })
  const create = spawnSync('docker', ['create', '--platform', 'linux/amd64', '--name', name, instance.image], { encoding: 'utf8' })
  if (create.status !== 0) throw new Error(`docker create failed for ${instance.image}: ${create.stderr}`)
  const repoDir = instance.repoDir || '/testbed'
  const cp = spawnSync('docker', ['cp', `${name}:${repoDir}`, dest], { encoding: 'utf8' })
  spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' })
  if (cp.status !== 0) throw new Error(`docker cp failed: ${cp.stderr}`)
  return dest
}

// Build a V/C/T context for one instance: a clean base checkout + the node-set + split files the arm
// commands and the offline grader need. Returns null if the instance can't form a V/C/T split.
function setupInstance(instance, { workRoot }) {
  const sp = planSplit({ failToPass: instance.failToPass, passToPass: instance.passToPass })
  if (sp.excluded) return null
  const dir = join(workRoot, instance.instanceId.replace(/[^a-zA-Z0-9_.]/g, '_'))
  mkdirSync(dir, { recursive: true })
  const checkoutDir = join(dir, 'repo')
  if (!existsSync(checkoutDir)) extractCheckout(instance, checkoutDir)
  const instJson = join(dir, 'inst.json')
  writeFileSync(instJson, JSON.stringify({ instanceId: instance.instanceId, image: instance.image, baseCommit: instance.baseCommit, testCmds: instance.testCmds, testPatch: instance.testPatch, passToPass: instance.passToPass, repoDir: instance.repoDir || '/testbed', setup: instance.setup }))
  const allNodes = [...sp.V.nodes, ...sp.C.nodes, ...sp.T.nodes]
  const allFiles = [...new Set([...sp.V.files, ...sp.C.files, ...sp.T.files])]
  const write = (name, obj) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(obj)); return p }
  const paths = {
    scopeCliPath: SCOPE_CLI, scorerPath: SCORER, runnerPath: RUNNER, checkoutDir, instJson,
    vNodes: write('v.json', { failNodes: sp.V.nodes, passToPass: instance.passToPass }),
    cNodes: write('c.json', { failNodes: sp.C.nodes, passToPass: instance.passToPass }),
    allNodes: write('all.json', { failNodes: allNodes, passToPass: instance.passToPass }),
    storeDir: join(dir, 'forge-store'),
  }
  return {
    dir, checkoutDir, paths, split: { vFiles: sp.V.files, cFiles: sp.C.files, allFiles, readOnly: ['tests/', 'test/'] },
    tNodes: sp.T.nodes, tFiles: sp.T.files, baseCommit: instance.baseCommit,
  }
}

// Reset the checkout to a clean base, run one arm's scope-cli loop, read its state.json. The loop's
// status is 'error' only on a THROWN exception (e.g. a transient editor `claude` exit≠0 — more likely
// when nested inside another Claude session). scope-act deliberately fail-fasts on that; we absorb the
// transience at the BENCH level by retrying the whole arm (capped). A legitimate done/capped/plateau is
// kept on the first try — we only retry the error case.
function runArm({ inst, arm, ctx }, { cap, budgetTokens, model, effort, timeoutMs, attempts = 3, log = () => {} }) {
  const loopDir = join(ctx.dir, `loop-${arm.id}`)
  const { argv } = buildArmCommand({ arm, paths: ctx.paths, split: ctx.split, goal: inst.problemStatement, model, effort, cap, budgetTokens })
  const full = [...argv, '--loop-dir', loopDir, '--mcp-config', join(REPO, 'empty-mcp.json')]
  let state
  for (let attempt = 1; attempt <= attempts; attempt++) {
    git(ctx.checkoutDir, 'reset', '--hard', ctx.baseCommit)
    git(ctx.checkoutDir, 'clean', '-fdxq')
    rmSync(loopDir, { recursive: true, force: true })
    rmSync(ctx.paths.storeDir, { recursive: true, force: true })
    const res = spawnSync('node', full, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 })
    const statePath = join(loopDir, 'state.json')
    if (!existsSync(statePath)) throw new Error(`arm ${arm.id} produced no state.json (exit ${res.status}): ${(res.stderr || '').slice(-500)}`)
    state = JSON.parse(readFileSync(statePath, 'utf8'))
    if (state.status !== 'error') break
    log(`  ${inst.instanceId} arm ${arm.id}: transient loop error (${state.status_reason || ''}) attempt ${attempt}/${attempts}${attempt < attempts ? ' — retrying' : ' — giving up'}`)
  }
  return parseArmResult(state)
}

// Grade the final checkout code on the held-out C and T node-sets — ONE docker run over all the F2P files
// (+ P2P via the runner), then Fix-Rate each slice. Held out from every arm, so this is pure measurement.
function gradeArm({ inst, ctx }) {
  const instance = JSON.parse(readFileSync(ctx.paths.instJson, 'utf8'))
  const map = dockerRun({ instance, treeDir: ctx.checkoutDir, testFiles: ctx.split.allFiles })
  const cNodes = JSON.parse(readFileSync(ctx.paths.cNodes, 'utf8')).failNodes
  return {
    C: computeFixRate({ results: map, failNodes: cNodes, passToPass: inst.passToPass }),
    T: computeFixRate({ results: map, failNodes: ctx.tNodes, passToPass: inst.passToPass }),
    resolved: isResolved({ results: map, failNodes: ctx.tNodes, passToPass: inst.passToPass }),
  }
}

// --- CLI -----------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
  const mode = process.argv.includes('--audit') ? 'audit' : process.argv.includes('--run') ? 'run' : null
  if (!mode) { process.stderr.write('usage: run-ab.mjs (--audit | --run) [--instances a,b] [--cap N] [--budget-tokens N] [--model sonnet] [--effort medium] [--out f.jsonl] [--work dir]\n'); process.exit(2) }
  const workRoot = arg('--work', join(REPO, '.loop', 'swe-evo-work'))
  const out = arg('--out', join(workRoot, `${mode}.jsonl`))
  const cap = Number(arg('--cap', '15'))
  const budgetTokens = Number(arg('--budget-tokens', '2000000'))
  const model = arg('--model', 'sonnet')
  const effort = arg('--effort', 'medium')
  const timeoutMs = Number(arg('--timeout-ms', String(45 * 60 * 1000)))
  const want = (arg('--instances', '') || '').split(',').map((s) => s.trim()).filter(Boolean)
  mkdirSync(workRoot, { recursive: true })
  writeFileSync(out, '')

  let all = loadInstances().filter((i) => !planSplit({ failToPass: i.failToPass, passToPass: i.passToPass }).excluded)
  if (want.length) all = all.filter((i) => want.includes(i.instanceId))
  const arms = mode === 'audit' ? planArms().filter((a) => a.id === 'baseline') : planArms()
  process.stderr.write(`run-ab ${mode}: ${all.length} instance(s) x ${arms.length} arm(s), cap=${cap}, model=${model}, budget=${budgetTokens} tok\n`)

  const rows = await runAB({
    instances: all,
    arms,
    setupInstance: async (inst) => { const c = setupInstance(inst, { workRoot }); return c },
    runArm: async (a) => runArm(a, { cap, budgetTokens, model, effort, timeoutMs, log: (m) => process.stderr.write(m + '\n') }),
    gradeTruthFn: async (a) => gradeArm(a),
    write: (line) => appendFileSync(out, line),
    log: (m) => process.stderr.write(m + '\n'),
  })

  process.stdout.write(`\nwrote ${rows.length} rows -> ${out}\n`)
  if (mode === 'audit') {
    // veto-opportunity: among V-passing baselines, how many have C or T failing? (the gate's catch surface)
    const vpass = rows.filter((r) => r.V != null && r.V >= 100)
    const opp = vpass.filter((r) => r.C < 100 || r.T < 100)
    process.stdout.write(`\n=== veto-opportunity audit (baseline) ===\n`)
    for (const r of rows) process.stdout.write(`  ${r.instance_id}: V=${r.V} C=${r.C} T=${r.T} resolved=${r.resolved} spend=${formatSpend({ tokens: r.tokens, costUsd: r.usd })}\n`)
    process.stdout.write(`\nV-pass: ${vpass.length}/${rows.length}   gate-opportunities (V-pass & (C<100 or T<100)): ${opp.length}\n`)
    process.stdout.write(opp.length === 0
      ? 'reading: ~0 gate opportunities -> the A/B is likely UNDERPOWERED; do NOT spend 4xN. Pivot (gaming-pressure variants / design A).\n'
      : `reading: ${opp.length} real V-pass/(C|T)-fail case(s) -> the gate has something to catch; proceed to pilot.\n`)
  } else {
    process.stdout.write('\n' + formatReport(summarize(rows)) + '\n')
  }
}
