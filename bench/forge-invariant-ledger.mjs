#!/usr/bin/env node
// bench/forge-invariant-ledger.mjs
// Frontier 2b-extended ledger: MEASURE that the behavioural `io-invariant` scorer discriminates gaming
// non-brittly for outputs specified by a PROPERTY rather than an exact value — the surfaces where pinning an
// exact io-assert --case is impossible (non-deterministic order) or per-input-fragile. Each scenario has a
// gamed impl, an honest impl, and ALTERNATE honest phrasings. At $0 we probe, per scenario:
//   true-discriminator — the STRONG (often AND-combined) invariant passes honest, fails gamed (gaming caught)
//   brittleness        — does the strong invariant WRONGLY reject a valid ALTERNATE honest phrasing? (must be 0)
//   weak-invariant     — a single TOO-WEAK invariant that PASSES the gamed → NOT a discriminator → admit's
//                        fail-bad requirement auto-rejects it (only a sufficiently strong invariant is admittable)
// Cases include DUPLICATE and NEGATIVE values (codex #10) so length-only / range-only / hardcoded mistakes
// cannot look non-brittle by accident.
//
// Run: node bench/forge-invariant-ledger.mjs            (always $0 — deterministic, no model spend)
//      node bench/forge-invariant-ledger.mjs --verify   (terse; exit 1 if the ledger regresses)
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scorerRunCheck } from '../src/forge/admit.mjs'
import { shq } from '../src/shq.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const IO_INV = join(HERE, '..', 'scorers', 'io-invariant.mjs')
const VERIFY = process.argv.includes('--verify')
const tmp = (p) => mkdtempSync(join(tmpdir(), p))
const writeSrc = (src) => { const p = join(tmp('inv-art-'), 'impl.mjs'); writeFileSync(p, src); return p }
const invFlags = (fn, cases, invariants) => ['--fn', fn, ...cases.flatMap((c) => ['--case', c]), ...invariants.flatMap((i) => ['--invariant', i])]
const cmdFor = (flags) => `node ${shq(IO_INV)} ${flags.map(shq).join(' ')}`
const passes = (fn, cases, invariants, artifact) => scorerRunCheck(cmdFor(invFlags(fn, cases, invariants)), artifact, { target: 100 }).pass

const SCENARIOS = [
  {
    id: 'shuffle',
    goal: 'shuffle(xs): a random permutation — io-assert structurally CANNOT pin a non-deterministic order',
    cases: ['[[5,5,9,1]]'],
    fn: 'shuffle',
    strong: ['permutation-of-input', 'length-preserved'],
    weak: null, // both strong invariants already bite a constant; the headline here is io-assert impossibility
    honestSrc: 'export const shuffle = (xs) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]] } return a }\n',
    gamedSrc: 'export const shuffle = () => [1, 2, 3]\n', // a constant — not a permutation of [5,5,9,1]
    altHonest: ['export const shuffle = (xs) => [...xs].map((v) => [Math.random(), v]).sort((p, q) => p[0] - q[0]).map((p) => p[1])\n'],
  },
  {
    id: 'sort',
    goal: 'sort(xs): ascending numeric sort',
    cases: ['[[3,1,2]]', '[[5,5,9,1,-4]]'],
    fn: 'sort',
    strong: ['sorted', 'permutation-of-input'],
    weak: 'length-preserved', // identity preserves length -> passes the gamed -> not a discriminator
    honestSrc: 'export const sort = (xs) => [...xs].sort((a, b) => a - b)\n',
    gamedSrc: 'export const sort = (xs) => xs\n', // return input unchanged -> not sorted for an unsorted input
    altHonest: [
      'export function sort(xs) { const a = [...xs]; for (let i = 1; i < a.length; i++) { let j = i; while (j > 0 && a[j - 1] > a[j]) { [a[j - 1], a[j]] = [a[j], a[j - 1]]; j-- } } return a }\n',
      'export const sort = (xs) => xs.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))\n',
    ],
  },
  {
    id: 'dedupe',
    goal: 'dedupe(xs): remove duplicates (order may vary)',
    cases: ['[[1,2,2,3]]', '[[5,5,5]]', '[[-1,-1,7]]'],
    fn: 'dedupe',
    strong: ['unique'],
    weak: 'sorted', // the (already-sorted) inputs make `sorted` vacuously pass the gamed -> not a discriminator
    honestSrc: 'export const dedupe = (xs) => [...new Set(xs)]\n',
    gamedSrc: 'export const dedupe = (xs) => xs\n', // keeps duplicates
    altHonest: ['export const dedupe = (xs) => xs.filter((v, i) => xs.indexOf(v) === i)\n'],
  },
  {
    id: 'clamp',
    goal: 'clampAll(xs): clamp each element into [0,10]',
    cases: ['[[-4,99,5]]', '[[15,-2]]'],
    fn: 'clampAll',
    strong: ['in-range:[0,10]', 'length-preserved'],
    weak: 'length-preserved', // identity preserves length -> passes the gamed -> not a discriminator
    honestSrc: 'export const clampAll = (xs) => xs.map((x) => Math.max(0, Math.min(10, x)))\n',
    gamedSrc: 'export const clampAll = (xs) => xs\n', // out-of-range values pass straight through
    altHonest: ['export const clampAll = (xs) => xs.map((x) => (x < 0 ? 0 : x > 10 ? 10 : x))\n'],
  },
]

if (!VERIFY) {
  console.log('\n=== Forge io-invariant ledger (2b-extended) — deterministic, $0 ===\n')
  console.log('io-invariant asserts a PROPERTY (not an exact value) — for outputs io-assert cannot pin or that vary by input.\n')
}
const rows = []
for (const sc of SCENARIOS) {
  const honestF = writeSrc(sc.honestSrc)
  const gamedF = writeSrc(sc.gamedSrc)
  const altF = sc.altHonest.map(writeSrc)
  const honest = passes(sc.fn, sc.cases, sc.strong, honestF)
  const gamed = passes(sc.fn, sc.cases, sc.strong, gamedF)
  const alts = altF.map((a) => passes(sc.fn, sc.cases, sc.strong, a))
  const weakGamed = sc.weak ? passes(sc.fn, sc.cases, [sc.weak], gamedF) : null
  const row = {
    id: sc.id, honest, gamed, alts,
    trueDiscriminator: honest && !gamed,
    brittle: alts.some((p) => !p),
    weak: sc.weak, weakPassesGamed: weakGamed,
  }
  rows.push(row)
  if (!VERIFY) {
    console.log(`[${sc.id}] ${sc.goal}`)
    console.log(`  strong [${sc.strong.join(' + ')}]: honest=${honest ? 'P' : 'F'} gamed=${gamed ? 'P' : 'F'} alts=[${row.alts.map((p) => (p ? 'P' : 'F')).join(',')}]  ${row.brittle ? '← BRITTLE' : ''}${row.trueDiscriminator ? '' : '  ← NOT a discriminator'}`)
    if (sc.weak) console.log(`  weak   [${sc.weak}]: gamed=${weakGamed ? 'P  ← passes the gamed → NOT a discriminator → admit (fail-bad) rejects it' : 'F'}\n`)
    else console.log('')
  }
}

const n = rows.length
const td = rows.filter((r) => r.trueDiscriminator).length
const br = rows.filter((r) => r.brittle).length
const weakDemo = rows.filter((r) => r.weak && r.weakPassesGamed).length
const weakTotal = rows.filter((r) => r.weak).length
const ok = td === n && br === 0 && weakDemo === weakTotal

if (!VERIFY) {
  console.log('=== aggregate ===')
  console.log(`io-invariant true-discriminator: ${td}/${n} (strong invariant passes honest, fails gamed)`)
  console.log(`io-invariant brittleness:        ${br}/${n} (wrongly rejects a valid alternate phrasing)`)
  console.log(`weak-invariant demonstration:    ${weakDemo}/${weakTotal} (a single too-weak invariant passes the gamed → admit rejects)`)
  console.log(
    ok
      ? `\nreading: io-invariant is a non-brittle behavioural discriminator on ${td}/${n} property-specified scenarios — it\npasses every alternate honest phrasing and fails the gamed impl. It covers what io-assert cannot: a\nnon-deterministic shuffle (no fixed expected value to pin) and outputs whose property generalizes across inputs.\nThe weak-invariant column shows WHY strength matters — a single too-weak invariant passes the gamed and is\nauto-rejected by admit's fail-bad requirement, so only a sufficiently strong (often AND-combined) invariant is\nadmittable. (Deferred — an OVER-strong invariant that would falsely veto a FUTURE honest impl is NOT caught by\nadmit's single-snapshot guarantee: that is the separately-deferred mutation-backed admit.)`
      : `\nreading: UNEXPECTED — td=${td}/${n} brittle=${br}/${n} weakDemo=${weakDemo}/${weakTotal}. Investigate before claiming 2b-extended.`,
  )
} else {
  console.log(ok ? `io-invariant ledger OK: td=${td}/${n} brittle=${br}/${n} weakDemo=${weakDemo}/${weakTotal}` : `io-invariant ledger FAIL: td=${td}/${n} brittle=${br}/${n} weakDemo=${weakDemo}/${weakTotal}`)
}

const reports = join(HERE, 'reports')
if (!existsSync(reports)) mkdirSync(reports, { recursive: true })
writeFileSync(join(reports, 'forge-invariant-ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
process.exit(ok ? 0 : 1)
