// The headline proof of TRUE wall-clock concurrency: the editor spawn no longer blocks the event loop, so
// two ACT calls OVERLAP instead of serializing. Uses the REAL makeClaudeAct -> spawnEditorAsync path with a
// fake `claude` binary (a node script that sleeps then prints a result JSON), so it exercises the production
// editor path deterministically, no model. The parallel fan-out's makeScopeAct uses the SAME spawnEditorAsync;
// makeClaudeAct is used here because it needs no git scopeDir, keeping the timing signal clean.
//
// It proves overlap by MEASURING PROCESS LIVENESS, not a wall-clock duration ratio. The earlier version
// asserted `concurrent < serial * 0.7`, a load-SENSITIVE proxy: under CI/coverage load both arms slow down,
// but the concurrent arm suffers more from CPU contention, so the ratio drifts up and the tight bound flaked.
// A duration ratio is the wrong instrument. The RIGHT one is causal: capture each child's [spawn, exit]
// interval via the onSpawn/onExit hooks and check whether the two intervals overlap in time. Genuine async
// spawn keeps both children alive at once -> intervals overlap; a blocking spawnSync would launch the second
// child only after the first exited -> no overlap. This is load-INDEPENDENT: the machine can be arbitrarily
// slow and both intervals still overlap, because overlap is about ordering ("was the sibling still alive when
// the second spawned?"), not about how fast either ran.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeClaudeAct } from '../src/act-claude.mjs'

// Records each editor child's live interval, keyed by pid. `overlapped()` is true iff exactly two children
// ran and their [spawn, exit] intervals intersect (each started before the other finished). Uses the
// MONOTONIC clock (performance.now) — the correct instrument for measuring elapsed intervals: it can't jump
// backwards on an NTP step (unlike Date.now) and its sub-ms resolution avoids equal-timestamp ties.
function makeIntervalRecorder() {
  const spawnedAt = new Map()
  const exitedAt = new Map()
  return {
    onSpawn: (pid) => { if (pid != null) spawnedAt.set(pid, performance.now()) },
    onExit: (pid) => { if (pid != null) exitedAt.set(pid, performance.now()) },
    overlapped() {
      const pids = [...spawnedAt.keys()]
      if (pids.length !== 2) return false
      const [a, b] = pids
      const sa = spawnedAt.get(a), ea = exitedAt.get(a)
      const sb = spawnedAt.get(b), eb = exitedAt.get(b)
      if ([sa, ea, sb, eb].some((t) => t == null)) return false
      return sa < eb && sb < ea // two intervals overlap iff each begins before the other ends
    },
  }
}

test('two ACT editors overlap in wall clock when concurrent, and do NOT when serial', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whet-overlap-'))
  const SLEEP = 250
  const fakeBin = join(dir, 'fake-claude.mjs')
  // Ignores its claude args, sleeps SLEEP ms, then emits a valid result JSON and exits 0. The sleep keeps each
  // child alive long enough that two same-tick spawns are comfortably inside each other's lifetime.
  writeFileSync(fakeBin, `#!/usr/bin/env node\nsetTimeout(() => { process.stdout.write(JSON.stringify({ type: 'result', total_cost_usd: 0, usage: {} })) }, ${SLEEP})\n`)
  chmodSync(fakeBin, 0o755)
  const art = join(dir, 'artifact.txt')
  writeFileSync(art, 'x')

  const state = { goal: 'g', last_critique: 'improve', history: [] }

  // CONCURRENT: fire both editors in the same tick. spawnEditorAsync yields the event loop while `claude -p`
  // runs, so BOTH child processes are alive simultaneously -> their [spawn, exit] intervals overlap. A blocking
  // spawnSync editor would make this assertion fail (the second child could not spawn until the first exited).
  const conc = makeIntervalRecorder()
  const concAct = makeClaudeAct({ artifactPath: art, claudeBin: fakeBin, onSpawn: conc.onSpawn, onExit: conc.onExit })
  const results = await Promise.all([concAct(state), concAct(state)])
  assert.equal(typeof results[0].changed, 'boolean') // the ACT contract still holds via the async spawn
  assert.ok(conc.overlapped(), 'concurrent editors did not overlap — the async spawn is serializing on the event loop')

  // SERIAL (negative control): await one editor before starting the next, so the second child cannot spawn
  // until the first has exited. Its intervals must NOT overlap. This proves the overlap check has teeth — a
  // serializing implementation looks like THIS, so a passing concurrent assertion above is real concurrency,
  // not a recorder that always reports overlap. Load-independent, exactly like the positive case.
  const ser = makeIntervalRecorder()
  const serAct = makeClaudeAct({ artifactPath: art, claudeBin: fakeBin, onSpawn: ser.onSpawn, onExit: ser.onExit })
  await serAct(state)
  await serAct(state)
  assert.ok(!ser.overlapped(), 'serial editors overlapped — the interval recorder is not measuring liveness correctly')
})
