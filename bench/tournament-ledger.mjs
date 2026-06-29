#!/usr/bin/env node
// bench/tournament-ledger.mjs
// Inc 1 tournament ledger: MEASURE the winner's-curse antidote at $0 (real git, deterministic stub children,
// real reMeasureAll, no model). Two sections:
//   SELECT   — pickTournamentWinner (pure): the NAIVE visible-max choice vs the tournament's held-out choice.
//              The antidote has value iff they DIFFER on a gamed field (held-out flips the pick off the gamer).
//   PIPELINE — runConverge --candidates 2 end-to-end: a gamer (high visible, low held-out) and an honest
//              candidate compete; the HONEST tree must be the one integrated, and an all-gamer round must be
//              REJECTED (no gamer tree integrated). Proves the antidote in the real gate pipeline.
//
// Run: node bench/tournament-ledger.mjs   (always $0 — deterministic). Exit 1 if any scenario fails.
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pickTournamentWinner, runConverge } from '../src/converge.mjs'

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
let fails = 0
const check = (label, ok, detail = '') => { console.log(`  ${ok ? '✔' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`); if (!ok) fails++ }

// the naive baseline a tournament without held-out would use: argmax on the VISIBLE signal among the eligible
const naiveVisibleWinner = (cands) => cands.filter((c) => c.eligible).reduce((b, c) => (c.visible > b.visible ? c : b)).index

// --- SECTION 1: SELECT (pure) — the antidote must flip the choice off the gamer -----------------------------
console.log('SELECT (pickTournamentWinner, pure):')
const SELECT_CASES = [
  { id: 'double', cands: [{ index: 0, eligible: true, visible: 98, heldOut: 30 }, { index: 1, eligible: true, visible: 85, heldOut: 92 }], lastGoodTruth: 20 },
  { id: 'max', cands: [{ index: 0, eligible: true, visible: 99, heldOut: 50 }, { index: 1, eligible: true, visible: 88, heldOut: 95 }], lastGoodTruth: 40 },
]
for (const c of SELECT_CASES) {
  const naive = naiveVisibleWinner(c.cands)
  const pick = pickTournamentWinner(c.cands, { judgeClass: true, lastGoodTruth: c.lastGoodTruth, minDelta: 1 })
  const naiveIsGamer = c.cands[naive].heldOut < c.cands[pick.winnerIndex].heldOut
  check(`[${c.id}] naive visible-max=#${naive} (held-out ${c.cands[naive].heldOut}) -> tournament held-out winner=#${pick.winnerIndex} (held-out ${c.cands[pick.winnerIndex].heldOut})`,
    pick.winnerIndex !== naive && naiveIsGamer, 'antidote flips the pick off the gamer')
}
// the reject-all guard: no candidate improves the held-out truth -> the round is declined, not integrated
{
  const r = pickTournamentWinner([{ index: 0, eligible: true, visible: 95, heldOut: 50 }, { index: 1, eligible: true, visible: 90, heldOut: 50 }], { judgeClass: true, lastGoodTruth: 50, minDelta: 1 })
  check('[stall] all candidates flat on held-out -> reject ALL', r.rejectAll === true && r.signal === 'held_out_no_progress')
}

// --- SECTION 2: PIPELINE (runConverge --candidates 2, real git) --------------------------------------------
function writeScorer() {
  const dir = mkdtempSync(join(tmpdir(), 'whet-tlsc-'))
  const path = join(dir, 'score.mjs')
  writeFileSync(path, "import { readFileSync } from 'node:fs'\nconst f = process.argv[2]\nlet n = 0\ntry { n = Number(readFileSync(f, 'utf8').trim()) } catch {}\nprocess.stdout.write(JSON.stringify({ score: n, critique: 'raise ' + f }))\n")
  return { dir, path }
}
function tempRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'whet-tl-'))
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't')
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'seed')
  return dir
}
const cfg = (scope, sc, o = {}) => ({ scope, objectivesPath: join(sc, 'objectives.json'), convergeDir: mkdtempSync(join(tmpdir(), 'whet-tld-')), globalBudgetTokens: 1e9, globalCap: 12, globalStabilityRuns: 2, globalPlateauWindow: 3, globalMinProgress: 1, minDelta: 1, objectiveRetries: 1, model: 'sonnet', effort: 'medium', noEscalate: true, ...o })
function makeChild(plans) {
  let i = 0
  return async (childCfg) => {
    const plan = plans[Math.min(i, plans.length - 1)]; i++
    for (const [rel, val] of Object.entries(plan)) { mkdirSync(join(childCfg.scope, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true }); writeFileSync(join(childCfg.scope, rel), String(val)) }
    git(childCfg.scope, 'add', '-A'); git(childCfg.scope, 'commit', '-q', '--allow-empty', '-m', 'cand')
    return { state: { spent_usd: 0, spent_tokens: 0 } }
  }
}
const judgeObj = (sc) => ({ id: 'a', goal: 'raise a', judgeClass: true, scorer: `node ${sc.path} a/visible.txt`, confirmScorer: `node ${sc.path} a/heldout.txt`, target: 90, editScope: 'a' })

console.log('\nPIPELINE (runConverge --candidates 2, real git):')
// honest-wins: gamer (visible 98, held-out 30) vs honest (visible 85, held-out 95 >= target) -> honest integrated
{
  const sc = writeScorer(); const scope = tempRepo({ 'a/visible.txt': '0', 'a/heldout.txt': '0' })
  try {
    const manifest = { goal: 'g', floor: { cmd: 'true' }, global_budget_tokens: 1e9, objective_cap: 4, objectives: [judgeObj(sc)] }
    const child = makeChild([{ 'a/visible.txt': 98, 'a/heldout.txt': 30 }, { 'a/visible.txt': 85, 'a/heldout.txt': 95 }])
    const { state, verdict } = await runConverge(cfg(scope, sc.dir, { candidates: 2 }), manifest, { runChild: child, log: () => {} })
    const heldout = readFileSync(join(scope, 'a/heldout.txt'), 'utf8')
    const visible = readFileSync(join(scope, 'a/visible.txt'), 'utf8')
    check(`honest-wins -> done, honest tree integrated (visible=${visible}, heldout=${heldout})`,
      verdict.status === 'done' && heldout === '95' && visible === '85' && state.rounds.find((r) => r.accepted)?.winner_index === 1,
      'gamer visible=98 NOT integrated')
  } finally { rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true }) }
}
// all-gamer: every candidate games visible (95) while held-out stays flat (50) -> round rejected, nothing integrated
{
  const sc = writeScorer(); const scope = tempRepo({ 'a/visible.txt': '0', 'a/heldout.txt': '50' })
  try {
    const base = git(scope, 'rev-parse', 'HEAD')
    const manifest = { goal: 'g', floor: { cmd: 'true' }, global_budget_tokens: 1e9, objective_cap: 3, objectives: [judgeObj(sc)] }
    const { state, verdict } = await runConverge(cfg(scope, sc.dir, { candidates: 2 }), manifest, { runChild: makeChild([{ 'a/visible.txt': 95, 'a/heldout.txt': 50 }]), log: () => {} })
    check(`all-gamer -> capped, no gamer integrated (visible=${readFileSync(join(scope, 'a/visible.txt'), 'utf8')})`,
      verdict.status === 'capped' && readFileSync(join(scope, 'a/visible.txt'), 'utf8') === '0' && git(scope, 'rev-parse', 'HEAD') === base && state.rounds.some((r) => r.structural_signal === 'held_out_no_progress'),
      'winner-curse guard held')
  } finally { rmSync(scope, { recursive: true, force: true }); rmSync(sc.dir, { recursive: true, force: true }) }
}

console.log(`\nspend: $0 (deterministic — stub children, node scorers)`)
console.log(fails === 0 ? '\nLEDGER GREEN — winner\'s-curse antidote holds (held-out flips the pick off the gamer; all-gamer rounds rejected)' : `\nLEDGER RED — ${fails} scenario(s) failed`)
process.exit(fails === 0 ? 0 : 1)
