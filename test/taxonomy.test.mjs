// The Exploit Taxonomy is self-validating: this test binds each catalogued exploit class to the
// defense code and the existing test that proves it, and fails CI if any defense file or its proof
// disappears (the regression lock). It also pins the one known gap (flaky-score) with a live gap-demo
// so closing the gap is a visible, deliberate change. See bench/taxonomy/manifest.mjs + README.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TAXONOMY } from '../bench/taxonomy/manifest.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const abs = (p) => join(REPO, p)

test('manifest shape: 8 entries, n is exactly 1..8, ids unique, required fields present', () => {
  assert.equal(TAXONOMY.length, 8)
  assert.deepEqual(TAXONOMY.map((e) => e.n).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(new Set(TAXONOMY.map((e) => e.id)).size, 8)
  for (const e of TAXONOMY) {
    assert.ok(typeof e.id === 'string' && e.id.length, `entry ${e.n}: id`)
    assert.ok(typeof e.title === 'string' && e.title.length, `${e.id}: title`)
    assert.ok(typeof e.description === 'string' && e.description.length, `${e.id}: description`)
    assert.ok(e.status === 'GREEN' || e.status === 'RED', `${e.id}: status`)
    assert.ok(typeof e.notes === 'string' && e.notes.length, `${e.id}: notes`)
  }
})

test('GREEN integrity: each defense file + proof test exists and the proof still contains its needle', () => {
  for (const e of TAXONOMY.filter((x) => x.status === 'GREEN')) {
    assert.ok(e.defense && e.defense.file, `${e.id}: GREEN needs a defense`)
    assert.ok(existsSync(abs(e.defense.file)), `${e.id}: defense file missing: ${e.defense.file}`)
    assert.ok(e.proof && e.proof.file, `${e.id}: GREEN needs a proof`)
    assert.ok(existsSync(abs(e.proof.file)), `${e.id}: proof file missing: ${e.proof.file}`)
    const src = readFileSync(abs(e.proof.file), 'utf8')
    assert.ok(src.includes(e.proof.contains), `${e.id}: proof ${e.proof.file} no longer contains "${e.proof.contains}"`)
  }
})

test('RED entries (if any) are documented gaps: no defense, no proof, non-empty notes', () => {
  // After the Confidence Gate closed flaky-score there are ZERO RED entries; this stays correct
  // (vacuously) and still constrains any future re-opened gap. The v1 "exactly one RED" scaffold and the
  // gateVerdict([40,40,100]) gap-demo were removed when the gap closed — gateVerdict is unchanged; the
  // defense now lives in the loop (stabilityCheck), proven by test/loop.test.mjs.
  for (const red of TAXONOMY.filter((e) => e.status === 'RED')) {
    assert.equal(red.defense, null, `${red.id}: a RED gap must have no defense`)
    assert.equal(red.proof, null, `${red.id}: a RED gap must have no proof`)
    assert.ok(red.notes.length > 0, `${red.id}: a RED gap must be documented in notes`)
  }
})
