import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeClaudeAct } from '../src/act-claude.mjs'

// The ONLY genuinely-mocked boundary in the suite is the editor spawn: every other act test injects a
// file-writing stub INSTEAD of makeClaudeAct, so the real spawn -> JSON-parse -> exit-disposition ->
// file-hash path never runs (operator lesson: "a gate that mocks the boundary doesn't test the boundary
// wiring"). These tests drive makeClaudeAct against a REAL child process — a fake `claude` executable — so
// that whole path executes at $0 (no network, no auth). A regression in the spawn/parse/timeout/hash wiring
// (which unit-level extractCost/editorExitDisposition tests can't catch) fails here.
const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs')
chmodSync(FAKE, 0o755) // ensure executable regardless of the checkout's file mode

const state = { goal: 'g', last_critique: 'improve the thing', history: [] }

async function withArtifact(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'whet-actspawn-'))
  const artifact = join(dir, 'artifact.txt')
  writeFileSync(artifact, 'initial content\n')
  try { return await fn({ dir, artifact }) } finally { rmSync(dir, { recursive: true, force: true }) }
}

// The fake CLI reads WHET_FAKE_* from the inherited env (spawn-editor passes no explicit env). Tests in a
// file run sequentially, so set/restore around each spawn is race-free.
async function actWithEnv(act, env) {
  const saved = {}
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k] }
  try { return await act(state) } finally {
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  }
}

test('makeClaudeAct real spawn: an edit is detected and cost+tokens are parsed from the real child JSON stream', async () => {
  await withArtifact(async ({ artifact }) => {
    const act = makeClaudeAct({ artifactPath: artifact, claudeBin: FAKE, timeoutMs: 10_000 })
    const r = await actWithEnv(act, { WHET_FAKE_MODE: 'success', WHET_FAKE_EDIT: artifact, WHET_FAKE_COST: '0.02' })
    assert.equal(r.changed, true)     // file hash changed across the real spawn
    assert.equal(r.costUsd, 0.02)     // extractCost parsed total_cost_usd from the [init, result] stream
    assert.equal(r.tokens, 165)       // extractTokens summed 100+50+10+5
  })
})

test('makeClaudeAct real spawn: a no-op editor (no file write) yields changed:false', async () => {
  await withArtifact(async ({ artifact }) => {
    const act = makeClaudeAct({ artifactPath: artifact, claudeBin: FAKE, timeoutMs: 10_000 })
    const r = await actWithEnv(act, { WHET_FAKE_MODE: 'success' }) // no WHET_FAKE_EDIT
    assert.equal(r.changed, false)
    assert.equal(r.costUsd, 0.01)     // default cost
  })
})

test('makeClaudeAct real spawn: error_max_turns exits non-zero but is NOT fatal (bounded progress, no throw)', async () => {
  await withArtifact(async ({ artifact }) => {
    const act = makeClaudeAct({ artifactPath: artifact, claudeBin: FAKE, timeoutMs: 10_000 })
    const r = await actWithEnv(act, { WHET_FAKE_MODE: 'max_turns', WHET_FAKE_EDIT: artifact })
    assert.equal(r.changed, true)     // the incremental edit counts; editorExitDisposition read it as non-fatal
  })
})

test('makeClaudeAct real spawn: a fatal non-zero exit THROWS with the surfaced editor reason', async () => {
  await withArtifact(async ({ artifact }) => {
    const act = makeClaudeAct({ artifactPath: artifact, claudeBin: FAKE, timeoutMs: 10_000 })
    await assert.rejects(
      actWithEnv(act, { WHET_FAKE_MODE: 'fatal' }),
      (e) => /exited 1/.test(e.message) && /(api_error_status|Overloaded|error_during_execution)/.test(e.message),
    )
  })
})

test('makeClaudeAct real spawn: a hung editor is killed at timeoutMs and surfaces the failure', async () => {
  await withArtifact(async ({ artifact }) => {
    const act = makeClaudeAct({ artifactPath: artifact, claudeBin: FAKE, timeoutMs: 300 })
    await assert.rejects(actWithEnv(act, { WHET_FAKE_MODE: 'hang' }), /failed \(ETIMEDOUT\)|ETIMEDOUT/)
  })
})
