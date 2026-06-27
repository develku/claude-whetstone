#!/usr/bin/env node
// bench/forge-effect-ledger.mjs
// io-effect ledger (item 3, "2b-extended trace form"): MEASURE that the SIDE-EFFECT scorer discriminates a
// gamed "returns-right-but-doesn't-mutate" impl non-brittly on surfaces a RETURNS-only scorer (io-assert /
// io-trace) structurally CANNOT observe. Deterministic, $0. Per scenario:
//   io-effect true-discriminator — passes the honest mutator, fails the gamed non-mutator
//   io-effect brittleness        — does it WRONGLY reject a valid ALTERNATE honest impl? (must be 0)
//   returns-check gap            — an io-assert RETURNS check (the natural returns-only attempt) FAILS the honest
//                                   impl (it returns undefined, not the sink), so it can't even be admitted — the
//                                   surface is INVISIBLE to returns-only scorers, which is why io-effect exists.
//
// Run: node bench/forge-effect-ledger.mjs            (always $0)
//      node bench/forge-effect-ledger.mjs --verify   (terse; exit 1 if it regresses)
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scorerRunCheck } from '../src/forge/admit.mjs'
import { shq } from '../src/shq.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const IO_EFFECT = join(HERE, '..', 'scorers', 'io-effect.mjs')
const IO_ASSERT = join(HERE, '..', 'scorers', 'io-assert.mjs')
const VERIFY = process.argv.includes('--verify')
const writeSrc = (src) => { const p = join(mkdtempSync(join(tmpdir(), 'eff-led-')), 'impl.mjs'); writeFileSync(p, src); return p }
const effectCmd = (fn, sink, calls, expectSink) => `node ${shq(IO_EFFECT)} --fn ${shq(fn)} --sink ${shq(JSON.stringify(sink))} --calls ${shq(JSON.stringify(calls))} --expect-sink ${shq(JSON.stringify(expectSink))}`
const assertCmd = (fn, input, output) => `node ${shq(IO_ASSERT)} --fn ${shq(fn)} --case ${shq(`${JSON.stringify(input)}=>${JSON.stringify(output)}`)}`
const passes = (cmd, artifact) => scorerRunCheck(cmd, artifact, { target: 100 }).pass

const SCENARIOS = [
  {
    id: 'sortInPlace',
    fn: 'sortInPlace', sink: [3, 1, 2], calls: [[]], expectSink: [1, 2, 3],
    honestSrc: 'export const sortInPlace = (arr) => { arr.sort((a, b) => a - b) }\n',
    gamedSrc: 'export const sortInPlace = (arr) => [...arr].sort((a, b) => a - b)\n', // returns sorted, LEAVES the input
    altHonest: ['export function sortInPlace(arr) { for (let i = 1; i < arr.length; i++) { let j = i; while (j > 0 && arr[j - 1] > arr[j]) { [arr[j - 1], arr[j]] = [arr[j], arr[j - 1]]; j-- } } }\n'],
    returnsAttempt: { input: [[3, 1, 2]], output: [1, 2, 3] }, // io-assert returns-check the natural way -> fails honest (undefined)
  },
  {
    id: 'logEvent',
    fn: 'logEvent', sink: [], calls: [['a'], ['b'], ['c']], expectSink: ['a', 'b', 'c'],
    honestSrc: 'export const logEvent = (sink, e) => { sink.push(e) }\n',
    gamedSrc: 'export const logEvent = (sink, e) => e\n', // returns e but never pushes
    altHonest: ['export const logEvent = (sink, e) => { sink[sink.length] = e }\n'],
    returnsAttempt: { input: [[], 'a'], output: ['a'] },
  },
  {
    id: 'tally',
    fn: 'tally', sink: {}, calls: [['x'], ['x'], ['y']], expectSink: { x: 2, y: 1 },
    honestSrc: 'export const tally = (counts, k) => { counts[k] = (counts[k] ?? 0) + 1 }\n',
    gamedSrc: 'export const tally = (counts, k) => (counts[k] ?? 0) + 1\n', // returns the count, never stores it
    altHonest: ['export const tally = (counts, k) => { if (!(k in counts)) counts[k] = 0; counts[k] += 1 }\n'],
    returnsAttempt: { input: [{}, 'x'], output: { x: 1 } },
  },
]

const rows = []
for (const sc of SCENARIOS) {
  const honestF = writeSrc(sc.honestSrc), gamedF = writeSrc(sc.gamedSrc)
  const altF = sc.altHonest.map(writeSrc)
  const eff = effectCmd(sc.fn, sc.sink, sc.calls, sc.expectSink)
  const honest = passes(eff, honestF)
  const gamed = passes(eff, gamedF)
  const alts = altF.map((a) => passes(eff, a))
  const retCmd = assertCmd(sc.fn, sc.returnsAttempt.input, sc.returnsAttempt.output)
  const returnsOnHonest = passes(retCmd, honestF) // a returns-only check CANNOT pass the honest mutator
  rows.push({
    id: sc.id, honest, gamed, alts,
    trueDiscriminator: honest && !gamed,
    brittle: alts.some((p) => !p),
    returnsCheckPassesHonest: returnsOnHonest,
  })
}

const n = rows.length
const td = rows.filter((r) => r.trueDiscriminator).length
const br = rows.filter((r) => r.brittle).length
const gap = rows.filter((r) => !r.returnsCheckPassesHonest).length // returns-only check CAN'T pass honest -> gap proven
const ok = td === n && br === 0 && gap === n

if (!VERIFY) {
  console.log('\n=== Forge io-effect ledger (item 3, 2b-extended trace form) — deterministic, $0 ===\n')
  console.log('io-effect asserts the POST-CALL state of a carried mutable first arg (the "sink") — for surfaces whose\ncontract is a SIDE EFFECT (in-place mutation, an accumulator/logger) and whose RETURN is undefined.\n')
  for (const r of rows) {
    console.log(`[${r.id}]`)
    console.log(`  io-effect: honest=${r.honest ? 'P' : 'F'} gamed=${r.gamed ? 'P' : 'F'} alts=[${r.alts.map((p) => (p ? 'P' : 'F')).join(',')}]  ${r.brittle ? '← BRITTLE' : ''}${r.trueDiscriminator ? ' ✓ discriminates' : '  ← NOT a discriminator'}`)
    console.log(`  returns-only check on honest: ${r.returnsCheckPassesHonest ? 'PASS (unexpected!)' : 'FAIL ← io-assert/io-trace CANNOT observe this side effect (the gap io-effect fills)'}\n`)
  }
  console.log('=== aggregate ===')
  console.log(`io-effect true-discriminator: ${td}/${n} (passes honest mutator, fails gamed non-mutator)`)
  console.log(`io-effect brittleness:        ${br}/${n} (wrongly rejects a valid alternate honest impl)`)
  console.log(`returns-only gap proven:      ${gap}/${n} (a returns check fails the honest impl — invisible surface)`)
  console.log(
    ok
      ? `\nreading: NON-NULL — io-effect is a non-brittle discriminator on ${td}/${n} side-effect surfaces, and on ${gap}/${n}\nof them a returns-only check (io-assert/io-trace) CANNOT even pass the honest impl (it returns undefined, not the\nsink) — so the surface is structurally invisible to the returns-only scorer family. io-effect fills that gap.`
      : `\nreading: UNEXPECTED — td=${td}/${n} brittle=${br}/${n} gap=${gap}/${n}. Investigate before claiming item 3.`,
  )
} else {
  console.log(ok ? `io-effect ledger OK: td=${td}/${n} brittle=${br}/${n} returns-gap=${gap}/${n}` : `io-effect ledger FAIL: td=${td}/${n} brittle=${br}/${n} gap=${gap}/${n}`)
}

const reports = join(HERE, 'reports')
if (!existsSync(reports)) mkdirSync(reports, { recursive: true })
writeFileSync(join(reports, 'forge-effect-ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
process.exit(ok ? 0 : 1)
