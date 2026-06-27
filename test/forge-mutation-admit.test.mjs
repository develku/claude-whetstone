// test/forge-mutation-admit.test.mjs
// mutationAdmit: a policy WRAPPER over admitCheck that strengthens admission from "fails the one observed bad"
// to "kills an oracle-confirmed mutant NEIGHBOURHOOD". admit.mjs stays untouched. Codex-folded discipline:
// structured outcomes (classify -> pass|reject|error|flaky); a candidate CRASH is NOT a kill; oracle ERROR on a
// mutant does NOT confirm it; usable oracles pass good reproducibly; FILE-mode only (skip on --rel/--output).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mutationAdmit, classify } from '../src/forge/mutation-admit.mjs'

// queue-stub keyed by `${cmd}|${artifact}`: shift a verdict per read. A 'THROW' sentinel makes runCheck throw
// (an unimportable/non-parsing artifact -> scorer die() -> non-zero exit -> scorerRunCheck throws in production).
const stub = (byKey) => {
  const q = Object.fromEntries(Object.entries(byKey).map(([k, v]) => [k, [...v]]))
  return async (cmd, artifact) => {
    const v = (q[`${cmd}|${artifact}`] ?? []).shift()
    if (v === 'THROW') throw new Error('candidate check exited 2')
    return { pass: v }
  }
}
const admits = async () => ({ admit: true, reason: 'discriminates' })
const rejects = async () => ({ admit: false, reason: 'passes a known-bad artifact' })
// fake materializer: ignores fs, returns the controlled mutant list (artifact id == its label)
const fakeMaterialize = (labels) => () => ({ mutants: labels.map((l) => ({ operator: 'op', artifact: l })), cleanup: () => {} })
const base = { candidateCmd: 'C', goodArtifact: 'good', badArtifact: 'bad', replayRuns: 2 }

// --- classify ---
test('classify: all-pass -> pass; all-fail -> reject; disagree -> flaky; throw -> error', async () => {
  assert.equal((await classify(stub({ 'C|a': [true, true] }), 'C', 'a', 2)).outcome, 'pass')
  assert.equal((await classify(stub({ 'C|a': [false, false] }), 'C', 'a', 2)).outcome, 'reject')
  assert.equal((await classify(stub({ 'C|a': [true, false] }), 'C', 'a', 2)).outcome, 'flaky')
  assert.equal((await classify(stub({ 'C|a': ['THROW'] }), 'C', 'a', 2)).outcome, 'error')
})

// --- gate-floor invariant ---
test('base admitCheck REJECTS -> returns base verbatim, never strengthens (gate never more permissive)', async () => {
  let materialized = false
  const r = await mutationAdmit({ ...base, oracleCmds: ['O'], runCheck: stub({}), baseAdmit: rejects, materializeMutants: () => { materialized = true; return { mutants: [], cleanup: () => {} } } })
  assert.equal(r.admit, false)
  assert.equal(r.reason, 'passes a known-bad artifact')
  assert.equal(materialized, false, 'must not even generate mutants when base rejects')
})

test('no oracle configured -> cannot strengthen, returns base.admit with a skipped annotation', async () => {
  const r = await mutationAdmit({ ...base, oracleCmds: [], runCheck: stub({}), baseAdmit: admits, materializeMutants: fakeMaterialize(['m']) })
  assert.equal(r.admit, true)
  assert.match(r.mutation.skipped, /oracle/i)
})

test('candidate/oracle carrying --rel or --output -> SKIP (FILE-mode only), returns base.admit', async () => {
  const r1 = await mutationAdmit({ ...base, candidateCmd: 'node io.mjs --rel a.mjs', oracleCmds: ['O'], runCheck: stub({}), baseAdmit: admits, materializeMutants: fakeMaterialize(['m']) })
  assert.equal(r1.admit, true)
  assert.match(r1.mutation.skipped, /rel|output|file-mode/i)
  const r2 = await mutationAdmit({ ...base, oracleCmds: ['node io.mjs --output x'], runCheck: stub({}), baseAdmit: admits, materializeMutants: fakeMaterialize(['m']) })
  assert.match(r2.mutation.skipped, /rel|output|file-mode/i)
  // the guard must also catch a flag at the very START of the cmd (no leading space)
  const r3 = await mutationAdmit({ ...base, candidateCmd: '--rel a.mjs node io.mjs', oracleCmds: ['O'], runCheck: stub({}), baseAdmit: admits, materializeMutants: fakeMaterialize(['m']) })
  assert.match(r3.mutation.skipped, /rel|output|file-mode/i)
})

// --- oracle-filter + kill counting ---
test('oracle-filter: equivalent mutant (oracle ACCEPTS) excluded; confirmed bads killed -> ADMIT', async () => {
  const r = await mutationAdmit({
    ...base, oracleCmds: ['O'], minConfirmedMutants: 2,
    materializeMutants: fakeMaterialize(['EQUIV', 'BAD', 'BAD2']),
    runCheck: stub({
      'O|good': [true, true],
      'O|EQUIV': [true, true],          // accepts -> equivalent -> excluded
      'O|BAD': [false, false], 'O|BAD2': [false, false], // reject -> confirmed bad
      'C|BAD': [false, false], 'C|BAD2': [false, false], // candidate kills both
    }),
    baseAdmit: admits,
  })
  assert.equal(r.admit, true)
  assert.equal(r.mutation.confirmedMutants, 2)
  assert.equal(r.mutation.killed, 2)
  assert.equal(r.mutation.excluded, 1)
})

test('pointwise-overfit: candidate PASSES the confirmed bads (kills none) -> REJECT', async () => {
  const r = await mutationAdmit({
    ...base, oracleCmds: ['O'], minConfirmedMutants: 2,
    materializeMutants: fakeMaterialize(['BAD', 'BAD2']),
    runCheck: stub({
      'O|good': [true, true], 'O|BAD': [false, false], 'O|BAD2': [false, false],
      'C|BAD': [true, true], 'C|BAD2': [true, true], // candidate lets both bad mutants through
    }),
    baseAdmit: admits,
  })
  assert.equal(r.admit, false)
  assert.match(r.reason, /overfit|neighbourhood|mutant/i)
  assert.equal(r.mutation.killed, 0)
})

test('candidate CRASH on a mutant is NOT a kill (crash != clean reject) -> REJECT (finding 3)', async () => {
  const r = await mutationAdmit({
    ...base, oracleCmds: ['O'], minConfirmedMutants: 2,
    materializeMutants: fakeMaterialize(['BAD', 'BAD2']),
    runCheck: stub({
      'O|good': [true, true], 'O|BAD': [false, false], 'O|BAD2': [false, false],
      'C|BAD': ['THROW'],          // crash — must NOT count as a kill
      'C|BAD2': [true, true],      // survives
    }),
    baseAdmit: admits,
  })
  assert.equal(r.admit, false)
  assert.equal(r.mutation.killed, 0)
  assert.equal(r.mutation.crashed, 1)
})

test('oracle ERROR on a mutant does NOT confirm it (non-parsing mutant excluded)', async () => {
  const r = await mutationAdmit({
    ...base, oracleCmds: ['O'], minConfirmedMutants: 2,
    materializeMutants: fakeMaterialize(['PARSEFAIL', 'BAD', 'BAD2']),
    runCheck: stub({
      'O|good': [true, true],
      'O|PARSEFAIL': ['THROW'],     // oracle errors -> NOT a confirmation
      'O|BAD': [false, false], 'O|BAD2': [false, false],
      'C|BAD': [false, false], 'C|BAD2': [false, false],
    }),
    baseAdmit: admits,
  })
  assert.equal(r.admit, true)
  assert.equal(r.mutation.confirmedMutants, 2) // PARSEFAIL not counted
})

test('oracle that REJECTS good is unusable; no usable oracle -> cannot strengthen, returns base', async () => {
  const r = await mutationAdmit({
    ...base, oracleCmds: ['O'],
    materializeMutants: fakeMaterialize(['BAD']),
    runCheck: stub({ 'O|good': [false, false] }),
    baseAdmit: admits,
  })
  assert.equal(r.admit, true)
  assert.equal(r.mutation.oraclesUsable, 0)
})

test('minConfirmedMutants floor: too few confirmed bads -> not strengthened (base.admit + note)', async () => {
  const r = await mutationAdmit({
    ...base, oracleCmds: ['O'], minConfirmedMutants: 2,
    materializeMutants: fakeMaterialize(['BAD']),
    runCheck: stub({ 'O|good': [true, true], 'O|BAD': [false, false], 'C|BAD': [false, false] }),
    baseAdmit: admits,
  })
  assert.equal(r.admit, true) // base verdict preserved, not strengthened on a 1-mutant neighbourhood
  assert.equal(r.mutation.confirmedMutants, 1)
  assert.match(r.mutation.note, /floor|few|minConfirmed/i)
})

test('threshold boundary: kill exactly half admits at 0.5, rejects at 0.6', async () => {
  const cfg = (threshold) => ({
    ...base, oracleCmds: ['O'], minConfirmedMutants: 2, mutationKillThreshold: threshold,
    materializeMutants: fakeMaterialize(['BAD', 'BAD2']),
    runCheck: stub({
      'O|good': [true, true], 'O|BAD': [false, false], 'O|BAD2': [false, false],
      'C|BAD': [false, false], 'C|BAD2': [true, true], // kills 1 of 2 = 0.5
    }),
    baseAdmit: admits,
  })
  assert.equal((await mutationAdmit(cfg(0.5))).admit, true)
  assert.equal((await mutationAdmit(cfg(0.6))).admit, false)
})

// --- end-to-end with the REAL scorerRunCheck adapter + REAL mutate + REAL files (counter) ---
import { scorerRunCheck } from '../src/forge/admit.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shq } from '../src/shq.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const IO_TRACE = join(REPO, 'scorers', 'io-trace.mjs')
const HONEST = 'export const makeCounter = () => { let n = 0; return { inc() { return ++n }, value() { return n } } }\n'
const GAMED = 'export const makeCounter = () => ({ inc() {}, value() { return 1 } })\n'
const traceCmd = (trace, expect) => `node ${shq(IO_TRACE)} --factory makeCounter --trace ${shq(trace)} --expect ${shq(expect)}`
const writeArtifact = (src) => { const p = join(mkdtempSync(join(tmpdir(), 'mut-e2e-')), 'impl.mjs'); writeFileSync(p, src); return p }

test('e2e: a WEAK fresh-value check is admitted by admitCheck but REJECTED by mutationAdmit', async () => {
  const good = writeArtifact(HONEST), bad = writeArtifact(GAMED)
  // oracle = a strong held-out behavioural spec (operator-authored, run verbatim)
  const oracle = traceCmd('[["inc"],["value"],["inc"],["value"]]', '[1,1,2,2]')
  // weak candidate: only checks a FRESH value() === 0 — passes good (0), fails the constant-1 bad (1)
  const weak = traceCmd('[["value"]]', '[0]')
  const r = await mutationAdmit({ candidateCmd: weak, goodArtifact: good, badArtifact: bad, replayRuns: 2, runCheck: scorerRunCheck, oracleCmds: [oracle], minConfirmedMutants: 1 })
  assert.equal(r.admit, false, 'weak fresh-value check must be rejected — it misses the increment-no-op neighbourhood')
})

test('e2e: a STRONG sequence check is admitted by mutationAdmit (kills the neighbourhood)', async () => {
  const good = writeArtifact(HONEST), bad = writeArtifact(GAMED)
  const oracle = traceCmd('[["inc"],["value"],["inc"],["value"]]', '[1,1,2,2]')
  const strong = traceCmd('[["inc"],["value"]]', '[1,1]')
  const r = await mutationAdmit({ candidateCmd: strong, goodArtifact: good, badArtifact: bad, replayRuns: 2, runCheck: scorerRunCheck, oracleCmds: [oracle], minConfirmedMutants: 1 })
  assert.equal(r.admit, true, 'strong sequence check generalizes — kills increment-no-op and value-constant mutants')
})
