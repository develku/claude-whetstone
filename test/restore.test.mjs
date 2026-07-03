import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runLoop } from '../src/loop.mjs'
import { initState, recordPass } from '../src/state.mjs'

// Wiring restoreTarget into the loop: after a pass REGRESSES (its score is below the
// best so far), runLoop must call the injected restore(snapshotPath) with the best
// pass's snapshot before the next edit — so a bad edit doesn't seed the next Act.
// `restore` is a new optional injected dep; absent/no-regression means it is never called.

const cfg = (over = {}) => initState({ goal: 'g', artifactPath: 'a', scorerCmd: 's', hardCap: 20, ...over })
// persist stores a per-pass snapshot path so restoreTarget can find the best one
const persist = (s, ev) => recordPass(s, { ...ev, snapshot: `iter_${s.history.length}.txt` })

test('restores the best snapshot once, after a regressed pass', async () => {
  const scoreQ = [50, 90, 70, 95] // up to 90 (best @pass1), regress to 70, recover to 95
  const restored = []
  const { verdict } = await runLoop({
    state: cfg({ targetScore: 95 }),
    evaluate: async () => ({ score: scoreQ.shift(), critique: 'c' }),
    act: async () => ({ changed: true }),
    persist,
    restore: (snap) => restored.push(snap),
    log: () => {},
  })
  assert.equal(verdict.status, 'done')
  assert.deepEqual(restored, ['iter_1.txt'])
})

test('never restores when every pass improves', async () => {
  const scoreQ = [50, 70, 95]
  const restored = []
  const { state } = await runLoop({
    state: cfg({ targetScore: 95 }),
    evaluate: async () => ({ score: scoreQ.shift(), critique: 'c' }),
    act: async () => ({ changed: true }),
    persist,
    restore: (snap) => restored.push(snap),
    log: () => {},
  })
  assert.deepEqual(restored, [])
  assert.equal(state.restored_at_pass ?? null, null) // AUD-05: a monotonic run never stamps
})

// AUD-05 — after a keep-best rollback, the LIVE artifact is the best snapshot, but the loop
// used to leave last_critique describing the reverted (dead) pass. The next edit must be
// steered by the BEST pass's critique, and the revert must be stamped (restored_at_pass).

test('after a keep-best rollback the next edit sees the best-pass critique, not the reverted one (AUD-05)', async () => {
  const scoreQ = [50, 90, 70, 95] // pass1=90 best, pass2=70 regress -> restore, pass3=95 done
  const critQ = ['base', 'X', 'Y', 'done']
  const seen = []
  const { state } = await runLoop({
    state: cfg({ targetScore: 95 }),
    evaluate: async () => ({ score: scoreQ.shift(), critique: critQ.shift() }),
    act: async (s) => { seen.push({ crit: s.last_critique, restored: s.restored_at_pass ?? null }); return { changed: true } },
    persist,
    restore: () => {},
    log: () => {},
  })
  const postRestore = seen.find((x) => x.restored === 2)
  assert.ok(postRestore, 'an edit ran after the reverted pass, carrying the restore stamp')
  assert.equal(postRestore.crit, 'X', 'the post-restore edit must see the best-pass critique, not the reverted "Y"')
  assert.equal(state.restored_at_pass, 2)
})

test('the keep-best re-point is persisted via save() so a resume mid-rescue is not misled (AUD-05)', async () => {
  const scoreQ = [50, 90, 70, 95]
  const critQ = ['base', 'X', 'Y', 'done']
  const saved = []
  await runLoop({
    state: cfg({ targetScore: 95 }),
    evaluate: async () => ({ score: scoreQ.shift(), critique: critQ.shift() }),
    act: async () => ({ changed: true }),
    persist,
    restore: () => {},
    save: (s) => saved.push(s),
    log: () => {},
  })
  assert.ok(saved.some((s) => s.restored_at_pass === 2 && s.last_critique === 'X'),
    'save() must persist the restore stamp + re-pointed critique, not only return it')
})

test('a confirm veto after a restore overwrites the restore critique with the fresher veto critique (AUD-05 ordering)', async () => {
  // pass2=92 is a done candidate (>= target 90) that also regressed (< best 98) -> restore fires and
  // stamps best_critique; then verifyDone runs confirm, which re-scores the RESTORED live artifact and
  // legitimately overwrites with its fresher critique. Freshest live-artifact critique wins.
  const scoreQ = [50, 98, 92]
  const critQ = ['base', 'X', 'Y']
  const { state } = await runLoop({
    state: cfg({ targetScore: 90, hardCap: 2 }),
    evaluate: async () => ({ score: scoreQ.shift(), critique: critQ.shift() }),
    act: async () => ({ changed: true }),
    persist,
    restore: () => {},
    confirm: async () => ({ score: 50, critique: 'gap' }),
    log: () => {},
  })
  assert.equal(state.last_critique, 'gap', 'the fresher confirm critique must win over the restore stamp')
  assert.equal(state.restored_at_pass, 2)
  assert.equal(state.confirm_vetoed_at_pass, 2)
})

test('a best pass with no critique re-points to the neutral fallback (null), never a stale critique (AUD-05, Codex guard)', async () => {
  // Codex biggest-risk guard: a new best pass whose critique is null must store best_critique=null
  // (not undefined), so the restore re-points to null -> the prompt falls back to its neutral default,
  // NOT the reverted "Y". Guards against the fix silently degrading to the old bug.
  const scoreQ = [50, 90, 70, 95]
  const critQ = ['base', null, 'Y', 'done'] // pass1 is best but carries no critique text
  const seen = []
  await runLoop({
    state: cfg({ targetScore: 95 }),
    evaluate: async () => ({ score: scoreQ.shift(), critique: critQ.shift() }),
    act: async (s) => { seen.push({ crit: s.last_critique, restored: s.restored_at_pass ?? null }); return { changed: true } },
    persist,
    restore: () => {},
    log: () => {},
  })
  const postRestore = seen.find((x) => x.restored === 2)
  assert.ok(postRestore)
  assert.equal(postRestore.crit, null, 'best_critique=null must re-point to null, never undefined and never the reverted "Y"')
})

test('a legacy resumed state (no best_critique key) keeps the old critique on restore — never leaks undefined (AUD-05)', async () => {
  // A pre-fix state.json lacks best_critique -> undefined. The re-point is guarded with !== undefined,
  // so restore keeps last_critique (the historical behavior: not worse than before the fix).
  const legacy = {
    ...cfg({ targetScore: 95 }),
    history: [{ pass: 0, score: 90, snapshot: 'iter_0.txt', critique_ref: null, ts: 't' }],
    best_score: 90, best_pass: 0, current_score: 90, pass: 0, last_critique: 'old',
  }
  delete legacy.best_critique // simulate a resumed pre-fix state.json
  const scoreQ = [70, 95] // pass1=70 regress from best 90 -> restore; pass2=95 done
  const critQ = ['Y', 'done']
  const { state } = await runLoop({
    state: legacy, skipBaseline: true,
    evaluate: async () => ({ score: scoreQ.shift(), critique: critQ.shift() }),
    act: async () => ({ changed: true }),
    persist,
    restore: () => {},
    log: () => {},
  })
  assert.notEqual(state.last_critique, undefined, 'restore must never leave last_critique undefined')
  assert.equal(typeof state.last_critique, 'string')
  assert.equal(state.restored_at_pass, 1) // the stamp is unconditional even in legacy mode
})
