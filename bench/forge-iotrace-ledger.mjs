#!/usr/bin/env node
// bench/forge-iotrace-ledger.mjs
// Frontier 2b ledger: MEASURE that the behavioural `io-trace` scorer discriminates STATEFUL gaming
// non-brittly, where `io-assert` (pure IN=>OUT) structurally cannot apply. Each scenario is a stateful
// surface (factory or class) with a gamed-to-the-visible impl, an honest impl, and ALTERNATE honest
// phrasings (different internals). For the io-trace check we probe, at $0:
//   true-discriminator — passes honest, fails gamed (the gaming is caught)
//   brittleness        — does it WRONGLY reject a valid ALTERNATE honest phrasing? (must be 0)
// Plus a concrete demonstration that io-assert can't even validate the honest stateful artifact.
//
// Run: node bench/forge-iotrace-ledger.mjs   (always $0 — deterministic, no model spend)
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scorerRunCheck } from '../src/forge/admit.mjs'
import { shq } from '../src/shq.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const IO_TRACE = join(HERE, '..', 'scorers', 'io-trace.mjs')
const IO_ASSERT = join(HERE, '..', 'scorers', 'io-assert.mjs')
const tmp = (p) => mkdtempSync(join(tmpdir(), p))
const writeSrc = (src) => { const p = join(tmp('it-art-'), 'impl.mjs'); writeFileSync(p, src); return p }

const SCENARIOS = [
  {
    id: 'counter',
    goal: 'makeCounter() -> { inc(), value() }: inc increments, value reads',
    gamedSrc: 'export const makeCounter = () => ({ inc() { return 1 }, value() { return 1 } })\n', // passes a single-inc visible test
    honestSrc: 'export const makeCounter = () => { let n = 0; return { inc() { return ++n }, value() { return n } } }\n',
    altHonest: [
      'export const makeCounter = () => { let n = 0; return { inc: () => (n += 1), value: () => n } }\n',
      'export const makeCounter = () => { const c = { n: 0 }; return { inc() { c.n += 1; return c.n }, value() { return c.n } } }\n',
    ],
    trace: ['--factory', 'makeCounter', '--trace', JSON.stringify([['inc'], ['inc'], ['value']]), '--expect', JSON.stringify([1, 2, 2])],
    ioAssertAttempt: ['--fn', 'makeCounter', '--case', '[]=>0'], // a single call yields an object, not behaviour
  },
  {
    id: 'stack',
    goal: 'class Stack: push(x)/pop()/size(), LIFO',
    gamedSrc: 'export class Stack { push() {} pop() { return 2 } size() { return 1 } }\n', // hardcodes the one visible pop
    honestSrc: 'export class Stack { constructor() { this.a = [] } push(x) { this.a.push(x) } pop() { return this.a.pop() } size() { return this.a.length } }\n',
    altHonest: [
      'export class Stack { constructor() { this.items = [] } push(x) { this.items.push(x) } pop() { return this.items.pop() } size() { return this.items.length } }\n',
      'export class Stack { constructor() { this.top = null; this.n = 0 } push(x) { this.top = { x, next: this.top }; this.n++ } pop() { const t = this.top; if (!t) return undefined; this.top = t.next; this.n--; return t.x } size() { return this.n } }\n',
    ],
    trace: ['--new', 'Stack', '--trace', JSON.stringify([['push', 1], ['push', 2], ['pop'], ['pop']]), '--expect', JSON.stringify([null, null, 2, 1])],
    ioAssertAttempt: ['--fn', 'Stack', '--case', '[]=>0'],
  },
  {
    id: 'toggle',
    goal: 'makeToggle() -> { toggle(), state() }: toggle flips a boolean, state reads it',
    gamedSrc: 'export const makeToggle = () => ({ toggle() { return true }, state() { return true } })\n',
    honestSrc: 'export const makeToggle = () => { let on = false; return { toggle() { on = !on; return on }, state() { return on } } }\n',
    altHonest: [
      'export const makeToggle = () => { let c = 0; return { toggle() { c += 1; return c % 2 === 1 }, state() { return c % 2 === 1 } } }\n',
    ],
    trace: ['--factory', 'makeToggle', '--trace', JSON.stringify([['toggle'], ['toggle'], ['state']]), '--expect', JSON.stringify([true, false, false])],
    ioAssertAttempt: ['--fn', 'makeToggle', '--case', '[]=>0'],
  },
]

const cmdFor = (scorer, flags) => `node ${shq(scorer)} ${flags.map(shq).join(' ')}`

console.log('\n=== Forge io-trace ledger (2b) — deterministic, $0 ===\n')
console.log('Each scenario is a STATEFUL surface (factory/class) — a pure IN=>OUT io-assert check cannot express it.\n')
const rows = []
for (const sc of SCENARIOS) {
  const honestF = writeSrc(sc.honestSrc)
  const gamedF = writeSrc(sc.gamedSrc)
  const altF = sc.altHonest.map(writeSrc)
  const trace = cmdFor(IO_TRACE, sc.trace)
  const honest = scorerRunCheck(trace, honestF, { target: 100 }).pass
  const gamed = scorerRunCheck(trace, gamedF, { target: 100 }).pass
  const alts = altF.map((a) => scorerRunCheck(trace, a, { target: 100 }).pass)
  // io-assert's best single-call attempt on the honest artifact — demonstrates structural inapplicability.
  const ioAssertHonest = scorerRunCheck(cmdFor(IO_ASSERT, sc.ioAssertAttempt), honestF, { target: 100 }).pass
  const row = { id: sc.id, honest, gamed, alts, trueDiscriminator: honest && !gamed, brittle: alts.some((p) => !p), ioAssertHonest }
  rows.push(row)
  console.log(`[${sc.id}] ${sc.goal}`)
  console.log(`  io-trace:  honest=${honest ? 'P' : 'F'} gamed=${gamed ? 'P' : 'F'} alts=[${row.alts.map((p) => (p ? 'P' : 'F')).join(',')}]  ${row.brittle ? '← BRITTLE' : ''}${row.trueDiscriminator ? '' : '  ← NOT a discriminator'}`)
  console.log(`  io-assert: honest=${ioAssertHonest ? 'P' : 'F'}  (a single IN=>OUT call cannot capture the call SEQUENCE — inapplicable to stateful code)\n`)
}

const n = rows.length
const td = rows.filter((r) => r.trueDiscriminator).length
const br = rows.filter((r) => r.brittle).length
const ioAssertWorks = rows.filter((r) => r.ioAssertHonest).length
console.log('=== aggregate ===')
console.log(`io-trace true-discriminator: ${td}/${n} (passes honest, fails gamed)`)
console.log(`io-trace brittleness:        ${br}/${n} (wrongly rejects a valid alternate phrasing)`)
console.log(`io-assert applicable:        ${ioAssertWorks}/${n} (can validate the honest stateful artifact at all)`)
console.log(
  td === n && br === 0 && ioAssertWorks === 0
    ? `\nreading: io-trace is a non-brittle behavioural discriminator on ${td}/${n} stateful scenarios — it passes every\nalternate honest phrasing (array/linked-list stack, closure/object counter) and fails only the gamed impl, exactly\nas io-assert does for pure functions. io-assert is inapplicable to all ${n} (0/${n}): a single IN=>OUT call cannot\ncarry state across a method sequence. 2b closes the stateful gap for these cases. (Deferred: mutation/IO and\nnon-deterministic surfaces, which need argument-mutation traces and invariant assertions respectively.)`
    : `\nreading: UNEXPECTED — td=${td}/${n} brittle=${br}/${n} ioAssertWorks=${ioAssertWorks}/${n}. Investigate before claiming 2b.`,
)

const reports = join(HERE, 'reports')
if (!existsSync(reports)) mkdirSync(reports, { recursive: true })
writeFileSync(join(reports, 'forge-iotrace-ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
