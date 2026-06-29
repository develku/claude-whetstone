import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pickTournamentWinner, runConverge } from '../src/converge.mjs'
import { convergeCandidatesValid } from '../src/converge-cli.mjs'

// --- Inc 1: tournament selection (the winner's-curse antidote) ---
// The PURE selector is the verifier-depth heart: it must select on the TRUTH signal (held-out for a judge,
// visible for a deterministic), NEVER argmax on the gameable visible. These cases prove that exhaustively at $0.

test('pickTournamentWinner (judge): selects best HELD-OUT, not the visible-max gamer', () => {
  const candidates = [
    { index: 0, eligible: true, visible: 95, heldOut: 40 }, // gamer: looks best, generalizes worst
    { index: 1, eligible: true, visible: 80, heldOut: 85 }, // honest: real quality
  ]
  const r = pickTournamentWinner(candidates, { judgeClass: true, lastGoodTruth: 0, minDelta: 1 })
  assert.equal(r.winnerIndex, 1) // the gamer (visible 95) is NOT selected
  assert.equal(r.rejectAll, false)
})

test('pickTournamentWinner (judge): rejects ALL when the best held-out shows no real progress (gaming)', () => {
  const candidates = [
    { index: 0, eligible: true, visible: 95, heldOut: 50 },
    { index: 1, eligible: true, visible: 90, heldOut: 50 }, // both flat on held-out, high on visible
  ]
  const r = pickTournamentWinner(candidates, { judgeClass: true, lastGoodTruth: 50, minDelta: 1 })
  assert.equal(r.winnerIndex, null)
  assert.equal(r.rejectAll, true)
  assert.equal(r.signal, 'held_out_no_progress')
})

test('pickTournamentWinner (deterministic): selects visible-max and NEVER rejects (no soft gate to overfit)', () => {
  const candidates = [
    { index: 0, eligible: true, visible: 70, heldOut: 70 },
    { index: 1, eligible: true, visible: 55, heldOut: 55 },
  ]
  // even with zero progress over last-good, a deterministic objective just keeps the best (matches runOneObjective)
  const r = pickTournamentWinner(candidates, { judgeClass: false, lastGoodTruth: 70, minDelta: 1 })
  assert.equal(r.winnerIndex, 0)
  assert.equal(r.rejectAll, false)
})

test('pickTournamentWinner: ignores ineligible candidates (floor-blocked / regressing)', () => {
  const candidates = [
    { index: 0, eligible: false, visible: 99, heldOut: 99 }, // highest but ineligible -> must be ignored
    { index: 1, eligible: true, visible: 60, heldOut: 70 },
  ]
  const r = pickTournamentWinner(candidates, { judgeClass: true, lastGoodTruth: 0, minDelta: 1 })
  assert.equal(r.winnerIndex, 1)
})

test('pickTournamentWinner: no eligible candidate -> no winner, no reject-all', () => {
  const candidates = [{ index: 0, eligible: false, visible: 99, heldOut: 99 }]
  const r = pickTournamentWinner(candidates, { judgeClass: true, lastGoodTruth: 0, minDelta: 1 })
  assert.equal(r.winnerIndex, null)
  assert.equal(r.rejectAll, false)
})

test('pickTournamentWinner (judge): tie on held-out keeps the stable first index', () => {
  const candidates = [
    { index: 0, eligible: true, visible: 70, heldOut: 80 },
    { index: 1, eligible: true, visible: 90, heldOut: 80 }, // higher visible, equal held-out
  ]
  const r = pickTournamentWinner(candidates, { judgeClass: true, lastGoodTruth: 0, minDelta: 1 })
  assert.equal(r.winnerIndex, 0) // tie -> first; visible does NOT break a held-out tie
})

test('convergeCandidatesValid: refuses a non-positive / non-integer --candidates, allows >=1 and null', () => {
  assert.equal(convergeCandidatesValid({ candidates: null }), null)
  assert.equal(convergeCandidatesValid({ candidates: 1 }), null)
  assert.equal(convergeCandidatesValid({ candidates: 3 }), null)
  assert.match(convergeCandidatesValid({ candidates: 0 }), /positive integer/)
  assert.match(convergeCandidatesValid({ candidates: -2 }), /positive integer/)
  assert.match(convergeCandidatesValid({ candidates: 2.5 }), /positive integer/)
})

// --- integration: the tournament wired through runConverge (real git + real reMeasureAll) ---

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()

// a scorer that reads a file (its positional arg) from cwd and emits its number as the score
function writeScorer() {
  const dir = mkdtempSync(join(tmpdir(), 'whet-tsc-'))
  const path = join(dir, 'score.mjs')
  writeFileSync(path, "import { readFileSync } from 'node:fs'\nconst f = process.argv[2]\nlet n = 0\ntry { n = Number(readFileSync(f, 'utf8').trim()) } catch {}\nprocess.stdout.write(JSON.stringify({ score: n, critique: 'raise ' + f }))\n")
  return { dir, path }
}

function tempRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'whet-tourney-'))
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't')
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'seed')
  return dir
}

function baseCfg(scope, scorerDir, overrides = {}) {
  return {
    scope,
    objectivesPath: join(scorerDir, 'objectives.json'),
    convergeDir: mkdtempSync(join(tmpdir(), 'whet-tdir-')),
    globalBudgetTokens: 100_000_000,
    globalCap: 12, globalStabilityRuns: 2, globalPlateauWindow: 3, globalMinProgress: 1,
    minDelta: 1, objectiveRetries: 1, model: 'sonnet', effort: 'medium', noEscalate: true,
    ...overrides,
  }
}

// a tournament child whose output VARIES per invocation (independent candidates), so the K candidates diverge
function makeTourneyChild(plans, spend = { spent_usd: 0.01, spent_tokens: 1000 }) {
  let i = 0
  return async (childCfg) => {
    const plan = plans[Math.min(i, plans.length - 1)]; i++
    const wt = childCfg.scope
    for (const [rel, val] of Object.entries(plan)) {
      mkdirSync(join(wt, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true })
      writeFileSync(join(wt, rel), String(val))
    }
    git(wt, 'add', '-A'); git(wt, 'commit', '-q', '--allow-empty', '-m', 'cand')
    return { state: spend }
  }
}

test('runConverge --candidates 2: the gamer (high visible, low held-out) loses to the honest candidate', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/visible.txt': '0', 'a/heldout.txt': '0' })
  try {
    const manifest = {
      goal: 'raise a (judged on a held-out signal)',
      floor: { cmd: 'true' },
      global_budget_tokens: 100_000_000,
      objective_cap: 4,
      objectives: [{
        id: 'a', goal: 'raise a', judgeClass: true,
        scorer: `node ${sc.path} a/visible.txt`, confirmScorer: `node ${sc.path} a/heldout.txt`,
        target: 90, editScope: 'a',
      }],
    }
    // candidate 0 = gamer (visible 95, held-out 40); candidate 1 = honest (visible 80, held-out 95 >= target)
    const child = makeTourneyChild([{ 'a/visible.txt': 95, 'a/heldout.txt': 40 }, { 'a/visible.txt': 80, 'a/heldout.txt': 95 }])
    const { state, verdict } = await runConverge(baseCfg(scope, sc.dir, { candidates: 2 }), manifest, { runChild: child, log: () => {} })
    assert.equal(verdict.status, 'done')
    // the HONEST candidate's tree won — not the gamer's visible=95
    assert.equal(readFileSync(join(scope, 'a/heldout.txt'), 'utf8'), '95')
    assert.equal(readFileSync(join(scope, 'a/visible.txt'), 'utf8'), '80')
    const accepted = state.rounds.find((r) => r.accepted)
    assert.equal(accepted.candidates, 2)
    assert.equal(accepted.winner_index, 1) // index 1 = the honest candidate
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})

test('runConverge --candidates 2: winner-curse guard REJECTS a round where no candidate improves held-out', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/visible.txt': '0', 'a/heldout.txt': '50' })
  try {
    const manifest = {
      goal: 'raise a',
      floor: { cmd: 'true' },
      global_budget_tokens: 100_000_000,
      objective_cap: 3,
      objectives: [{
        id: 'a', goal: 'raise a', judgeClass: true,
        scorer: `node ${sc.path} a/visible.txt`, confirmScorer: `node ${sc.path} a/heldout.txt`,
        target: 90, editScope: 'a',
      }],
    }
    const baseline = git(scope, 'rev-parse', 'HEAD')
    // every candidate games the visible signal (95) while held-out stays flat at the baseline 50 -> reject all
    const child = makeTourneyChild([{ 'a/visible.txt': 95, 'a/heldout.txt': 50 }])
    const { state, verdict } = await runConverge(baseCfg(scope, sc.dir, { candidates: 2 }), manifest, { runChild: child, log: () => {} })
    assert.equal(verdict.status, 'capped') // never integrated a gamer -> exhausted retries
    assert.equal(readFileSync(join(scope, 'a/visible.txt'), 'utf8'), '0') // rolled back, gaming NOT integrated
    assert.equal(git(scope, 'rev-parse', 'HEAD'), baseline) // last-good never advanced
    assert.ok(state.rounds.some((r) => r.structural_signal === 'held_out_no_progress'))
    // the rejected round produced candidates that advanced then got rolled back — recorded like runOneObjective's
    // regression rollback, so the `contradiction` diagnostic (which counts rolledBack rounds) works in tournament mode
    assert.ok(state.rounds.some((r) => r.structural_signal === 'held_out_no_progress' && r.rolledBack === true))
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})

test('runConverge --candidates 2: refuses to start a round it cannot fund for ALL K passes (no K× overshoot)', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/visible.txt': '0', 'a/heldout.txt': '0' })
  try {
    const manifest = {
      goal: 'g', floor: { cmd: 'true' }, global_budget_tokens: 200_000, objective_cap: 3,
      objectives: [{
        id: 'a', goal: 'raise a', judgeClass: true,
        scorer: `node ${sc.path} a/visible.txt`, confirmScorer: `node ${sc.path} a/heldout.txt`, target: 90, editScope: 'a',
      }],
    }
    // 200K funds ONE pass (>=150K) but not TWO (<300K) -> a candidates:2 round is never launched
    let childCalls = 0
    const child = async (cfg) => { childCalls++; return makeTourneyChild([{ 'a/visible.txt': 80, 'a/heldout.txt': 95 }])(cfg) }
    const { verdict } = await runConverge(baseCfg(scope, sc.dir, { candidates: 2, globalBudgetTokens: 200_000 }), manifest, { runChild: child, log: () => {} })
    assert.equal(verdict.status, 'capped')
    assert.match(verdict.reason, /budget/)
    assert.equal(childCalls, 0) // never launched a tournament round it could not fund K passes for
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})

test('runConverge --candidates 1 is the unchanged single-candidate path (backward compatible)', async () => {
  const sc = writeScorer()
  const scope = tempRepo({ 'a/val.txt': '0' })
  try {
    const manifest = {
      goal: 'raise a', floor: { cmd: 'true' }, global_budget_tokens: 100_000_000, objective_cap: 4,
      objectives: [{ id: 'a', goal: 'raise a', scorer: `node ${sc.path} a/val.txt`, target: 90, editScope: 'a' }],
    }
    const child = makeTourneyChild([{ 'a/val.txt': 100 }])
    const { state, verdict } = await runConverge(baseCfg(scope, sc.dir, { candidates: 1 }), manifest, { runChild: child, log: () => {} })
    assert.equal(verdict.status, 'done')
    assert.equal(readFileSync(join(scope, 'a/val.txt'), 'utf8'), '100')
    assert.ok(state.rounds.every((r) => r.candidates == null)) // single-candidate rounds carry no tournament marker
  } finally {
    rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true })
  }
})
