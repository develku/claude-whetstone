#!/usr/bin/env node
// bench/forge-corroborate-ledger.mjs
// The 2a (differential corroboration) ledger: MEASURE that an independent oracle stops the Forge from
// fossilizing a WRONG confirm oracle. Distinct from forge-ledger.mjs (which measures brittleness on a
// CORRECT held-out confirm): here the primary confirm is itself BUGGY — it accepts a gamed-to-its-bug impl
// ("good") and vetoes the genuinely-correct impl ("bad"). The Forge faithfully distils that buggy judgment
// into a permanent check that rejects correct code forever — UNLESS an independent correct oracle disputes
// the labelling and the Forge declines to learn.
//
// Two arms per scenario, BOTH deterministic and $0 (no model spend): a generate STUB stands in for the
// discriminating check a proposer learns from the false-veto pair; admit + corroborate run the REAL scorers.
//   BEFORE (no --forge-oracle): the discriminating check is admitted + stored -> it REJECTS the genuinely-
//                               correct impl = fossilized-wrong.
//   AFTER  (--forge-oracle = a correct behavioural oracle): the oracle disputes the labelling -> corroborated
//                               = false -> the Forge declines (K=0, conflict flagged) = NOT fossilized.
//
// Run: node bench/forge-corroborate-ledger.mjs   (always $0 — deterministic)
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runForge } from '../src/forge/run.mjs'
import { admitCheck, scorerRunCheck } from '../src/forge/admit.mjs'
import { corroborateLabels } from '../src/forge/corroborate.mjs'
import { addCheck, loadStore, saveStore, listChecks } from '../src/forge/store.mjs'
import { shq } from '../src/shq.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const IO_ASSERT = join(HERE, '..', 'scorers', 'io-assert.mjs')
const tmp = (p) => mkdtempSync(join(tmpdir(), p))
const writeSrc = (src) => { const p = join(tmp('cl-art-'), 'impl.mjs'); writeFileSync(p, src); return p }
const ioCmd = (cases) => `node ${shq(IO_ASSERT)} --fn f ${cases.map((c) => `--case ${shq(c)}`).join(' ')}`

// Each scenario: a BUGGY primary confirm accepted `goodSrc` (gamed to the bug) and vetoed `badSrc` (correct).
//   fossilCase  — the case that discriminates good from bad (good's buggy value); a proposer would learn this.
//   oracleCases — an INDEPENDENT CORRECT spec; it rejects `goodSrc` (catches the bug) -> a corroboration conflict.
//   altCorrect  — other genuinely-correct phrasings, to confirm a fossilized check rejects ALL correct code.
const SCENARIOS = [
  {
    id: 'double-bug',
    goal: 'f(n) = n doubled (the confirm BUG: it demands f(2)===5)',
    goodSrc: 'export const f = (n) => (n === 2 ? 5 : n * 2)\n', // gamed to satisfy the buggy confirm
    badSrc: 'export const f = (n) => n * 2\n', // genuinely correct; the buggy confirm vetoed it
    fossilCase: '2=>5',
    oracleCases: ['2=>4', '3=>6'],
    altCorrect: ['export const f = (n) => n + n\n', 'export const f = (n) => n << 1\n'],
  },
  {
    id: 'max-bug',
    goal: 'f(a,b) = larger of a,b (the confirm BUG: it demands f(5,5)===6)',
    goodSrc: 'export const f = (a, b) => (a === 5 && b === 5 ? 6 : Math.max(a, b))\n',
    badSrc: 'export const f = (a, b) => Math.max(a, b)\n',
    fossilCase: '[5,5]=>6',
    oracleCases: ['[5,5]=>5', '[2,7]=>7'],
    altCorrect: ['export const f = (a, b) => (a > b ? a : b)\n'],
  },
]

async function runArm(sc, withOracle) {
  const goodF = writeSrc(sc.goodSrc)
  const badF = writeSrc(sc.badSrc)
  const storePath = join(tmp('cl-store-'), 'checks.json')
  const learnedCmd = ioCmd([sc.fossilCase]) // the discriminating check a proposer would learn
  const generate = async () => ({ candidates: [{ scorerId: 'io-assert', args: ['--fn', 'f', '--case', sc.fossilCase], cmd: learnedCmd, rationale: '' }], rejected: [], costUsd: 0, tokens: 0 })
  const out = await runForge({
    goal: sc.goal, goodArtifact: goodF, badArtifact: badF,
    scorerCatalog: [], allowlist: new Map(), storePath, maxCandidates: 1,
    generate,
    admit: (a) => admitCheck({ ...a, runCheck: scorerRunCheck }),
    corroborate: withOracle ? (a) => corroborateLabels({ ...a, runCheck: scorerRunCheck }) : undefined,
    oracleCmds: withOracle ? [ioCmd(sc.oracleCases)] : [],
    loadStore, saveStore, addCheck,
  })
  const learned = existsSync(storePath) ? listChecks(loadStore(storePath)) : []
  // fossilized-wrong = a stored check REJECTS the genuinely-correct impl (badSrc) or any alt-correct phrasing.
  const correctFiles = [badF, ...sc.altCorrect.map(writeSrc)]
  const fossilizes = learned.some((c) => correctFiles.some((f) => !scorerRunCheck(c.cmd, f, { target: c.target }).pass))
  return { K: learned.length, corroborated: out.corroborated, conflicts: out.conflicts?.length ?? 0, fossilizes }
}

console.log('\n=== Forge corroboration ledger (2a) — deterministic, $0 ===\n')
console.log('Each scenario: a BUGGY primary confirm accepted a gamed "good" and vetoed the correct "bad".\n')
const rows = []
for (const sc of SCENARIOS) {
  const before = await runArm(sc, false)
  const after = await runArm(sc, true)
  rows.push({ id: sc.id, before, after })
  console.log(`[${sc.id}] ${sc.goal}`)
  console.log(`  BEFORE (no oracle):    K=${before.K}  fossilizes-correct-code=${before.fossilizes ? 'YES (wrong oracle baked in)' : 'no'}`)
  console.log(`  AFTER  (correct oracle): K=${after.K}  corroborated=${after.corroborated}  conflicts=${after.conflicts}  fossilizes-correct-code=${after.fossilizes ? 'YES' : 'no'}\n`)
}

const n = rows.length
const beforeFoss = rows.filter((r) => r.before.fossilizes).length
const afterFoss = rows.filter((r) => r.after.fossilizes).length
const afterDeclined = rows.filter((r) => r.after.corroborated === false && r.after.conflicts > 0).length
console.log('=== aggregate ===')
console.log(`BEFORE: ${beforeFoss}/${n} scenarios fossilize the wrong oracle (a learned check rejects genuinely-correct code)`)
console.log(`AFTER:  ${afterFoss}/${n} fossilize  ·  ${afterDeclined}/${n} correctly DECLINED (corroborated=false, oracle conflict flagged)`)
console.log(
  beforeFoss === n && afterFoss === 0 && afterDeclined === n
    ? `\nreading: differential corroboration converts ${n}/${n} wrong-oracle fossilizations into clean declines. The single-oracle\nceiling is closed for these cases: an independent oracle that disputes the veto stops the Forge from baking a buggy\nconfirm's judgment into a permanent check. (Honest scope: reduces single-oracle dependence; correlated errors unaddressed.)`
    : `\nreading: UNEXPECTED — before=${beforeFoss}/${n} after=${afterFoss}/${n} declined=${afterDeclined}/${n}. Investigate before claiming 2a.`,
)

const reports = join(HERE, 'reports')
if (!existsSync(reports)) mkdirSync(reports, { recursive: true })
writeFileSync(join(reports, 'forge-corroborate-ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
