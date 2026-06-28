import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPlanAllowlist, PLAN_DATA_ONLY, PLAN_SHELL_SCORERS } from '../src/plan-allowlist.mjs'

const SCORERS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scorers')

test('loadPlanAllowlist: every DATA-only scorer is admitted with an absolute scorers/ path', () => {
  const m = loadPlanAllowlist()
  for (const id of ['contains', 'io-assert', 'io-trace', 'io-invariant', 'io-effect']) {
    assert.ok(m.has(id), `expected data-only scorer ${id} in the allowlist`)
    assert.match(m.get(id), /scorers\/.+\.mjs$/)
  }
})

test('loadPlanAllowlist: every shell-executing scorer is HARD-subtracted (the #1 risk)', () => {
  const m = loadPlanAllowlist()
  // composite (shell:true manifest lines), floor (--cmd), test-pass-rate (model-authorable --cmd), llm-judge (API+rubric)
  for (const id of ['composite', 'floor', 'test-pass-rate', 'llm-judge']) {
    assert.equal(m.has(id), false, `${id} shells out — must NOT be model-selectable`)
  }
})

test('loadPlanAllowlist: scope-cli SUBGATE_UNSAFE={composite,floor} would have ADMITTED these (DO-NOT-RETRY guard)', () => {
  // Track A is the Forge case (model authors args), so the scope-cli denylist is too small here
  const m = loadPlanAllowlist()
  assert.equal(m.has('test-pass-rate'), false)
  assert.equal(m.has('llm-judge'), false)
})

test('loadPlanAllowlist: an operator --scorer-allow shipped SHELL scorer (by path) is HARD-subtracted', () => {
  const m = loadPlanAllowlist([join(SCORERS_DIR, 'test-pass-rate.mjs')])
  assert.equal(m.has('test-pass-rate'), false)
})

test('loadPlanAllowlist: an operator --scorer-allow RENAMED copy of a shell scorer is still subtracted (stem-robust)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-allow-'))
  writeFileSync(join(dir, 'Composite.v2.mjs'), 'export const x = 1\n') // stem collapses to 'composite'
  const m = loadPlanAllowlist([join(dir, 'Composite.v2.mjs')])
  assert.equal([...m.keys()].some((k) => /composite/i.test(k)), false)
})

test('loadPlanAllowlist: an operator --scorer-allow DATA-only custom scorer IS admitted (operator contract)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-allow-'))
  writeFileSync(join(dir, 'my-io-check.mjs'), 'export const x = 1\n')
  const m = loadPlanAllowlist([join(dir, 'my-io-check.mjs')])
  assert.equal(m.has('my-io-check'), true)
})

test('loadPlanAllowlist: an operator --scorer-allow path colliding with a shipped data-only id CANNOT overwrite it (shipped wins)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-allow-'))
  writeFileSync(join(dir, 'contains.mjs'), 'export const x = 1\n') // a DIFFERENT file with a colliding id
  const m = loadPlanAllowlist([join(dir, 'contains.mjs')])
  assert.equal(m.get('contains'), join(SCORERS_DIR, 'contains.mjs'), 'the security-verified shipped contains must win')
})

test('loadPlanAllowlist: shipped scorers/ partitions cleanly into data-only ∪ shell (fail-closed drift tripwire)', () => {
  // a NEWLY shipped scorer in NEITHER set fails this loudly, forcing a conscious data-only/shell classification
  const shipped = readdirSync(SCORERS_DIR).filter((f) => f.endsWith('.mjs')).map((f) => f.replace(/\.mjs$/, ''))
  const unclassified = shipped.filter((id) => !PLAN_DATA_ONLY.has(id) && !PLAN_SHELL_SCORERS.has(id))
  assert.deepEqual(unclassified, [], `unclassified shipped scorers — classify each in plan-allowlist.mjs: ${unclassified.join(', ')}`)
})

test('loadPlanAllowlist: the data-only and shell sets are disjoint', () => {
  for (const id of PLAN_DATA_ONLY) assert.equal(PLAN_SHELL_SCORERS.has(id), false, `${id} cannot be both data-only and shell`)
})
