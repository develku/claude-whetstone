import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const scorer = join(here, '..', 'scorers', 'test-pass-rate.mjs')

const run = (cmd) =>
  spawnSync('node', [scorer, '--cmd', cmd, '--output', 'x', '--loop-dir', '.', '--pass', '000'], { encoding: 'utf8' })

test('scores 100 when all tests pass', () => {
  const r = run(`node -e "console.log('ℹ pass 4'); console.log('ℹ fail 0')"`)
  assert.equal(r.status, 0)
  const j = JSON.parse(r.stdout)
  assert.equal(j.score, 100)
  assert.match(j.critique, /all 4 tests pass/)
})

test('scores the pass fraction when some tests fail', () => {
  const r = run(`node -e "console.log('ℹ pass 3'); console.log('ℹ fail 1')"`)
  const j = JSON.parse(r.stdout)
  assert.equal(j.score, 75)
  assert.match(j.critique, /1\/4 tests failing/)
})

test('exits 2 (scorer error) when counts cannot be parsed', () => {
  const r = run(`node -e "console.log('no counts here')"`)
  assert.equal(r.status, 2)
})
