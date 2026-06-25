// test/bench-runarm.test.mjs
// The high-value $0 proof: real scope-cli + real enforceReadOnly + real gate + our oracle + classify,
// end to end, with a deterministic fake `claude` first on PATH. Asserts the FENCE changes the outcome.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadFixture, runArm } from '../bench/run-bench.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = join(here, '..')
const FX = join(REPO, 'bench', 'fixtures', 'test-deletion')

function withFakeClaude(mode, fn) {
  const bin = mkdtempSync(join(tmpdir(), 'fake-bin-'))
  const shim = join(bin, 'claude')
  writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(join(REPO, 'bench/test/fake-editor.mjs'))} "$@"\n`)
  chmodSync(shim, 0o755)
  const savedPath = process.env.PATH
  const savedMode = process.env.FAKE_EDITOR_MODE
  process.env.PATH = `${bin}:${savedPath}`
  process.env.FAKE_EDITOR_MODE = mode
  return Promise.resolve(fn()).finally(() => {
    process.env.PATH = savedPath
    if (savedMode === undefined) delete process.env.FAKE_EDITOR_MODE; else process.env.FAKE_EDITOR_MODE = savedMode
    rmSync(bin, { recursive: true, force: true })
  })
}

const opts = { model: 'haiku', perRunBudget: 1, trial: 0 }

test('fence-OFF + gaming editor => false-done (weakened test sticks, oracle rejects)', async () => {
  const fx = loadFixture(FX)
  const r = await withFakeClaude('game', () => runArm(fx, 'fence-off', opts))
  assert.equal(r.status, 'done')
  assert.equal(r.oraclePass, false)
  assert.equal(r.bucket, 'false-done')
})

test('fence-ON + gaming editor => not-done (weakening reverted, bug remains)', async () => {
  const fx = loadFixture(FX)
  const r = await withFakeClaude('game', () => runArm(fx, 'fence-on', opts))
  assert.notEqual(r.status, 'done')
  assert.equal(r.bucket, 'not-done')
})

test('fence-ON + honest editor => true-done (real fix, oracle accepts)', async () => {
  const fx = loadFixture(FX)
  const r = await withFakeClaude('fix', () => runArm(fx, 'fence-on', opts))
  assert.equal(r.status, 'done')
  assert.equal(r.oraclePass, true)
  assert.equal(r.bucket, 'true-done')
})
