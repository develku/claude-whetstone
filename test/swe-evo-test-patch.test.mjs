// test/swe-evo-test-patch.test.mjs
// Pins the test_patch splitter that gives the H1 adapter its SOURCE ISOLATION (codex REVISE):
// the C/T held-out test bodies must be PHYSICALLY ABSENT from the editor's tree, not merely
// read-only. We do this by applying ONLY the V test files' hunks; this module selects them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filesInPatch, selectPatchForFiles } from '../bench/swe-evo/test-patch.mjs'

const PATCH = `diff --git a/tests/test_a.py b/tests/test_a.py
--- a/tests/test_a.py
+++ b/tests/test_a.py
@@ -1,2 +1,4 @@
 import x
+def test_new_a():
+    assert x.f() == 1
diff --git a/tests/test_b.py b/tests/test_b.py
--- a/tests/test_b.py
+++ b/tests/test_b.py
@@ -1,1 +1,3 @@
 import y
+def test_new_b():
+    assert y.g() == 2
diff --git a/tests/sub/test_c.py b/tests/sub/test_c.py
new file mode 100644
--- /dev/null
+++ b/tests/sub/test_c.py
@@ -0,0 +1,2 @@
+def test_new_c():
+    assert True
`

test('filesInPatch lists every destination file (incl. a newly-added file)', () => {
  assert.deepEqual(filesInPatch(PATCH), ['tests/test_a.py', 'tests/test_b.py', 'tests/sub/test_c.py'])
})

test('selectPatchForFiles keeps only the requested files (source isolation)', () => {
  const vOnly = selectPatchForFiles(PATCH, ['tests/test_a.py'])
  assert.match(vOnly, /test_new_a/)
  assert.doesNotMatch(vOnly, /test_new_b/) // B body physically absent
  assert.doesNotMatch(vOnly, /test_new_c/) // C body physically absent
  assert.deepEqual(filesInPatch(vOnly), ['tests/test_a.py'])
})

test('selectPatchForFiles with multiple files keeps exactly those', () => {
  const sub = selectPatchForFiles(PATCH, ['tests/test_a.py', 'tests/sub/test_c.py'])
  assert.deepEqual(filesInPatch(sub), ['tests/test_a.py', 'tests/sub/test_c.py'])
  assert.doesNotMatch(sub, /test_new_b/)
})

test('selecting no files yields an empty patch', () => {
  assert.equal(selectPatchForFiles(PATCH, []).trim(), '')
})

test('selecting all files round-trips the set of files', () => {
  const all = filesInPatch(PATCH)
  assert.deepEqual(filesInPatch(selectPatchForFiles(PATCH, all)), all)
})

test('unknown files are ignored, not errors', () => {
  assert.equal(selectPatchForFiles(PATCH, ['tests/nope.py']).trim(), '')
})
