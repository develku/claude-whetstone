import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// contains.mjs is a shipped, documented reference scorer users copy as a template — pin its
// score 100/0 logic, findings shape, and the required-arg exit-2 paths by example.
const here = dirname(fileURLToPath(import.meta.url))
const scorer = join(here, '..', 'scorers', 'contains.mjs')
const runContains = (file, needle) =>
  spawnSync('node', [scorer, '--needle', needle, '--output', file, '--loop-dir', '.', '--pass', '000'], { encoding: 'utf8' })

test('scores 100 with no findings when the output contains the needle', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'whetstone-contains-')), 'a.txt')
  writeFileSync(f, 'hello DONE world')
  const r = runContains(f, 'DONE')
  assert.equal(r.status, 0)
  const j = JSON.parse(r.stdout)
  assert.equal(j.score, 100)
  assert.deepEqual(j.findings, [])
})

test('scores 0 with one finding when the needle is absent', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'whetstone-contains-')), 'a.txt')
  writeFileSync(f, 'nothing relevant here')
  const j = JSON.parse(runContains(f, 'DONE').stdout)
  assert.equal(j.score, 0)
  assert.equal(j.findings.length, 1)
  assert.equal(j.findings[0].severity, 'high')
})

test('exits 2 (scorer error) when --needle or --output is missing', () => {
  assert.equal(spawnSync('node', [scorer, '--output', 'x'], { encoding: 'utf8' }).status, 2)
  assert.equal(spawnSync('node', [scorer, '--needle', 'x'], { encoding: 'utf8' }).status, 2)
})

test('exits 2 (scorer error) when --output is PRESENT but unreadable (not a silent score 0)', () => {
  // a path typo / unreadable output is a scorer error (the harness gave a bad path), not a masquerading
  // "needle absent" verdict — the same exit-2 discriminator as the missing-arg paths, for the read failure.
  const r = spawnSync('node', [scorer, '--needle', 'DONE', '--output', '/nonexistent/path/xyz.txt', '--loop-dir', '.', '--pass', '000'], { encoding: 'utf8' })
  assert.equal(r.status, 2)
})
