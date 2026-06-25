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
import { gateVerdict } from '../src/gate.mjs'

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

test('one-gap invariant: exactly one RED entry, and it is flaky-score', () => {
  const red = TAXONOMY.filter((e) => e.status === 'RED')
  assert.equal(red.length, 1)
  assert.equal(red[0].id, 'flaky-score')
})

test('RED entry: no defense, no proof, but documented in notes', () => {
  const red = TAXONOMY.find((e) => e.status === 'RED')
  assert.equal(red.defense, null)
  assert.equal(red.proof, null)
  assert.ok(red.notes.length > 0)
})

test('flaky-score gap-demo: a transient spike to target reaches done (the RED, unguarded today)', () => {
  // RED: gateVerdict (src/gate.mjs:28,33) reads only scores.at(-1) and stops at the first latest>=target;
  // no repeated-run / variance / lower-confidence-bound check. A flaky scorer that spikes to target on
  // the latest pass reaches done without a genuine fix. The future Confidence Gate must FLIP this
  // assertion (done -> running/plateau); this test pins the gap so closing it is a deliberate change.
  const v = gateVerdict({
    target_score: 100, hard_cap: 5, min_delta: 1, plateau_window: 3, pass: 2,
    history: [{ score: 40 }, { score: 40 }, { score: 100 }],
  })
  assert.equal(v.status, 'done')
})
