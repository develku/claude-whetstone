// test/blast-radius.test.mjs
// AUD-06: the single-file loop enforces "edit ONLY <artifact>" in CODE (not just the prompt) — snapshot the
// artifact's sibling files before an edit, revert any the editor also touched. The artifact itself is never
// snapshotted or reverted, so the loop's artifact-hash change-detection is unaffected.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotSiblings, settleSiblings, withBlastRadius } from '../src/blast-radius.mjs'

const scratch = (name) => mkdtempSync(join(tmpdir(), `blast-${name}-`))

test('snapshot+settle reverts a modified sibling, deletes an added file, restores a deleted one', () => {
  const dir = scratch('rt')
  const artifact = join(dir, 'artifact.mjs'); writeFileSync(artifact, 'export const a = 1\n')
  writeFileSync(join(dir, 'sibling.mjs'), 'export const s = 1\n')
  writeFileSync(join(dir, 'gone.mjs'), 'export const g = 1\n')
  const snap = snapshotSiblings(artifact)
  // editor tampers with siblings AND (legitimately) the artifact
  writeFileSync(artifact, 'export const a = 2\n')
  writeFileSync(join(dir, 'sibling.mjs'), 'export const s = 999 // tampered\n')
  writeFileSync(join(dir, 'added.mjs'), 'export const injected = 1\n')
  writeFileSync(join(dir, 'gone.mjs'), '') // will be treated as modified (still present); test true delete below
  const settled = settleSiblings(snap)
  assert.equal(settled.violated, true)
  assert.equal(readFileSync(join(dir, 'sibling.mjs'), 'utf8'), 'export const s = 1\n', 'modified sibling reverted')
  assert.equal(existsSync(join(dir, 'added.mjs')), false, 'added file deleted')
  assert.equal(readFileSync(join(dir, 'gone.mjs'), 'utf8'), 'export const g = 1\n', 'emptied sibling restored')
  assert.equal(readFileSync(artifact, 'utf8'), 'export const a = 2\n', 'the artifact edit is untouched')
  assert.ok(settled.reverted.includes('sibling.mjs') && settled.reverted.includes('added.mjs'))
})

test('excludes dot-dirs, node_modules, and symlinks from the walk', () => {
  const dir = scratch('excl')
  const artifact = join(dir, 'a.mjs'); writeFileSync(artifact, 'x')
  mkdirSync(join(dir, '.loop')); writeFileSync(join(dir, '.loop', 'state.json'), '{}')
  mkdirSync(join(dir, 'node_modules')); writeFileSync(join(dir, 'node_modules', 'p.mjs'), 'pkg')
  writeFileSync(join(dir, 'real.mjs'), 'r')
  try { symlinkSync(join(dir, 'real.mjs'), join(dir, 'link.mjs')) } catch { /* symlink may be denied */ }
  const snap = snapshotSiblings(artifact)
  const keys = [...snap.files.keys()]
  assert.deepEqual(keys.filter((k) => k.includes('.loop') || k.includes('node_modules') || k === 'link.mjs'), [])
  assert.ok(keys.includes('real.mjs'))
})

test('over the copy cap, a changed sibling is detected but NOT reverted (bounded, reported loudly)', () => {
  const dir = scratch('cap')
  const artifact = join(dir, 'a.mjs'); writeFileSync(artifact, 'x')
  writeFileSync(join(dir, 's1.mjs'), '1')
  writeFileSync(join(dir, 's2.mjs'), '2')
  const snap = snapshotSiblings(artifact, { copyCap: 0 }) // hash-only: nothing revertable
  writeFileSync(join(dir, 's1.mjs'), 'tampered')
  const settled = settleSiblings(snap)
  assert.deepEqual(settled.reverted, [])
  assert.ok(settled.detectedOnly.includes('s1.mjs'))
  assert.equal(readFileSync(join(dir, 's1.mjs'), 'utf8'), 'tampered', 'over-cap file is left as-is (cannot restore)')
})

test('withBlastRadius reverts a sibling even when act throws (containment on error paths)', async () => {
  const dir = scratch('throw')
  const artifact = join(dir, 'a.mjs'); writeFileSync(artifact, 'x')
  writeFileSync(join(dir, 's.mjs'), 'orig')
  const warnings = []
  const records = []
  const act = withBlastRadius(async () => { writeFileSync(join(dir, 's.mjs'), 'bad'); throw new Error('boom') },
    { artifactPath: artifact, warn: (m) => warnings.push(m), record: (r) => records.push(r) })
  await assert.rejects(() => act({ pass: 1 }), /boom/)
  assert.equal(readFileSync(join(dir, 's.mjs'), 'utf8'), 'orig', 'sibling reverted despite the throw')
  assert.equal(records.length, 1)
  assert.ok(warnings.some((w) => /reverted/.test(w)))
})

test('capped snapshot: deleting a tracked sibling never destroys pre-existing beyond-cap files (detect-only, not reverted)', () => {
  const dir = scratch('capslide')
  const artifact = join(dir, 'artifact.mjs'); writeFileSync(artifact, 'export const a = 1\n')
  const files = []
  for (let i = 0; i < 12; i++) { const f = `s${String(i).padStart(2, '0')}.txt`; writeFileSync(join(dir, f), `orig-${i}\n`); files.push(f) }
  const snap = snapshotSiblings(artifact, { walkCap: 8 })
  assert.equal(snap.capped, true, 'walk caps at 8 of 12 siblings')
  const tracked = [...snap.files.keys()]
  const beyondCap = files.filter((f) => !snap.files.has(f))
  assert.ok(beyondCap.length > 0, 'some siblings are beyond the cap (absent from the snapshot)')
  // editor deletes 4 TRACKED siblings -> the settle walk's window slides down onto the beyond-cap files
  for (const f of tracked.slice(0, 4)) rmSync(join(dir, f))
  const settled = settleSiblings(snap)
  // a containment control must never destroy files it never snapshotted
  for (const f of beyondCap) {
    assert.equal(existsSync(join(dir, f)), true, `pre-existing beyond-cap file ${f} preserved`)
    assert.ok(!settled.reverted.includes(f), `${f} not falsely reported reverted`)
    assert.ok(settled.detectedOnly.includes(f), `${f} surfaced loudly in detectedOnly`)
  }
  assert.equal(settled.violated, true, 'detectedOnly entries still count as a violation')
})

test('withBlastRadius: editor deleting a snapshotted sibling\'s parent dir does not throw; settle completes', async () => {
  const dir = scratch('rmparent')
  const artifact = join(dir, 'a.mjs'); writeFileSync(artifact, 'x')
  mkdirSync(join(dir, 'sub')); writeFileSync(join(dir, 'sub', 'inner.txt'), 'orig\n')
  const warnings = []
  const records = []
  const act = withBlastRadius(async () => { rmSync(join(dir, 'sub'), { recursive: true, force: true }); return { changed: true } },
    { artifactPath: artifact, warn: (m) => warnings.push(m), record: (r) => records.push(r) })
  const out = await act({ pass: 1 }) // must NOT throw out of the finally
  assert.deepEqual(out, { changed: true }, 'act result passes through — settle did not mask it')
  assert.equal(records.length, 1, 'a violation was recorded')
  const rel = join('sub', 'inner.txt')
  const rec = records[0]
  assert.ok(rec.reverted.includes(rel) || rec.detectedOnly.includes(rel), 'sibling surfaced as reverted or detectedOnly — never silently swallowed')
  if (rec.reverted.includes(rel)) assert.equal(readFileSync(join(dir, 'sub', 'inner.txt'), 'utf8'), 'orig\n', 'restored with the parent dir recreated')
})

test('withBlastRadius is a no-op (no record/warn) when the editor stays in bounds', async () => {
  const dir = scratch('clean')
  const artifact = join(dir, 'a.mjs'); writeFileSync(artifact, 'x')
  writeFileSync(join(dir, 's.mjs'), 'orig')
  const records = []
  const act = withBlastRadius(async () => { writeFileSync(artifact, 'edited') /* only the artifact */; return { changed: true } },
    { artifactPath: artifact, record: (r) => records.push(r) })
  const out = await act({ pass: 1 })
  assert.deepEqual(out, { changed: true }, 'the wrapped act result passes through')
  assert.equal(records.length, 0, 'no violation recorded for an in-bounds edit')
  assert.equal(readFileSync(join(dir, 's.mjs'), 'utf8'), 'orig')
})
