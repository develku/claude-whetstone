#!/usr/bin/env node
// bench/forge-scope-ledger.mjs
// Scope-Forge MVP ledger: MEASURE the multi-file Forge end-to-end at $0 (real git, deterministic stub
// proposer, no model). Per scenario, a tiny repo undergoes a gamed->honest recovery in ONE file; then:
//   PRODUCE  — runScopeForgeHook learns a per-file scope check (materializing good/bad SHAs to worktrees).
//   BITE     — the learned check, composed (kind-filtered) into the scope confirm, is run via gitVerifyAt
//              against the gamed / honest / an ALTERNATE-honest tree: vetoes gamed, passes honest AND alt.
// Proves the scope check is a true, NON-BRITTLE discriminator that bites on a pristine checkout.
//
// Run: node bench/forge-scope-ledger.mjs   (always $0 — deterministic)
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
const tmp = (p) => mkdtempSync(join(tmpdir(), p))
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()

const SCENARIOS = [
  { id: 'double', goal: 'src/m.mjs exports f(n) = n doubled', rel: 'src/m.mjs', heldout: '2=>4',
    gamed: 'export const f = (n) => n * 3\n', honest: 'export const f = (n) => n * 2\n', alt: 'export const f = (n) => n + n\n' },
  { id: 'max', goal: 'src/m.mjs exports f(a,b) = larger of a,b', rel: 'src/m.mjs', heldout: '[2,7]=>7',
    gamed: 'export const f = (a, b) => a\n', honest: 'export const f = (a, b) => Math.max(a, b)\n', alt: 'export const f = (a, b) => (a > b ? a : b)\n' },
]

const commit = (dir, rel, src, msg) => { writeFileSync(join(dir, rel), src); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); return git(dir, 'rev-parse', 'HEAD') }
const stubProposeFor = (heldout) => async () => ({ text: JSON.stringify({ candidates: [{ scorerId: 'io-assert', args: ['--fn', 'f', '--case', heldout], rationale: 'held-out behavioural case' }] }) })

// always-pass base confirm (ignores --output) so ONLY the learned scope check can veto
const passScorer = (() => { const p = join(tmp('pass-'), 'pass.mjs'); writeFileSync(p, 'process.stdout.write(JSON.stringify({score:100,critique:"",findings:[]}))\n'); return p })()
const BASE = `node ${shq(passScorer)}`

async function runScenario(sc) {
  const repo = tmp('scope-led-')
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 't@e.com'); git(repo, 'config', 'user.name', 't')
  mkdirSync(join(repo, 'src'))
  const gamedSha = commit(repo, sc.rel, sc.gamed, 'gamed')
  const honestSha = commit(repo, sc.rel, sc.honest, 'honest') // HEAD = honest (the recovered good)
  const storePath = checkStorePath(tmp('scope-store-'))

  // PRODUCE
  const cfg = { forge: true, forgeStorePath: storePath, scorerAllow: [IO_ASSERT], model: 'stub' }
  const state = { goal: sc.goal, artifact_path: repo, last_critique: '', confirm_vetoed_at_pass: 0, history: [{ snapshot: gamedSha }] }
  const prod = await runScopeForgeHook({ cfg, state }, { propose: stubProposeFor(sc.heldout) })
  const learned = loadStore(storePath).checks.filter((c) => c.kind === 'scope')

  // BITE — compose the scope gate and run it against gamed / honest / alt via the pristine-worktree confirm
  const altSha = commit(repo, sc.rel, sc.alt, 'alt-honest')
  const loopDir = tmp('scope-loop-')
  const composed = composeConfirm({ baseConfirmCmd: BASE, storePath, loopDir, kind: 'scope' })
  const { confirm } = scopeBuildContext(loopDir)
  const verdict = async (sha) => (await confirm({ artifact_path: repo, confirm_scorer_cmd: composed, history: [{ snapshot: sha }] })).score
  const gamedV = await verdict(gamedSha)
  const honestV = await verdict(honestSha)
  const altV = await verdict(altSha)

  return {
    id: sc.id,
    learned: learned.length,
    admitted: prod.admitted.length,
    bites: gamedV === 0, // vetoes the gamed tree
    passesHonest: honestV === 100,
    nonBrittle: altV === 100, // passes an alternate honest phrasing
  }
}

console.log('\n=== Forge scope ledger (MVP) — deterministic, $0 ===\n')
console.log('Per scenario: a one-file gamed->honest recovery in a real repo; PRODUCE learns a per-file scope check, then BITE runs it on a pristine checkout.\n')
const rows = []
for (const sc of SCENARIOS) { rows.push(await runScenario(sc)) }
for (const r of rows) {
  console.log(`[${r.id}] learned=${r.learned} admitted=${r.admitted}  BITE: gamed=${r.bites ? 'VETO' : 'pass'} honest=${r.passesHonest ? 'pass' : 'FAIL'} alt=${r.nonBrittle ? 'pass' : 'FAIL'}`)
}
const n = rows.length
const learned = rows.filter((r) => r.learned > 0).length
const bites = rows.filter((r) => r.bites && r.passesHonest).length
const nonBrittle = rows.filter((r) => r.nonBrittle).length
console.log('\n=== aggregate ===')
console.log(`produce (learned >=1 scope check): ${learned}/${n}`)
console.log(`bite (vetoes gamed, passes honest): ${bites}/${n}`)
console.log(`non-brittle (passes an alternate honest tree): ${nonBrittle}/${n}`)
console.log(
  learned === n && bites === n && nonBrittle === n
    ? `\nreading: the scope Forge learns a per-file behavioural check from a repo gaming and it BITES on a pristine\ncheckout — vetoing the gamed tree while passing the honest tree AND an alternate honest phrasing (${nonBrittle}/${n}\nnon-brittle). The learn->store->consume loop works on a repo, $0, with checks living outside the editable scope.`
    : `\nreading: UNEXPECTED — learned=${learned}/${n} bites=${bites}/${n} nonBrittle=${nonBrittle}/${n}. Investigate before claiming scope-Forge.`,
)

// --- multi-file: two gamed files in ONE recovery, one behavioural check learned per file ---
const MULTI = { id: 'multi(double+max)', files: [
  { rel: 'src/a.mjs', heldout: '2=>4', gamed: 'export const f = (n) => n * 3\n', honest: 'export const f = (n) => n * 2\n', alt: 'export const f = (n) => n + n\n' },
  { rel: 'src/b.mjs', heldout: '[2,7]=>7', gamed: 'export const f = (a, b) => a\n', honest: 'export const f = (a, b) => Math.max(a, b)\n', alt: 'export const f = (a, b) => (a > b ? a : b)\n' },
] }
// per-file stub: match the UNIQUE "Changed file: <rel>" line (allChanged lists both, so match the prefixed form)
const stubMulti = async (prompt) => {
  const file = MULTI.files.find((f) => prompt.includes(`Changed file: ${f.rel}`))
  return { text: JSON.stringify({ candidates: [{ scorerId: 'io-assert', args: ['--fn', 'f', '--case', file.heldout], rationale: 'held-out' }] }) }
}

async function runMultiScenario(sc) {
  const repo = tmp('scope-led-multi-')
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 't@e.com'); git(repo, 'config', 'user.name', 't')
  mkdirSync(join(repo, 'src'))
  for (const f of sc.files) writeFileSync(join(repo, f.rel), f.gamed)
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'gamed'); const gamedSha = git(repo, 'rev-parse', 'HEAD')
  for (const f of sc.files) writeFileSync(join(repo, f.rel), f.honest)
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'honest'); const honestSha = git(repo, 'rev-parse', 'HEAD')
  const storePath = checkStorePath(tmp('scope-store-multi-'))
  const cfg = { forge: true, forgeStorePath: storePath, scorerAllow: [IO_ASSERT], model: 'stub' }
  const state = { goal: 'multi-file double+max', artifact_path: repo, last_critique: '', confirm_vetoed_at_pass: 0, history: [{ snapshot: gamedSha }] }
  const prod = await runScopeForgeHook({ cfg, state }, { propose: stubMulti, log: () => {} })
  const learned = loadStore(storePath).checks.filter((c) => c.kind === 'scope')
  for (const f of sc.files) writeFileSync(join(repo, f.rel), f.alt)
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'alt'); const altSha = git(repo, 'rev-parse', 'HEAD')
  const loopDir = tmp('scope-loop-multi-')
  const composed = composeConfirm({ baseConfirmCmd: BASE, storePath, loopDir, kind: 'scope' })
  const { confirm } = scopeBuildContext(loopDir)
  const verdict = async (sha) => (await confirm({ artifact_path: repo, confirm_scorer_cmd: composed, history: [{ snapshot: sha }] })).score
  return { id: sc.id, learned: learned.length, admitted: prod.admitted.length, perFile: prod.perFile,
    bites: (await verdict(gamedSha)) === 0, passesHonest: (await verdict(honestSha)) === 100, nonBrittle: (await verdict(altSha)) === 100 }
}

const mf = await runMultiScenario(MULTI)
console.log(`\n[${mf.id}] learned=${mf.learned} admitted=${mf.admitted}  BITE: gamed=${mf.bites ? 'VETO' : 'pass'} honest=${mf.passesHonest ? 'pass' : 'FAIL'} alt=${mf.nonBrittle ? 'pass' : 'FAIL'}  perFile=${mf.perFile.map((p) => p.rel + ':' + p.status).join(' ')}`)
console.log(
  mf.learned === 2 && mf.bites && mf.passesHonest && mf.nonBrittle
    ? `\nreading (multi-file): a 2-file gaming recovery learns ONE behavioural check PER gamed file; composed via the\nkind-filtered gate, BOTH bite on a pristine checkout — vetoing the gamed tree, passing honest AND an alternate\nhonest phrasing. Scope Forge now learns multi-file, $0.`
    : `\nreading: UNEXPECTED multi-file — learned=${mf.learned} bites=${mf.bites} honest=${mf.passesHonest} alt=${mf.nonBrittle}. Investigate.`,
)
