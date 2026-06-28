// test/swe-evo-dataset.test.mjs
// The dataset loader's pure core. The network fetch (HF dataset-viewer /rows) is built/cached out of
// band (one-time, against the pinned SHA); these $0 tests pin the row->harness field mapping and the
// truncation guard. Field names mirror the LIVE Fsoft-AIC/SWE-EVO schema (verified 2026-06-28) so a
// silent upstream rename surfaces as a failing test, not a mis-mapped run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRow, assertNoTruncation } from '../bench/swe-evo/dataset.mjs'

// a field-faithful but tiny SWE-EVO row (the real cells are 100s of KB; only names matter here)
const rawRow = () => ({
  repo: 'conan-io/conan',
  instance_id: 'conan-io__conan_2.0.14_2.0.15',
  base_commit: '4614b3abbff15627b3fabdd98bee419721f423ce',
  patch: 'diff --git a/conan/api/model.py b/conan/api/model.py\n+gold',
  test_patch: 'diff --git a/conans/test/x.py b/conans/test/x.py\n+assert',
  problem_statement: 'Feature: New conan lock remove command',
  FAIL_TO_PASS: ['conans/test/x.py::test_a', 'conans/test/y.py::test_b'],
  PASS_TO_PASS: ['conans/test/z.py::test_c'],
  environment_setup_commit: '88f203f7f8619571f9d8649ff5311d950c035690',
  start_version: '2.0.14',
  end_version: '2.0.15',
  end_version_commit: '88f203f7f8619571f9d8649ff5311d950c035690',
  image: 'xingyaoww/sweb.eval.x86_64.conan-io_s_conan-15109',
  instance_id_swe: 'conan-io__conan-15109',
  bench: 'swe_gym',
  version: '2.0',
  test_cmds: 'pytest --continue-on-collection-errors -n0 -rA',
  log_parser: 'parse_log_pytest',
})

test('normalizeRow maps the live SWE-EVO columns to the harness shape', () => {
  const i = normalizeRow(rawRow())
  assert.equal(i.instanceId, 'conan-io__conan_2.0.14_2.0.15')
  assert.equal(i.repo, 'conan-io/conan')
  assert.equal(i.baseCommit, '4614b3abbff15627b3fabdd98bee419721f423ce')
  assert.equal(i.envSetupCommit, '88f203f7f8619571f9d8649ff5311d950c035690')
  assert.equal(i.image, 'xingyaoww/sweb.eval.x86_64.conan-io_s_conan-15109')
  assert.equal(i.testCmds, 'pytest --continue-on-collection-errors -n0 -rA')
  assert.equal(i.logParser, 'parse_log_pytest')
  assert.equal(i.problemStatement, 'Feature: New conan lock remove command')
  assert.deepEqual(i.failToPass, ['conans/test/x.py::test_a', 'conans/test/y.py::test_b'])
  assert.deepEqual(i.passToPass, ['conans/test/z.py::test_c'])
  assert.match(i.testPatch, /^diff --git/)
})

test('normalizeRow keeps the gold patch under a clearly-held-out key (never given to the editor)', () => {
  const i = normalizeRow(rawRow())
  assert.match(i.goldPatch, /\+gold/)
  // the harness goal is the problem statement, NOT the solution — they must be distinct fields
  assert.notEqual(i.goldPatch, i.problemStatement)
})

test('normalizeRow throws when a required field is missing', () => {
  const r = rawRow()
  delete r.base_commit
  assert.throws(() => normalizeRow(r), /base_commit/)
})

test('normalizeRow throws when FAIL_TO_PASS is not a list', () => {
  const r = rawRow()
  r.FAIL_TO_PASS = 'all'
  assert.throws(() => normalizeRow(r), /FAIL_TO_PASS/)
})

test('assertNoTruncation passes when every row reports no truncated cells', () => {
  assert.doesNotThrow(() => assertNoTruncation([{ row_idx: 0, truncated_cells: [] }, { row_idx: 1, truncated_cells: [] }]))
})

test('assertNoTruncation throws and names the rows whose cells were truncated (would lose test_patch)', () => {
  assert.throws(
    () => assertNoTruncation([{ row_idx: 0, truncated_cells: [] }, { row_idx: 3, truncated_cells: ['test_patch'] }]),
    /row.*3/,
  )
})
