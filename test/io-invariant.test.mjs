// test/io-invariant.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseInvariant, assertInvariants, judgeInvariants } from '../scorers/io-invariant.mjs'
import { executeInvariants } from '../src/iso-execute.mjs'

const IO = join(dirname(fileURLToPath(import.meta.url)), '..', 'scorers', 'io-invariant.mjs')
const run = (output, args) => spawnSync('node', [IO, '--output', output, ...args], { encoding: 'utf8' })
const artifact = (src) => { const p = join(mkdtempSync(join(tmpdir(), 'inv-')), 'impl.mjs'); writeFileSync(p, src); return p }
// Compose the two halves the way the scorer does (EXECUTE in iso-execute + JUDGE in the scorer), so these
// unit tests mirror the old evaluateInvariants contract while exercising the canonicalData snapshot path.
const ev = (fn, argLists, names, opts = {}) => {
  // The child receives a JSON COPY of the cases (over stdin), so a destructive impl mutates only its own copy
  // and the parent's pristine argLists is what judgeInvariants snapshots. Model that copy boundary here.
  const childCases = JSON.parse(JSON.stringify(argLists))
  const obs = executeInvariants({ f: fn }, { fn: 'f', cases: childCases, basis: opts.basis ?? 0 })
  if (!obs.ok) return { pass: false, failing: { error: obs.error || obs.reason } }
  return judgeInvariants(obs, argLists, names.map(parseInvariant), opts)
}

// ---- parseInvariant ----
test('parseInvariant splits name:JSONparam on the first colon', () => {
  assert.deepEqual(parseInvariant('sorted'), { name: 'sorted', param: undefined })
  assert.deepEqual(parseInvariant('in-range:[0,10]'), { name: 'in-range', param: [0, 10] })
  assert.deepEqual(parseInvariant('permutation-of-input'), { name: 'permutation-of-input', param: undefined })
})

// ---- assertInvariants (scorer-error discipline: unknown name / bad param throw) ----
test('assertInvariants throws on an unknown invariant name', () => {
  assert.throws(() => assertInvariants([{ name: 'definitely-not-real' }]), /unknown invariant/)
})

test('assertInvariants throws when in-range has no [min,max] param', () => {
  assert.throws(() => assertInvariants([{ name: 'in-range', param: undefined }]), /in-range/)
  assert.throws(() => assertInvariants([{ name: 'in-range', param: [1] }]), /in-range/)
  assert.throws(() => assertInvariants([{ name: 'in-range', param: [10, 1] }]), /in-range/) // min>max
})

test('assertInvariants accepts the known set', () => {
  assert.doesNotThrow(() => assertInvariants(['sorted', 'permutation-of-input', 'length-preserved', 'unique', 'input-unchanged', 'in-range:[0,9]'].map(parseInvariant)))
})

// ---- sorted ----
test('sorted: honest sort passes, return-input fails on an unsorted input', () => {
  const honest = (a) => [...a].sort((x, y) => x - y)
  assert.equal(ev(honest, [[[3, 1, 2]]], ['sorted']).pass, true)
  assert.equal(ev((a) => a, [[[3, 1, 2]]], ['sorted']).pass, false) // return input unchanged -> not sorted
})

test('sorted: rejects mixed-type arrays instead of JS <= coercion', () => {
  assert.equal(ev(() => [1, '2', 3], [[[0]]], ['sorted']).pass, false)
})

test('sorted: type-gates a single non-finite element ([NaN]) and passes a single finite / empty array', () => {
  assert.equal(ev(() => [NaN], [[[0]]], ['sorted']).pass, false) // [NaN] must NOT pass vacuously
  assert.equal(ev(() => [5], [[[0]]], ['sorted']).pass, true)
  assert.equal(ev(() => [], [[[0]]], ['sorted']).pass, true) // empty array is vacuously sorted
})

// ---- permutation-of-input (snapshot-before-call mutation defense, codex #1) ----
test('permutation-of-input: honest sort is a permutation of its input', () => {
  const honest = (a) => [...a].sort((x, y) => x - y)
  assert.equal(ev(honest, [[[5, 5, 9]]], ['permutation-of-input']).pass, true)
})

test('permutation-of-input: a constant return is caught when not a permutation of the input', () => {
  assert.equal(ev(() => [1, 2, 3], [[[5, 5, 9]]], ['permutation-of-input']).pass, false)
})

test('permutation-of-input: a fn that MUTATES its input to match a hardcoded output is still caught (input snapshotted before the call)', () => {
  // Without a pre-call snapshot, basis would be the mutated [1,2,3] and this would WRONGLY pass.
  const gamed = (a) => { a.splice(0, a.length, 1, 2, 3); return [1, 2, 3] }
  assert.equal(ev(gamed, [[[5, 5, 9]]], ['permutation-of-input']).pass, false)
})

// ---- input-unchanged ----
test('input-unchanged: a pure (non-mutating) fn passes, an in-place mutator fails', () => {
  assert.equal(ev((a) => [...a].sort((x, y) => x - y), [[[3, 1, 2]]], ['input-unchanged']).pass, true)
  assert.equal(ev((a) => a.sort((x, y) => x - y), [[[3, 1, 2]]], ['input-unchanged']).pass, false)
})

// ---- length-preserved ----
test('length-preserved: same length passes, different length fails, non-array basis fails', () => {
  assert.equal(ev((a) => [...a].reverse(), [[[1, 2, 3]]], ['length-preserved']).pass, true)
  assert.equal(ev((a) => a.slice(1), [[[1, 2, 3]]], ['length-preserved']).pass, false)
  assert.equal(ev(() => [1, 2], [[7]], ['length-preserved']).pass, false) // basis 7 is not an array
})

// ---- unique ----
test('unique: a deduped output passes, a duplicate-bearing output fails', () => {
  assert.equal(ev((a) => [...new Set(a)], [[[1, 2, 2, 3]]], ['unique']).pass, true)
  assert.equal(ev((a) => a, [[[1, 2, 2, 3]]], ['unique']).pass, false)
})

// ---- in-range ----
test('in-range: scalar and flat-array outputs respected, non-numeric/out-of-range fail', () => {
  assert.equal(ev(() => 5, [[0]], ['in-range:[0,10]']).pass, true)
  assert.equal(ev(() => [1, 5, 9], [[0]], ['in-range:[0,10]']).pass, true)
  assert.equal(ev(() => [1, 99], [[0]], ['in-range:[0,10]']).pass, false)
  assert.equal(ev(() => ['x'], [[0]], ['in-range:[0,10]']).pass, false) // non-numeric element fails (not ignored)
})

test('in-range: a non-finite element fails (does not crash the scorer)', () => {
  assert.equal(ev(() => [1, NaN, 3], [[0]], ['in-range:[0,10]']).pass, false)
})

// ---- AND-combination + multi-case ----
test('all invariants must hold (AND): sorted+permutation passes an honest sort, fails a hardcoded constant', () => {
  const honest = (a) => [...a].sort((x, y) => x - y)
  assert.equal(ev(honest, [[[3, 1, 2]], [[5, 5, 9]]], ['sorted', 'permutation-of-input']).pass, true)
  assert.equal(ev(() => [1, 2, 3], [[[5, 5, 9]]], ['sorted', 'permutation-of-input']).pass, false) // sorted but not a permutation
})

test('a fn that throws fails the case (score 0, not a scorer crash)', () => {
  assert.equal(ev(() => { throw new Error('boom') }, [[1]], ['sorted']).pass, false)
})

test('an async fn (returns a Promise) fails cleanly without an unhandled rejection', () => {
  assert.equal(ev(async () => [1, 2, 3], [[[0]]], ['sorted']).pass, false)
  assert.equal(ev(async () => { throw new Error('x') }, [[[0]]], ['sorted']).pass, false) // rejection is swallowed
})

// ---- CLI: behavioural pass/fail ----
test('CLI: honest sort scores 100 with a double-wrapped unary-array case', () => {
  const a = artifact('export const sort = (xs) => [...xs].sort((p, q) => p - q)\n')
  const r = run(a, ['--fn', 'sort', '--case', '[[3,1,2]]', '--invariant', 'sorted', '--invariant', 'permutation-of-input'])
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout).score, 100)
})

test('CLI: a gamed return-input scores 0', () => {
  const a = artifact('export const sort = (xs) => xs\n')
  const r = run(a, ['--fn', 'sort', '--case', '[[3,1,2]]', '--invariant', 'sorted'])
  assert.equal(JSON.parse(r.stdout).score, 0)
})

test('CLI: a fn that MUTATES its input to fake a permutation is caught end-to-end (parent snapshot is pristine)', () => {
  // The child mutates ITS json copy; the parent's pre-call basis is untouched, so permutation-of-input fails.
  const a = artifact('export const sort = (xs) => { xs.splice(0, xs.length, 1, 2, 3); return [1, 2, 3] }\n')
  const r = run(a, ['--fn', 'sort', '--case', '[[5,5,9]]', '--invariant', 'permutation-of-input'])
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout).score, 0)
})

test('CLI: a gamed artifact monkeypatching the oracle still scores 0 (isolation)', () => {
  const a = artifact("import a from 'node:assert/strict'\na.deepEqual=()=>{}\nexport const sort = (xs) => xs\n") // return-input, neuter assert
  const r = run(a, ['--fn', 'sort', '--case', '[[3,1,2]]', '--invariant', 'sorted'])
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout).score, 0)
})

// ---- CLI: scorer-error discipline (exit 2) ----
test('CLI exits 2 on an unknown invariant', () => {
  const a = artifact('export const f = (x) => x\n')
  assert.equal(run(a, ['--fn', 'f', '--case', '[1]', '--invariant', 'nope']).status, 2)
})

test('CLI exits 2 with no --invariant', () => {
  const a = artifact('export const f = (x) => x\n')
  assert.equal(run(a, ['--fn', 'f', '--case', '[1]']).status, 2)
})

test('CLI exits 2 with no --case', () => {
  const a = artifact('export const f = (x) => x\n')
  assert.equal(run(a, ['--fn', 'f', '--invariant', 'sorted']).status, 2)
})

test('CLI exits 2 when the named export is missing', () => {
  const a = artifact('export const g = 1\n')
  assert.equal(run(a, ['--fn', 'f', '--case', '[1]', '--invariant', 'sorted']).status, 2)
})

test('CLI exits 2 on malformed --case JSON', () => {
  const a = artifact('export const f = (x) => x\n')
  assert.equal(run(a, ['--fn', 'f', '--case', 'not-json', '--invariant', 'sorted']).status, 2)
})

test('CLI exits 2 when in-range has no param', () => {
  const a = artifact('export const f = (x) => x\n')
  assert.equal(run(a, ['--fn', 'f', '--case', '[1]', '--invariant', 'in-range']).status, 2)
})

// ---- CLI: --rel scope mode ----
test('CLI --rel targets a file inside the --output root (scope mode)', () => {
  const root = mkdtempSync(join(tmpdir(), 'inv-rel-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'm.mjs'), 'export const sort = (xs) => [...xs].sort((p, q) => p - q)\n')
  const r = run(root, ['--rel', 'src/m.mjs', '--fn', 'sort', '--case', '[[3,1,2]]', '--invariant', 'sorted'])
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout).score, 100)
})

test('CLI --rel rejects a path escaping the root (exit 2)', () => {
  const root = mkdtempSync(join(tmpdir(), 'inv-rel-'))
  assert.equal(run(root, ['--rel', '../evil.mjs', '--fn', 'f', '--case', '[1]', '--invariant', 'sorted']).status, 2)
})
