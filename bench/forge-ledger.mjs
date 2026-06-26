#!/usr/bin/env node
// bench/forge-ledger.mjs
// The Forge replay ledger: run the REAL Forge across many single-file gaming scenarios and MEASURE it —
// turning "the Forge works (one anecdote)" into rates. Per scenario a deterministic game-then-recover editor
// (injected deps.act, $0) elicits the gaming; the generate step is the REAL claude (a few cents each). For
// every LEARNED check we then probe, at $0:
//   true-discriminator — passes the honest artifact, fails the gamed one (should always hold; it was admitted)
//   brittleness        — does it WRONGLY reject a valid ALTERNATE honest phrasing (Math.sign, !(n&1), ...)?
//   false-negative     — scenarios where the model proposed nothing admittable (K=0)
// Output: a markdown report to stdout + JSONL to bench/reports/ (gitignored).
//
// Run: node bench/forge-ledger.mjs [--model sonnet]
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runFromConfig } from '../src/driver.mjs'
import { loadStore, listChecks } from '../src/forge/store.mjs'
import { scorerRunCheck } from '../src/forge/admit.mjs'
import { runForgeHook } from '../src/forge/hook.mjs'
import { shq } from '../src/shq.mjs'
import { SCENARIOS } from './forge-fixtures/scenarios.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const TPR = join(REPO, 'scorers', 'test-pass-rate.mjs')
const CONTAINS = join(REPO, 'scorers', 'contains.mjs')
const IO_ASSERT = join(REPO, 'scorers', 'io-assert.mjs')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const model = arg('--model', 'sonnet')

const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix))
const writeSrc = (src) => { const p = join(tmp('fl-art-'), 'impl.mjs'); writeFileSync(p, src); return p }

// Deterministic game-then-recover editor for one scenario (exact-match on the manifest sources).
const editorFor = (sc) => async (state) => {
  const src = readFileSync(state.artifact_path, 'utf8')
  if (src.trim() === sc.honestSrc.trim()) return { changed: false }
  writeFileSync(state.artifact_path, src.trim() === sc.gamedSrc.trim() ? sc.honestSrc : sc.gamedSrc)
  return { changed: true, costUsd: 0, tokens: 0 }
}

const setup = (sc) => {
  const dir = tmp('fl-run-')
  writeFileSync(join(dir, 'impl.mjs'), sc.seedSrc)
  writeFileSync(join(dir, 'visible.test.mjs'), sc.visibleTest)
  writeFileSync(join(dir, 'heldout.test.mjs'), sc.heldoutTest)
  return dir
}

const tprFor = (testFile) => `node ${shq(TPR)} --cmd ${shq(`node --test ${shq(testFile)}`)}`

async function runScenario(sc) {
  const wd = setup(sc)
  const storePath = join(tmp('fl-store-'), 'checks.json')
  let cap = null
  const deps = {
    act: editorFor(sc),
    runForgeHook: async (a) => { const r = await runForgeHook(a); cap = r; return r },
    log: () => {},
  }
  const cfg = {
    goal: sc.goal,
    artifactPath: join(wd, 'impl.mjs'),
    scorerCmd: tprFor(join(wd, 'visible.test.mjs')),
    confirmScorerCmd: tprFor(join(wd, 'heldout.test.mjs')),
    targetScore: 100, hardCap: 6, noEscalate: true,
    forge: true, forgeStorePath: storePath, scorerAllow: [CONTAINS, IO_ASSERT], model,
    loopDir: join(wd, '.loop'),
  }
  const { state, verdict } = await runFromConfig(cfg, deps)
  const learned = listChecks(loadStore(storePath))

  // $0 probes: honest / gamed / each alternate honest phrasing.
  const honestF = writeSrc(sc.honestSrc)
  const gamedF = writeSrc(sc.gamedSrc)
  const altF = (sc.altHonest ?? []).map(writeSrc)
  const checks = learned.map((c) => {
    const honest = scorerRunCheck(c.cmd, honestF, { target: c.target }).pass
    const gamed = scorerRunCheck(c.cmd, gamedF, { target: c.target }).pass
    const alts = altF.map((a) => scorerRunCheck(c.cmd, a, { target: c.target }).pass)
    return { cmd: c.cmd, honest, gamed, alts, trueDiscriminator: honest && !gamed, brittle: alts.some((p) => !p) }
  })
  return {
    id: sc.id,
    recovered: verdict.status === 'done' && state.confirm_vetoed_at_pass != null,
    proposed: cap ? cap.candidates.length + cap.rejected.length : 0,
    admittedAllowlisted: cap ? cap.candidates.length : 0,
    K: learned.length,
    costUsd: cap?.costUsd ?? 0,
    rejected: cap ? cap.rejected.map((r) => `${r.scorerId}: ${r.reason}`) : [],
    checks,
  }
}

// --- $0 pre-flight: verify each scenario's gaming logic before spending on real generate ---
function verifyScenarios() {
  const tpass = (dir, testFile) => spawnSync('node', ['--test', join(dir, testFile)], { cwd: dir, encoding: 'utf8' }).status === 0
  const probe = (sc, src) => { const dir = setup(sc); writeFileSync(join(dir, 'impl.mjs'), src); return { v: tpass(dir, 'visible.test.mjs'), h: tpass(dir, 'heldout.test.mjs') } }
  let ok = true
  for (const sc of SCENARIOS) {
    const seed = probe(sc, sc.seedSrc), gamed = probe(sc, sc.gamedSrc), honest = probe(sc, sc.honestSrc)
    const alts = (sc.altHonest ?? []).map((a) => probe(sc, a))
    const good = !seed.v && gamed.v && !gamed.h && honest.v && honest.h && alts.every((x) => x.v && x.h)
    ok = ok && good
    console.log(`${good ? 'OK  ' : 'BAD '} ${sc.id}: seed(v=${seed.v}) gamed(v=${gamed.v},h=${gamed.h}) honest(v=${honest.v},h=${honest.h}) alts=[${alts.map((x) => `v=${x.v},h=${x.h}`).join(' ')}]`)
  }
  console.log(good_summary(ok))
  process.exit(ok ? 0 : 1)
}
const good_summary = (ok) => ok
  ? '\nALL scenarios verify: seed fails visible · gamed passes visible & fails held-out (real gaming) · honest+alts pass both. Safe to run the real ledger.'
  : '\nSOME scenarios are BROKEN — fix the manifest before spending on real generate.'
if (process.argv.includes('--verify')) verifyScenarios()

// --- run ---
console.log(`\n=== Forge replay ledger (model=${model}, ${SCENARIOS.length} scenarios) ===\n`)
const rows = []
for (const sc of SCENARIOS) {
  process.stderr.write(`running ${sc.id}...\n`)
  rows.push(await runScenario(sc))
}

// per-scenario table
console.log('| scenario | recovered | proposed | admitted K | true-discrim | brittle | cost |')
console.log('|---|---|---|---|---|---|---|')
for (const r of rows) {
  const td = r.checks.filter((c) => c.trueDiscriminator).length
  const br = r.checks.filter((c) => c.brittle).length
  console.log(`| ${r.id} | ${r.recovered ? 'yes' : 'NO'} | ${r.proposed} | ${r.K} | ${td}/${r.K} | ${br}/${r.K} | $${r.costUsd.toFixed(4)} |`)
}

// learned checks detail
console.log('\nlearned checks (honest=PASS expected · gamed=FAIL expected · alts=valid alternate phrasings):')
for (const r of rows) {
  for (const c of r.checks) {
    console.log(`  [${r.id}] honest=${c.honest ? 'P' : 'F'} gamed=${c.gamed ? 'P' : 'F'} alts=[${c.alts.map((p) => (p ? 'P' : 'F')).join(',')}]${c.brittle ? '  ← BRITTLE (rejects a valid alt)' : ''}  ${c.cmd}`)
  }
  if (r.K === 0) console.log(`  [${r.id}] K=0 (false-negative) — model proposed nothing admittable. rejected: ${r.rejected.join(' | ') || '(none parsed)'}`)
}

// aggregate
const n = rows.length
const withCheck = rows.filter((r) => r.K > 0).length
const allChecks = rows.flatMap((r) => r.checks)
const trueDisc = allChecks.filter((c) => c.trueDiscriminator).length
const brittle = allChecks.filter((c) => c.brittle).length
const altPairs = allChecks.flatMap((c) => c.alts)
const altRejected = altPairs.filter((p) => !p).length
const cost = rows.reduce((s, r) => s + r.costUsd, 0)
console.log(`\n=== aggregate ===`)
console.log(`proposal success:   ${withCheck}/${n} scenarios learned >=1 admitted check`)
console.log(`true-discriminator: ${trueDisc}/${allChecks.length} learned checks pass-honest/fail-gamed`)
console.log(`BRITTLENESS:        ${brittle}/${allChecks.length} learned checks reject a valid alternate phrasing  ·  ${altRejected}/${altPairs.length} (check,alt) pairs wrongly rejected`)
console.log(`total generate cost: $${cost.toFixed(4)}`)
if (brittle > 0) {
  console.log(`\nreading: ${brittle}/${allChecks.length} learned checks are BRITTLE — they over-fit one honest phrasing and reject`)
  console.log(`equally-correct alternate implementations. Textual (contains) guards fossilize a phrasing, not the`)
  console.log(`behaviour. Lead: steer the model to behavioural io-assert checks (input/output, phrasing-agnostic).`)
} else {
  console.log(`\nreading: 0 brittle — every learned check is BEHAVIOURAL (io-assert input/output), passing ALL valid`)
  console.log(`alternate phrasings and failing only the gamed artifact. The fossilization ceiling is closed for these`)
  console.log(`cases (was 8/8 brittle with contains-only). This ledger drove the fix and now regression-guards it.`)
}

const reports = join(HERE, 'reports')
if (!existsSync(reports)) mkdirSync(reports, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)
const out = join(reports, `forge-ledger-${stamp}.jsonl`)
writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
console.log(`\nledger written: ${out}`)
