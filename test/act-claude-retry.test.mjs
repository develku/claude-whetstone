import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeClaudeAct } from '../src/act-claude.mjs'

// Editor retry-on-transient (the act twin of llm-judge's judgeWithRetry, v1.5.1): a transient
// `claude -p` fatal exit (rate limit, API overload) must not kill an unattended run — the loop treats
// any act throw as terminal status=error. Scope is deliberately narrow: ONLY the fatal-EXIT path is
// retried; the res.error path (ENOENT / ETIMEDOUT / ENOBUFS) is permanent-or-expensive and still throws
// immediately, and error_max_turns stays non-fatal bounded progress. Same real-child-process convention
// as act-claude-spawn.test.mjs (a mocked boundary doesn't test the boundary wiring).
const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs')
chmodSync(FAKE, 0o755)

const state = { goal: 'g', last_critique: 'improve the thing', history: [] }

async function withArtifact(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'whet-actretry-'))
  const artifact = join(dir, 'artifact.txt')
  writeFileSync(artifact, 'initial content\n')
  try { return await fn({ dir, artifact }) } finally { rmSync(dir, { recursive: true, force: true }) }
}

// The fake CLI reads WHET_FAKE_* from the inherited env; tests run sequentially so set/restore is race-free.
async function actWithEnv(act, env) {
  const saved = {}
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k] }
  try { return await act(state) } finally {
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  }
}

// Injectable spies: no real 2s/5s waits in the suite.
const spies = () => {
  const sleeps = []
  const warns = []
  return { sleeps, warns, retry: { sleep: async (ms) => { sleeps.push(ms) }, warn: (m) => warns.push(m) } }
}

test('retries a transient fatal exit and succeeds on the second attempt', async () => {
  await withArtifact(async ({ dir, artifact }) => {
    const counter = join(dir, 'counter')
    const { sleeps, warns, retry } = spies()
    const act = makeClaudeAct({ artifactPath: artifact, claudeBin: FAKE, timeoutMs: 10_000, retry })
    const r = await actWithEnv(act, {
      WHET_FAKE_FAIL_TIMES: '1', WHET_FAKE_COUNTER: counter,
      WHET_FAKE_EDIT: artifact, WHET_FAKE_COST: '0.02',
    })
    assert.equal(r.changed, true) // attempt 1's partial edit alone already flips the before/after hash
    assert.equal(r.costUsd, 0.02) // cost parsed from the SUCCEEDING attempt's stream
    assert.deepEqual(sleeps, [2000]) // one backoff before the retry
    assert.equal(warns.length, 1) // never silent
    assert.match(warns[0], /attempt 1\/3.*retrying in 2s/s)
    assert.match(warns[0], /Overloaded/) // the warn carries the actionable failure reason
  })
})

test('exhausts attempts on a persistent fatal exit and rethrows the last error unchanged', async () => {
  await withArtifact(async ({ dir, artifact }) => {
    const counter = join(dir, 'counter')
    const { sleeps, warns, retry } = spies()
    const act = makeClaudeAct({ artifactPath: artifact, claudeBin: FAKE, timeoutMs: 10_000, retry })
    await assert.rejects(
      () => actWithEnv(act, { WHET_FAKE_FAIL_TIMES: '99', WHET_FAKE_COUNTER: counter }),
      // Same message shape as the pre-retry contract: the loop's error handler sees an identical failure.
      (e) => /exited 1/.test(e.message) && /Overloaded/.test(e.message),
    )
    assert.deepEqual(sleeps, [2000, 5000]) // judgeWithRetry's ladder: backoffMs[min(i, len-1)]
    assert.equal(warns.length, 2) // attempts-1 warns; the final failure throws instead of warning
  })
})

test('does NOT retry the spawn-error path (bad bin -> immediate throw, zero backoff)', async () => {
  await withArtifact(async ({ artifact }) => {
    const { sleeps, warns, retry } = spies()
    const act = makeClaudeAct({ artifactPath: artifact, claudeBin: '/nonexistent/whet-no-such-bin', timeoutMs: 10_000, retry })
    await assert.rejects(() => act(state), /failed \(ENOENT\)/)
    assert.deepEqual(sleeps, []) // ENOENT is permanent — retrying it is pure waste
    assert.equal(warns.length, 0)
  })
})

test('does NOT retry error_max_turns (bounded progress is returned, not retried)', async () => {
  await withArtifact(async ({ artifact }) => {
    const { sleeps, warns, retry } = spies()
    const act = makeClaudeAct({ artifactPath: artifact, claudeBin: FAKE, timeoutMs: 10_000, retry })
    const r = await actWithEnv(act, { WHET_FAKE_MODE: 'max_turns', WHET_FAKE_EDIT: artifact })
    assert.equal(r.changed, true)
    assert.deepEqual(sleeps, [])
    assert.equal(warns.length, 0)
  })
})

test('custom attempts/backoff are honored', async () => {
  await withArtifact(async ({ dir, artifact }) => {
    const counter = join(dir, 'counter')
    const { sleeps, retry } = spies()
    const act = makeClaudeAct({
      artifactPath: artifact, claudeBin: FAKE, timeoutMs: 10_000,
      retry: { ...retry, attempts: 4, backoffMs: [100, 200, 300] },
    })
    await assert.rejects(() => actWithEnv(act, { WHET_FAKE_FAIL_TIMES: '99', WHET_FAKE_COUNTER: counter }))
    assert.deepEqual(sleeps, [100, 200, 300])
  })
})
