#!/usr/bin/env node
// bench/forge-scope-realmodel.mjs
// Scope-Forge real-model elicitation: does a REAL model PROPOSE a usable per-file check for a STATEFUL/PURE
// repo file, à la the io-assert/io-trace single-file elicitations? Drives runScopeForgeHook (produce) on a
// real git repo undergoing a one-file gamed->honest recovery, with the REAL claude proposer (no stub). For
// each learned check we classify its type (io-assert/io-trace/contains) and probe (at $0) whether it BITES
// (vetoes the gamed tree, passes the honest tree) and is NON-BRITTLE (passes an alternate honest tree).
//
//   node bench/forge-scope-realmodel.mjs --stub          # $0 harness check (deterministic proposer)
//   node bench/forge-scope-realmodel.mjs --model sonnet   # ~$0.5 real generate
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { runScopeForgeHook } from '../src/forge/scope-hook.mjs'
import { composeConfirm } from '../src/forge/gate.mjs'
import { loadStore, checkStorePath } from '../src/forge/store.mjs'
import { scopeBuildContext } from '../src/scope-context.mjs'
import { shq } from '../src/shq.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const IO_ASSERT = join(REPO, 'scorers', 'io-assert.mjs')
const IO_TRACE = join(REPO, 'scorers', 'io-trace.mjs')
const CONTAINS = join(REPO, 'scorers', 'contains.mjs')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const STUB = process.argv.includes('--stub')
const model = arg('--model', 'sonnet')
const tmp = (p) => mkdtempSync(join(tmpdir(), p))
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
const typeOf = (cmd) => (cmd.includes('io-trace') ? 'io-trace' : cmd.includes('io-assert') ? 'io-assert' : cmd.includes('contains') ? 'contains' : 'other')

const SCENARIOS = [
  { id: 'double', goal: 'src/m.mjs exports f(n) = n doubled', rel: 'src/m.mjs',
    gamed: 'export const f = (n) => n * 3\n', honest: 'export const f = (n) => n * 2\n', alt: 'export const f = (n) => n + n\n',
    stub: { scorerId: 'io-assert', args: ['--fn', 'f', '--case', '2=>4'] } },
  { id: 'max', goal: 'src/m.mjs exports f(a,b) = the larger of a and b', rel: 'src/m.mjs',
    gamed: 'export const f = (a, b) => a\n', honest: 'export const f = (a, b) => Math.max(a, b)\n', alt: 'export const f = (a, b) => (a > b ? a : b)\n',
    stub: { scorerId: 'io-assert', args: ['--fn', 'f', '--case', '[2,7]=>7'] } },
  { id: 'counter', goal: 'src/m.mjs exports makeCounter() returning { inc(), value() }', rel: 'src/m.mjs',
    gamed: 'export const makeCounter = () => ({ inc() {}, value() { return 1 } })\n',
    honest: 'export const makeCounter = () => { let n = 0; return { inc() { return ++n }, value() { return n } } }\n',
    alt: 'export const makeCounter = () => { const c = { n: 0 }; return { inc() { c.n += 1; return c.n }, value() { return c.n } } }\n',
    stub: { scorerId: 'io-trace', args: ['--factory', 'makeCounter', '--trace', '[["inc"],["inc"],["value"]]', '--expect', '[1,2,2]'] } },
]

const commit = (dir, rel, src, msg) => { writeFileSync(join(dir, rel), src); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); return git(dir, 'rev-parse', 'HEAD') }
const stubProposeFor = (sc) => async () => ({ text: JSON.stringify({ candidates: [{ ...sc.stub, rationale: 'held-out behavioural case' }] }) })
const passScorer = (() => { const p = join(tmp('pass-'), 'pass.mjs'); writeFileSync(p, 'process.stdout.write(JSON.stringify({score:100,critique:"",findings:[]}))\n'); return p })()
const BASE = `node ${shq(passScorer)}`

async function runScenario(sc) {
  const repo = tmp('scope-rm-')
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 't@e.com'); git(repo, 'config', 'user.name', 't')
  mkdirSync(join(repo, 'src'))
  const gamedSha = commit(repo, sc.rel, sc.gamed, 'gamed')
  commit(repo, sc.rel, sc.honest, 'honest') // HEAD = honest
  const honestSha = git(repo, 'rev-parse', 'HEAD')
  const storePath = checkStorePath(tmp('scope-rm-store-'))

  const cfg = { forge: true, forgeStorePath: storePath, scorerAllow: [IO_ASSERT, IO_TRACE, CONTAINS], model }
  const state = { goal: sc.goal, artifact_path: repo, last_critique: '', confirm_vetoed_at_pass: 0, history: [{ snapshot: gamedSha }] }
  const deps = STUB ? { propose: stubProposeFor(sc) } : {}
  const r = await runScopeForgeHook({ cfg, state }, deps)
  const learned = loadStore(storePath).checks.filter((c) => c.kind === 'scope')

  // BITE + non-brittle (always $0): compose the scope gate and run it on gamed / honest / alt via gitVerifyAt
  const altSha = commit(repo, sc.rel, sc.alt, 'alt-honest')
  const loopDir = tmp('scope-rm-loop-')
  const composed = composeConfirm({ baseConfirmCmd: BASE, storePath, loopDir, kind: 'scope' })
  const { confirm } = scopeBuildContext(loopDir)
  const verdict = async (sha) => (await confirm({ artifact_path: repo, confirm_scorer_cmd: composed, history: [{ snapshot: sha }] })).score
  const bites = learned.length > 0 && (await verdict(gamedSha)) === 0
  const passesHonest = learned.length > 0 && (await verdict(honestSha)) === 100
  const nonBrittle = learned.length > 0 && (await verdict(altSha)) === 100

  return { id: sc.id, admitted: r.admitted.length, types: learned.map((c) => typeOf(c.cmd)), bites, passesHonest, nonBrittle, costUsd: r.costUsd ?? 0, rejected: (r.rejected || []).map((x) => `${x.scorerId}: ${x.reason}`) }
}

console.log(`\n=== Forge scope real-model elicitation (${STUB ? 'STUB $0 harness check' : `model=${model}`}, ${SCENARIOS.length} scenarios) ===\n`)
const rows = []
for (const sc of SCENARIOS) { process.stderr.write(`running ${sc.id}...\n`); rows.push(await runScenario(sc)) }
for (const r of rows) {
  console.log(`[${r.id}] admitted=${r.admitted} types=[${r.types.join(',')}] bite=${r.bites ? 'VETO' : 'no'} honest=${r.passesHonest ? 'pass' : 'FAIL'} alt=${r.nonBrittle ? 'pass' : 'FAIL'} cost=$${r.costUsd.toFixed(4)}`)
  if (r.admitted === 0) console.log(`   admitted 0 — rejected: ${r.rejected.join(' | ') || '(none)'}`)
}
const n = rows.length
const proposed = rows.filter((r) => r.admitted > 0).length
const behavioural = rows.flatMap((r) => r.types).filter((t) => t === 'io-assert' || t === 'io-trace').length
const allTypes = rows.flatMap((r) => r.types)
const bites = rows.filter((r) => r.bites && r.passesHonest).length
const nonBrittle = rows.filter((r) => r.nonBrittle).length
const cost = rows.reduce((s, r) => s + r.costUsd, 0)
console.log('\n=== aggregate ===')
console.log(`proposal success:        ${proposed}/${n} scenarios learned >=1 scope check`)
console.log(`behavioural (io-assert/io-trace) vs total: ${behavioural}/${allTypes.length} learned checks`)
console.log(`bite (vetoes gamed, passes honest):  ${bites}/${n}`)
console.log(`non-brittle (passes an alt honest tree): ${nonBrittle}/${n}`)
console.log(`total generate cost: $${cost.toFixed(4)}`)
console.log(
  proposed === n && bites === n && nonBrittle === n
    ? `\nreading: ${STUB ? '(stub) harness OK' : `NON-NULL — a real ${model}`} proposes a usable per-file scope check on ${proposed}/${n} repo gamings;\nevery learned check bites (vetoes gamed, passes honest) and is non-brittle. The scope Forge is${STUB ? ' ready for the paid run.' : ' elicited by a real proposer, not just mechanically sound.'}`
    : `\nreading: ${proposed}/${n} proposed · ${bites}/${n} bite · ${nonBrittle}/${n} non-brittle — inspect the per-scenario lines${STUB ? ' (harness issue before spending)' : ''}.`,
)
