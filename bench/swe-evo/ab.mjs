#!/usr/bin/env node
// bench/swe-evo/ab.mjs
// The gated-vs-baseline A/B driver core for H1. Per eligible instance it runs whetstone's scope loop under
// 4 arms (same editor model/effort/budget), then grades each arm's final code on the HELD-OUT truth set T:
//   baseline       — gate on V only
//   confirm        — V + held-out C confirm (forge OFF)
//   confirm-forge  — V + C + the Verifier Forge (the full gate)
//   capability     — V scorer = the FULL suite (oracle upper bound, NOT an external SWE-EVO number)
// Outputs, all on T (identifiable because T is held out from EVERY arm): (confirm)-(baseline) = the
// confirm contribution; (confirm-forge)-(confirm) = the forge's marginal; (confirm-forge)-(baseline) =
// the full gate's ΔFix-Rate. See docs/superpowers/specs/2026-06-28-h1-benchmark-adapter-design.md §3.
//
// This module is the ORCHESTRATION + command construction + truth grading — all $0-testable via injected
// seams (setupInstance / runArm / gradeTruthFn). The real seams (docker checkout, spawn scope-cli, spawn
// the runner) are wired by the feasibility/pilot CLI, which can actually exercise Docker.
import { pathToFileURL } from 'node:url'
import { computeFixRate, isResolved } from './fixrate.mjs'
import { shq } from '../../src/shq.mjs'

// The 4 ablation arms. The forge chains on confirm (it needs a held-out confirm to fire), so the order is
// also the dependency order.
export function planArms() {
  return [
    { id: 'baseline', confirm: false, forge: false, capability: false },
    { id: 'confirm', confirm: true, forge: false, capability: false },
    { id: 'confirm-forge', confirm: true, forge: true, capability: false },
    { id: 'capability', confirm: false, forge: false, capability: true },
  ]
}

// A whetstone scorer command that runs the SWE-EVO runner and grades one arm's node-set. The runner is a
// full command (spaces/commas/quotes), so it is passed to scorer.mjs as a SINGLE shq-quoted --runner arg;
// scorer.mjs then spawns it with shell:true. Double-nested shell, each level quoted exactly once.
export function scorerCommand({ scorerPath, runnerPath, instJson, nodesPath, testFiles, reveal }) {
  const runner = `node ${shq(runnerPath)} --instance-json ${shq(instJson)} --test-files ${shq((testFiles || []).join(','))}`
  return `node ${shq(scorerPath)} --nodes ${shq(nodesPath)}${reveal ? ' --reveal-nodes' : ''} --runner ${shq(runner)}`
}

// Construct the scope-cli invocation for one arm. The goal is the instance's problem statement (positional).
// V is always the in-loop --scorer (reveal -> the editor's gradient); +confirm adds a held-out C scorer
// (no reveal -> counts-only critique, source isolation); +forge adds the Forge with a store OUTSIDE the
// scope; capability points the V scorer at the full node-set/test-files (oracle upper bound).
export function buildArmCommand({ arm, paths, split, goal, model, effort, cap, budgetTokens }) {
  const vScorer = scorerCommand({
    scorerPath: paths.scorerPath, runnerPath: paths.runnerPath, instJson: paths.instJson,
    nodesPath: arm.capability ? paths.allNodes : paths.vNodes,
    testFiles: arm.capability ? split.allFiles : split.vFiles,
    reveal: true,
  })
  const argv = [
    paths.scopeCliPath, goal,
    '--scope', paths.checkoutDir,
    '--scorer', vScorer,
    '--read-only', split.readOnly.join(','),
    '--model', model, '--effort', effort,
    '--cap', String(cap), '--budget-tokens', String(budgetTokens),
  ]
  if (arm.confirm) {
    argv.push('--confirm-scorer', scorerCommand({
      scorerPath: paths.scorerPath, runnerPath: paths.runnerPath, instJson: paths.instJson,
      nodesPath: paths.cNodes, testFiles: split.cFiles, reveal: false,
    }))
  }
  if (arm.forge) argv.push('--forge', '--forge-store', paths.storeDir)
  return { cmd: 'node', argv }
}

// Grade an arm's final code on the held-out T set. runResults(tFiles) -> a {node->status} map (the injected
// runner applies T's gold test files in Docker against the final tree). Eq.1 Fix-Rate over T's node-set.
export async function gradeTruth({ tNodes, tFiles, passToPass, runResults }) {
  const results = await runResults(tFiles)
  return {
    T: computeFixRate({ results, failNodes: tNodes, passToPass }),
    resolved: isResolved({ results, failNodes: tNodes, passToPass }),
  }
}

// Drive the whole A/B. setupInstance(inst) -> a ctx (or null to EXCLUDE, e.g. <3 V/C/T clusters); per arm,
// runArm({inst,arm,ctx}) -> {V,C,veto,tokens,usd}; gradeTruthFn({inst,arm,ctx,armRes}) -> {T,resolved}.
// One JSONL row per (instance, arm) is written via write(line). Returns the rows.
export async function runAB({ instances, arms = planArms(), setupInstance, runArm, gradeTruthFn, write, log = () => {} }) {
  const rows = []
  for (const inst of instances) {
    const ctx = await setupInstance(inst)
    if (!ctx) { log(`skip ${inst.instanceId} (excluded — no V/C/T split)`); continue }
    for (const arm of arms) {
      const armRes = await runArm({ inst, arm, ctx })
      const truth = await gradeTruthFn({ inst, arm, ctx, armRes })
      const row = {
        arm: arm.id,
        instance_id: inst.instanceId,
        V: armRes.V ?? null,
        C: truth.C ?? armRes.C ?? null, // design B grades C offline on the final code (held out from every arm)
        T: truth.T,
        resolved: truth.resolved,
        veto: armRes.veto ?? 0,
        tokens: armRes.tokens ?? 0,
        usd: armRes.usd ?? 0,
        status: armRes.status ?? null, // a terminal 'error' marks an arm that produced no measurable result
        error: armRes.error ?? null,
      }
      rows.push(row)
      write(JSON.stringify(row) + '\n')
    }
  }
  return rows
}

// --- $0 stub CLI: demonstrate the orchestration with deterministic seams, no editor, no Docker ----------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--stub')) {
    process.stderr.write('ab.mjs is the A/B driver core; the real Docker run is wired by the feasibility CLI.\n  node bench/swe-evo/ab.mjs --stub   # $0 orchestration demo\n')
    process.exit(2)
  }
  const instances = [{ instanceId: 'demo__a_1_2' }, { instanceId: 'demo__b_3_4' }]
  const lines = []
  const rows = await runAB({
    instances,
    setupInstance: async (inst) => ({ inst }),
    runArm: async ({ arm }) => ({ V: 80, C: arm.confirm ? 60 : null, veto: arm.confirm ? 1 : 0, tokens: 1234, usd: 0.02 }),
    gradeTruthFn: async ({ arm }) => ({ T: arm.capability ? 90 : 40, resolved: false }),
    write: (l) => lines.push(l),
    log: (m) => process.stderr.write(m + '\n'),
  })
  process.stdout.write(lines.join(''))
  process.stderr.write(`\n[stub] orchestration OK — ${rows.length} rows (${instances.length} instances x ${planArms().length} arms), $0.\n`)
}
