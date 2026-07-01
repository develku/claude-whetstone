// The headline proof of TRUE wall-clock concurrency: the editor spawn no longer blocks the event loop, so
// two ACT calls OVERLAP instead of serializing. Uses the REAL makeClaudeAct -> spawnEditorAsync path with a
// fake `claude` binary (a node script that sleeps then prints a result JSON), so it exercises the production
// editor path deterministically, no model. The parallel fan-out's makeScopeAct uses the SAME spawnEditorAsync;
// makeClaudeAct is used here because it needs no git scopeDir, keeping the timing signal clean.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeClaudeAct } from '../src/act-claude.mjs'

test('two ACT editors overlap in wall clock (concurrent << serial)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whet-overlap-'))
  const SLEEP = 250
  const fakeBin = join(dir, 'fake-claude.mjs')
  // Ignores its claude args, sleeps, then emits a valid result JSON and exits 0.
  writeFileSync(fakeBin, `#!/usr/bin/env node\nsetTimeout(() => { process.stdout.write(JSON.stringify({ type: 'result', total_cost_usd: 0, usage: {} })) }, ${SLEEP})\n`)
  chmodSync(fakeBin, 0o755)
  const art = join(dir, 'artifact.txt')
  writeFileSync(art, 'x')

  const act = makeClaudeAct({ artifactPath: art, claudeBin: fakeBin })
  const state = { goal: 'g', last_critique: 'improve', history: [] }

  // Warm the node/OS caches first — the FIRST subprocess spawn pays a large cold-start (~cold ESM compile +
  // binary page-in) that would otherwise swamp the timing. After warm-up the comparison isolates OVERLAP.
  const warm = await act(state)
  assert.equal(typeof warm.changed, 'boolean') // the ACT contract still holds via the async spawn

  // Self-calibrating: run the two editors SERIALLY, then CONCURRENTLY. Both pay identical per-call cost, so
  // only overlap explains a difference. A blocking spawnSync would make concurrent ≈ serial; genuine async
  // overlap makes concurrent ≈ one call, i.e. roughly half of serial.
  let t = Date.now(); await act(state); await act(state); const serial = Date.now() - t
  t = Date.now(); await Promise.all([act(state), act(state)]); const concurrent = Date.now() - t

  assert.ok(concurrent < serial * 0.7, `expected concurrent (${concurrent}ms) to be well under serial (${serial}ms) — editors did not overlap`)
})
