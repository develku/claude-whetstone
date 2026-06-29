import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { globalVerdict, globalHeldOutUnmet } from '../src/converge-gate.mjs'
import { heldOutTruthHash, initConvergeState, ensureConvergeDir, saveConvergeState } from '../src/converge-state.mjs'
import { convergeHeldOutTruthGuards, convergeRefusal } from '../src/converge-cli.mjs'
import { runConverge, prepareGlobalResume } from '../src/converge.mjs'

// --- Inc 3a: the operator-authored, replan-IMMUTABLE GLOBAL held-out truth gate ---
// A top-level acceptance requirement SEPARATE from the per-objective confirms: even if every (mutable) objective
// is met, `done` is withheld unless the operator's immutable global held-out truth also passes. This is the
// semantic backstop against "decomposition capture" (DCA 20260629T141245).

const base = (over = {}) => ({
  objectives: [{ id: 'a', judgeClass: false, primaryScore: 100, confirmScore: null, target: 90 }],
  floor: { cmd: 'true', last_score: 100 },
  global_pass: 1, global_cap: 10, binding_history: [], global_plateau_window: 3, global_min_progress: 1,
  global_held_out: [],
  ...over,
})

test('globalVerdict: no global held-out -> behaves exactly as today (objectives met -> done)', () => {
  assert.equal(globalVerdict(base()).status, 'done')
})

test('globalVerdict: objectives met AND global held-out met -> done', () => {
  const g = base({ global_held_out: [{ id: 'truth', target: 80, score: 95 }] })
  assert.equal(globalVerdict(g).status, 'done')
})

test('globalVerdict: objectives met but a global held-out truth FAILS -> NOT done (capped, decomposition insufficient)', () => {
  const g = base({ global_held_out: [{ id: 'truth', target: 80, score: 40 }] })
  const v = globalVerdict(g)
  assert.notEqual(v.status, 'done')
  assert.equal(v.status, 'capped')
  assert.match(v.reason, /held-out truth/)
  assert.match(v.reason, /insufficient/)
})

test('globalVerdict: an unmeasured (null) global held-out blocks done (cannot certify the truth)', () => {
  const g = base({ global_held_out: [{ id: 'truth', target: 80, score: null }] })
  assert.notEqual(globalVerdict(g).status, 'done')
})

test('globalHeldOutUnmet: lists checks below target or unmeasured', () => {
  const g = { global_held_out: [{ id: 'x', target: 80, score: 95 }, { id: 'y', target: 80, score: 50 }, { id: 'z', target: 80, score: null }] }
  assert.deepEqual(globalHeldOutUnmet(g).map((c) => c.id), ['y', 'z'])
})

test('heldOutTruthHash: stable across key order, changes when content/membership changes', () => {
  const h1 = heldOutTruthHash([{ id: 'a', scorer: 'node s.mjs', target: 80 }])
  const h2 = heldOutTruthHash([{ target: 80, scorer: 'node s.mjs', id: 'a' }]) // reordered keys
  const h3 = heldOutTruthHash([{ id: 'a', scorer: 'node s.mjs', target: 70 }]) // weakened target
  const h4 = heldOutTruthHash([{ id: 'a', scorer: 'node s.mjs', target: 80 }, { id: 'b', scorer: 'node t.mjs', target: 80 }]) // added member
  assert.equal(h1, h2)
  assert.notEqual(h1, h3) // weakening a target changes the hash
  assert.notEqual(h1, h4) // dropping/adding a member changes the hash
  // hash is over the truth-defining triple ONLY — the mutable score/met fields (present on state items, absent on
  // manifest items) must NOT change it, so init and resume compute the SAME hash (M1)
  const hState = heldOutTruthHash([{ id: 'a', scorer: 'node s.mjs', target: 80, score: 95, met: true }])
  assert.equal(hState, h1)
})

test('convergeHeldOutTruthGuards: rejects duplicate held-out ids (applyGlobalHeldOut maps by id)', () => {
  const dup = { scope: '.', manifest: { objectives: [{ id: 'a', editScope: 'a' }], global_held_out: [{ id: 't', scorer: 'node truth/t.mjs', target: 80 }, { id: 't', scorer: 'node truth/u.mjs', target: 80 }] } }
  assert.match(convergeHeldOutTruthGuards(dup), /duplicate global_held_out id/)
})

test('initConvergeState: records global_held_out + held_out_truth_hash from the manifest', () => {
  const manifest = {
    goal: 'g', floor: { cmd: 'true' },
    objectives: [{ id: 'a', goal: 'a', scorer: 'node s.mjs', target: 90, editScope: 'a' }],
    global_held_out: [{ id: 'truth', scorer: 'node truth.mjs', target: 80 }],
  }
  const s = initConvergeState({ scope: '/x' }, manifest)
  assert.equal(s.global_held_out.length, 1)
  assert.equal(s.global_held_out[0].id, 'truth')
  assert.equal(s.global_held_out[0].score, null)
  assert.equal(s.held_out_truth_hash, heldOutTruthHash(manifest.global_held_out))
})

// --- refusal guards ---

test('convergeHeldOutTruthGuards: rejects a held-out scorer inside an editScope, and bad shapes', () => {
  const ok = { scope: '.', manifest: { objectives: [{ id: 'a', editScope: 'a' }], global_held_out: [{ id: 't', scorer: 'node truth/t.mjs', target: 80 }] } }
  assert.equal(convergeHeldOutTruthGuards(ok), null)
  const collide = { scope: '.', manifest: { objectives: [{ id: 'a', editScope: 'a' }], global_held_out: [{ id: 't', scorer: 'node a/t.mjs', target: 80 }] } }
  assert.match(convergeHeldOutTruthGuards(collide), /editScope/)
  const badShape = { scope: '.', manifest: { objectives: [{ id: 'a', editScope: 'a' }], global_held_out: [{ id: 't', target: 80 }] } }
  assert.match(convergeHeldOutTruthGuards(badShape), /scorer/)
})

test('convergeRefusal: --parallel together with a global held-out truth is refused (not yet wired for parallel)', () => {
  const manifest = {
    goal: 'g', floor: { cmd: 'true', readOnly: ['package.json'] }, global_budget_tokens: 1e9, objective_cap: 3,
    objectives: [{ id: 'a', goal: 'a', scorer: 'node s.mjs', target: 90, editScope: 'a' }],
    global_held_out: [{ id: 't', scorer: 'node truth/t.mjs', target: 80 }],
  }
  assert.match(convergeRefusal({ scope: 'repo', objectivesPath: 'm.json', manifest, parallel: true }), /parallel/)
  assert.equal(convergeRefusal({ scope: 'repo', objectivesPath: 'm.json', manifest, parallel: false }), null)
})

test('prepareGlobalResume: a PARALLEL resume of a run carrying a global held-out truth is REFUSED (C1)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whet-htres-'))
  try {
    ensureConvergeDir(dir)
    const manifest = {
      goal: 'g', floor: { cmd: 'true' },
      objectives: [{ id: 'a', goal: 'a', scorer: 'node s.mjs', target: 90, editScope: 'a' }],
      global_held_out: [{ id: 't', scorer: 'node truth/t.mjs', target: 80 }],
    }
    const st = initConvergeState({ scope: '/x' }, manifest)
    st.last_good_sha = '0'.repeat(40) // a valid-looking sha so the guard (which precedes any git op) is reached
    saveConvergeState(dir, st)
    // the parallel backend never measures the truth; resume bypasses convergeRefusal, so the guard must live in
    // the shared resume path — a parallel resume of a global-truth run must throw, not silently run under-gated.
    await assert.rejects(
      prepareGlobalResume({ convergeDir: dir, scope: dir, parallel: true }, { runChild: async () => ({}) }),
      /parallel/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- end-to-end: the gate withholds done when the decomposition is met but the global truth fails ---

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
function writeScorer() {
  const dir = mkdtempSync(join(tmpdir(), 'whet-htsc-'))
  const path = join(dir, 'score.mjs')
  writeFileSync(path, "import { readFileSync } from 'node:fs'\nconst f = process.argv[2]\nlet n = 0\ntry { n = Number(readFileSync(f, 'utf8').trim()) } catch {}\nprocess.stdout.write(JSON.stringify({ score: n, critique: 'raise ' + f }))\n")
  return { dir, path }
}
function tempRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'whet-htrepo-'))
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't')
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'seed')
  return dir
}
const cfg = (scope, sc, o = {}) => ({ scope, objectivesPath: join(sc, 'objectives.json'), convergeDir: mkdtempSync(join(tmpdir(), 'whet-htd-')), globalBudgetTokens: 1e9, globalCap: 4, globalStabilityRuns: 2, globalPlateauWindow: 3, globalMinProgress: 1, minDelta: 1, objectiveRetries: 1, model: 'sonnet', effort: 'medium', noEscalate: true, ...o })
const child = (plan) => async (childCfg) => {
  for (const [rel, val] of Object.entries(plan)) { mkdirSync(join(childCfg.scope, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true }); writeFileSync(join(childCfg.scope, rel), String(val)) }
  git(childCfg.scope, 'add', '-A'); git(childCfg.scope, 'commit', '-q', '--allow-empty', '-m', 'c'); return { state: { spent_usd: 0, spent_tokens: 0 } }
}

test('runConverge: objective met but the GLOBAL held-out truth unmet -> capped (not done); both met -> done', async () => {
  const sc = writeScorer()
  // objective a is scored on a/obj.txt; the global truth is scored on a/truth.txt (held out; editor sees only obj)
  const truthFail = tempRepo({ 'a/obj.txt': '0', 'a/truth.txt': '0' })
  try {
    const manifest = {
      goal: 'g', floor: { cmd: 'true' }, global_budget_tokens: 1e9, objective_cap: 3,
      objectives: [{ id: 'a', goal: 'raise obj', scorer: `node ${sc.path} a/obj.txt`, target: 90, editScope: 'a' }],
      global_held_out: [{ id: 'truth', scorer: `node ${sc.path} a/truth.txt`, target: 90 }],
    }
    // child satisfies the objective (obj.txt=100) but NOT the truth (truth.txt stays 0) -> decomposition insufficient
    const r1 = await runConverge(cfg(truthFail, sc.dir), manifest, { runChild: child({ 'a/obj.txt': 100 }), log: () => {} })
    assert.notEqual(r1.verdict.status, 'done')
    assert.match(r1.verdict.reason, /held-out truth|insufficient/)

    // now a child that satisfies BOTH -> done
    const bothOk = tempRepo({ 'a/obj.txt': '0', 'a/truth.txt': '0' })
    const r2 = await runConverge(cfg(bothOk, sc.dir), manifest, { runChild: child({ 'a/obj.txt': 100, 'a/truth.txt': 100 }), log: () => {} })
    assert.equal(r2.verdict.status, 'done')
    assert.equal(readFileSync(join(bothOk, 'a/truth.txt'), 'utf8'), '100')
    rmSync(bothOk, { recursive: true, force: true })
  } finally {
    rmSync(truthFail, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})
