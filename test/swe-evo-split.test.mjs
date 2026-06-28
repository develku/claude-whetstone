// test/swe-evo-split.test.mjs
// Pins the V/C/T behaviour-cluster split for the SWE-EVO benchmark adapter (H1).
// codex review (REVISE, thread 019f0bf3…) required: hold out WHOLE behaviour clusters at FILE level
// (so C/T test bodies can be physically removed from the editor's tree — clean source isolation),
// exclude tasks with < 3 FAIL_TO_PASS files, keep V/C/T disjoint, and be deterministic.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planSplit, fileOfNode } from '../bench/swe-evo/split.mjs'

test('fileOfNode: pytest node id -> file path (handles class + param, and "::" inside a param)', () => {
  assert.equal(fileOfNode('tests/test_a.py::test_x'), 'tests/test_a.py')
  assert.equal(fileOfNode('tests/test_a.py::TestC::test_y[p-1]'), 'tests/test_a.py')
  assert.equal(fileOfNode('a/b/test_c.py::test_z[a::b]'), 'a/b/test_c.py') // first segment only
})

test('excludes a task with < 3 FAIL_TO_PASS files (cannot form V/C/T)', () => {
  const r = planSplit({ failToPass: ['t/test_a.py::t1', 't/test_b.py::t2'], passToPass: ['t/test_p.py::p1'] })
  assert.equal(r.excluded, true)
  assert.match(r.reason, /3|cluster|file/i)
  assert.deepEqual(r.passToPass, ['t/test_p.py::p1']) // still passed through
})

test('>=3 files -> V/C/T each non-empty, disjoint, covering every FAIL_TO_PASS', () => {
  const f2p = ['t/test_a.py::t1', 't/test_a.py::t2', 't/test_b.py::t3', 't/test_c.py::t4', 't/test_d.py::t5']
  const r = planSplit({ failToPass: f2p, passToPass: ['t/test_p.py::p1'] })
  assert.equal(r.excluded, false)
  for (const k of ['V', 'C', 'T']) assert.ok(r[k].files.length >= 1, `${k} has >=1 file`)
  const allFiles = [...r.V.files, ...r.C.files, ...r.T.files]
  assert.equal(new Set(allFiles).size, allFiles.length, 'V/C/T files are disjoint')
  assert.deepEqual(new Set(allFiles), new Set(['t/test_a.py', 't/test_b.py', 't/test_c.py', 't/test_d.py']))
  const allNodes = [...r.V.nodes, ...r.C.nodes, ...r.T.nodes]
  assert.deepEqual(new Set(allNodes), new Set(f2p), 'every FAIL_TO_PASS node is assigned exactly once')
  assert.equal(allNodes.length, f2p.length)
  assert.deepEqual(r.passToPass, ['t/test_p.py::p1'])
})

test('a node always lands in the bucket that owns its file (no node split across buckets)', () => {
  const f2p = ['t/test_a.py::t1', 't/test_a.py::t2', 't/test_b.py::t3', 't/test_c.py::t4']
  const r = planSplit({ failToPass: f2p })
  for (const bucket of ['V', 'C', 'T']) {
    for (const n of r[bucket].nodes) assert.ok(r[bucket].files.includes(fileOfNode(n)), `${n} in ${bucket}`)
  }
})

test('exactly 3 files -> one file each', () => {
  const r = planSplit({ failToPass: ['t/a.py::t1', 't/b.py::t2', 't/c.py::t3'] })
  assert.equal(r.V.files.length, 1)
  assert.equal(r.C.files.length, 1)
  assert.equal(r.T.files.length, 1)
})

test('deterministic: same input -> identical split', () => {
  const f2p = ['t/test_e.py::t5', 't/test_a.py::t1', 't/test_d.py::t4', 't/test_b.py::t2', 't/test_c.py::t3']
  assert.deepEqual(planSplit({ failToPass: f2p }), planSplit({ failToPass: f2p }))
})
