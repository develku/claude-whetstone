#!/usr/bin/env node
// The driver wires the real side effects (scorer process, artifact snapshots,
// state.json, the Claude act step) into the pure loop. buildContext takes an
// injectable `act` so the whole pipeline is testable without spending money.
import { spawnSync } from 'node:child_process'
import { copyFileSync, readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve, join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { shq } from './shq.mjs'
import { parseScorerJson } from './parse-scorer.mjs'
import {
  initState,
  recordPass,
  ensureLoopDir,
  loadState,
  saveState,
  safeSnapshotPath,
  snapshotArtifact,
  writeReview,
  zeroPad,
} from './state.mjs'
import { runLoop } from './loop.mjs'
import { makeClaudeAct } from './act-claude.mjs'
import { validateConfig, EFFORT_LEVELS } from './validate.mjs'
import { prepareResume } from './resume.mjs'
import { formatReport } from './summary.mjs'
import { forgeShouldFire, runForgeHook } from './forge/hook.mjs'
import { composeConfirm } from './forge/gate.mjs'
import { loadStore, saveStore, findCheckKeys, retireCheck } from './forge/store.mjs'
import { crossRepoPermissionWarning } from './preflight.mjs'

export { shq } // re-exported so callers can keep importing shq from driver (the canonical impl is shq.mjs)

// Hard wall-clock cap on the scorer/observe children so a hung command (flaky endpoint, a
// never-returning render/server step) can't wedge an unattended loop forever.
const CHILD_TIMEOUT_MS = 5 * 60 * 1000

// The rescue (escalated) editor runs at a higher effort than the cheap forward passes — strength
// goes up on BOTH dials (model + effort) in one decisive jump, only when the loop proves it's stuck.
// 'high', not 'max': editing is the easy half, so reserve max for the judge / a deep-stall override.
const RESCUE_EFFORT = 'high'

// Resolve the editor's effort: forward passes use the operator's --effort; the rescue editor uses
// RESCUE_EFFORT as a FLOOR — never a downgrade. If the operator already runs --effort high|xhigh|max,
// the rescue keeps theirs, so escalation always raises (or holds) effort, never lowers it.
export function editorEffort(state, escalated) {
  if (!escalated) return state.effort
  const i = Math.max(EFFORT_LEVELS.indexOf(state.effort), EFFORT_LEVELS.indexOf(RESCUE_EFFORT))
  return EFFORT_LEVELS[i] ?? RESCUE_EFFORT
}

// The escalation LADDER: which stronger editors rescue a stall, in climb order (one rung per proven
// plateau/no-op stall — loop.mjs). A bare 'fable' auto-expands to opus->fable (operator decision
// 2026-07-02: a fable-enabled run still rescues via opus first — fable bills above opus and most
// stalls yield to opus); a comma list ('opus,fable') is the explicit general form. Rungs equal to
// the BASE model drop (a same-model rescue is a no-op rung), as do consecutive duplicates.
export function escalationLadder(escalateModel, baseModel = null) {
  if (!escalateModel) return []
  const names = String(escalateModel).split(',').map((s) => s.trim()).filter(Boolean)
  const expanded = names.length === 1 && /^(fable|claude-fable-5)$/i.test(names[0]) ? ['opus', names[0]] : names
  const rungs = []
  for (const m of expanded) {
    if (m === baseModel || m === rungs[rungs.length - 1]) continue
    rungs.push(m)
  }
  return rungs
}

function runScorer(scorerCmd, { output, loopDir, pass }) {
  const full = `${scorerCmd} --output ${shq(output)} --loop-dir ${shq(loopDir)} --pass ${zeroPad(pass)}`
  const res = spawnSync(full, { shell: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL' })
  if (res.error) throw new Error(`scorer failed (${res.error.code || res.error.message})`)
  if (res.status !== 0) throw new Error(`scorer exited ${res.status}: ${(res.stderr || '').slice(0, 500)}`)
  return parseScorerJson(res, scorerCmd)
}

function runObserve(observeCmd, loopDir) {
  const res = spawnSync(observeCmd, { shell: true, encoding: 'utf8', cwd: loopDir, maxBuffer: 32 * 1024 * 1024, timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL' })
  if (res.error) throw new Error(`observe failed (${res.error.code || res.error.message})`)
  if (res.status !== 0) throw new Error(`observe exited ${res.status}: ${(res.stderr || '').slice(0, 500)}`)
  return (res.stdout || '').trim()
}

export function buildContext(loopDir) {
  const evaluate = async (s) => {
    const pass = s.history.length
    // observe runs in cwd=loopDir but the scorer runs in the driver cwd, so resolve a relative
    // observe-emitted path against loopDir — else the scorer reads it against the wrong dir (ENOENT).
    const output = s.observe_cmd ? resolve(loopDir, runObserve(s.observe_cmd, loopDir)) : s.artifact_path
    const review = runScorer(s.scorer_cmd, { output, loopDir, pass })
    return { score: review.score, critique: review.critique, review }
  }
  const persist = (s, ev) => {
    const pass = s.history.length
    const snapshot = snapshotArtifact(loopDir, s.artifact_path, pass)
    const reviewRef = writeReview(loopDir, pass, ev.review ?? { score: ev.score, critique: ev.critique })
    // Charge BOTH spend sources on the pass: the editor's (act) and the scorer's own (review.usage —
    // an llm-judge scorer pays a second model call every pass; before v1.6.0 that spend was invisible
    // to the budget dials, measured on a real run at ~20% of tokens / ~30% of USD). Number()||0 so a
    // scorer without the optional usage field (every deterministic scorer) charges 0, never NaN.
    const next = recordPass(s, {
      score: ev.score,
      critique: ev.critique,
      snapshot,
      reviewRef,
      costUsd: (ev.costUsd ?? 0) + (Number(ev.review?.usage?.costUsd) || 0),
      tokens: (ev.tokens ?? 0) + (Number(ev.review?.usage?.tokens) || 0),
    })
    saveState(loopDir, next)
    return next
  }
  // done-branch confirmation: re-score the same output with an INDEPENDENT scorer, run by the loop
  // only when the gate would declare done. Mirrors evaluate's output resolution (observe or artifact).
  const confirm = async (s) => {
    // observe runs in cwd=loopDir but the scorer runs in the driver cwd, so resolve a relative
    // observe-emitted path against loopDir — else the scorer reads it against the wrong dir (ENOENT).
    const output = s.observe_cmd ? resolve(loopDir, runObserve(s.observe_cmd, loopDir)) : s.artifact_path
    const review = runScorer(s.confirm_scorer_cmd, { output, loopDir, pass: s.history.length })
    return { score: review.score, critique: review.critique }
  }
  return { evaluate, persist, confirm }
}

const defaultLog = (e) =>
  process.stderr.write(`pass ${e.pass} · score ${e.score} · best ${e.best} · ${e.status} — ${e.reason}\n`)

// Wire the loop's real side effects around an already-prepared state. Shared by a fresh run
// and by --resume; the only difference is whether the loop scores a baseline first.
async function runPrepared(cfg, state, deps, { skipBaseline = false } = {}) {
  // Validate here — the one choke point both a fresh run and --resume pass through — so an
  // invalid override (e.g. a non-numeric --cap that became NaN) can't slip past via resume.
  const errors = validateConfig(state)
  if (errors.length) throw new Error(errors.join('; '))
  const loopDir = cfg.loopDir
  // Verifier Forge (brick 4b): on a FRESH --forge run, compose the confirm scorer = MIN(base, ...stored
  // checks) so the accumulated checks harden this gate. Fresh-only (!skipBaseline): on --resume the composed
  // cmd is already persisted in state.json (its manifest persists in loopDir), so re-composing would nest a
  // composite inside a composite. loop.mjs control flow is untouched.
  if (!skipBaseline && cfg.forge && cfg.forgeStorePath) {
    // kind namespaces which stored checks compose: a scope (repo) run consumes only scope checks (per-file,
    // --rel), a single-file run only file checks. cfg.scope is set only by the scope CLI.
    const composed = composeConfirm({ baseConfirmCmd: state.confirm_scorer_cmd, storePath: cfg.forgeStorePath, loopDir, kind: cfg.scope ? 'scope' : 'file' })
    if (composed !== state.confirm_scorer_cmd) state = { ...state, confirm_scorer_cmd: composed }
  }
  // The escalation ladder is stamped on the state (before the save below) so the final report can
  // NAME each rung. Skipped when the caller injects its own escalated act (scope --decompose owns
  // that slot's meaning) — the models behind an injected act are unknowable here.
  const rungModels = cfg.noEscalate ? [] : escalationLadder(cfg.escalateModel ?? 'opus', state.model)
  if (rungModels.length && !deps.actEscalated) state = { ...state, escalate_models: rungModels }
  saveState(loopDir, state)

  // The context (evaluate/persist/confirm) is injectable so a different artifact KIND can swap it:
  // the scope (repo) loop passes a git-backed buildContext while reusing all the wiring below.
  const { evaluate, persist, confirm } = (deps.buildContext ?? buildContext)(loopDir)
  // Cheap editor every pass; stronger editor only after a plateau (escalation).
  // make is the editor factory (injectable so a test can observe the effort/model each editor is
  // built with — the real makeClaudeAct's effort is otherwise unobservable behind a claude spawn).
  const make = deps.makeAct ?? makeClaudeAct
  const act = deps.act ?? make({ artifactPath: state.artifact_path, model: state.model, mcpConfig: cfg.mcpConfig, effort: editorEffort(state, false) })
  // One rescue editor per ladder rung, each at the floored (never lowered) rescue effort;
  // runLoop climbs them in order, one rung per proven stall.
  const actEscalated =
    deps.actEscalated ??
    (rungModels.length
      ? rungModels.map((m) => make({ artifactPath: state.artifact_path, model: m, mcpConfig: cfg.mcpConfig, effort: editorEffort(state, true) }))
      : null)

  // keep-best: restore a prior snapshot back over the live artifact when a pass regressed.
  // safeSnapshotPath refuses a ref that escapes the run dir (a poisoned snapshot ref on resume).
  const restore = deps.restore ?? ((snap) => copyFileSync(safeSnapshotPath(loopDir, snap), state.artifact_path))

  const { state: final, verdict } = await runLoop({
    state,
    evaluate,
    act,
    actEscalated,
    persist,
    restore,
    confirm: deps.confirm ?? (state.confirm_scorer_cmd ? confirm : null),
    save: deps.save ?? ((st) => saveState(loopDir, st)), // durable confirm-veto marker (see confirmDone)
    skipBaseline,
    log: deps.log ?? defaultLog,
  })
  saveState(loopDir, final)
  // Verifier Forge (brick 4a): on a recovered-veto done, learn private checks from the run. Post-run, so the
  // loop control flow above is untouched. Fail-safe — a Forge error must not fail an already-successful run.
  if (forgeShouldFire(cfg, final, verdict)) {
    try {
      const r = await (deps.runForgeHook ?? runForgeHook)({ cfg, state: final, loopDir })
      const log = deps.log ?? defaultLog
      const base = { pass: final.pass, score: final.current_score, best: final.best_score }
      // A corroboration DECLINE (2a) is a distinct, healthy outcome — log it apart from a normal learn so it
      // is not mistaken for a 0-admitted no-op or (when it threw) a forge-error.
      if (r.corroborated === false) log({ ...base, status: 'forge-declined', reason: `declined to learn — ${r.conflicts.length} oracle conflict(s)` })
      else log({ ...base, status: 'forge', reason: `admitted ${r.admitted.length}, rejected ${r.rejected.length}` })
    } catch (e) {
      ;(deps.log ?? defaultLog)({ pass: final.pass, score: final.current_score, best: final.best_score, status: 'forge-error', reason: e.message })
    }
  }
  return { state: final, verdict }
}

export async function runFromConfig(cfg, deps = {}) {
  ensureLoopDir(cfg.loopDir)
  const state = initState(cfg)
  return runPrepared(cfg, state, deps) // runPrepared validates the config before any side effect
}

// --resume: continue a previously-stopped run from its state.json. Load the durable state,
// apply only the overrides the operator explicitly passed (cap/budget/target/model), and let
// the GATE decide whether resuming can make progress (prepareResume). The run then continues
// WITHOUT re-scoring a baseline — the live artifact is already the best snapshot.
export async function resumeFromConfig(cfg, deps = {}) {
  // Resume reads an EXISTING run, so load BEFORE creating anything — a typo'd --loop-dir must
  // fail with an actionable message (not a raw ENOENT/JSON error) and leave no orphan dir behind.
  let loaded
  try {
    loaded = loadState(cfg.loopDir)
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`cannot resume: no run found at ${cfg.loopDir} (no state.json) — check --loop-dir`)
    throw new Error(`cannot resume: state.json at ${cfg.loopDir} is corrupt (${e.message})`)
  }
  ensureLoopDir(cfg.loopDir) // run confirmed; ensure snapshots/ + reviews/ exist for persist
  const { state, error } = prepareResume(loaded, cfg.overrides ?? {})
  if (error) throw new Error(error)
  return runPrepared(cfg, state, deps, { skipBaseline: true })
}

// Persistent defaults: read ~/.config/whetstone/config.json (personal) then ./whetstone.config.json
// (project, wins). Supplies the cost/model knobs the operator would otherwise retype every run —
// especially --budget-tokens, which is awkward to size by hand because each pass burns ~100-150K
// tokens. CLI flags still override (parseCli's `defaults` arg). cwd/home are injectable for test.
// Malformed JSON throws a clear error rather than silently running with surprise defaults; a MISSING
// file is fine. Recognized keys (camelCase): budgetTokens, budgetUsd, hardCap, targetScore,
// plateauWindow, minDelta, model, effort, escalateModel, mcpConfig.
export function loadConfig(cwd = process.cwd(), home = homedir()) {
  let merged = {}
  for (const p of [join(home, '.config', 'whetstone', 'config.json'), join(cwd, 'whetstone.config.json')]) {
    let text
    try {
      text = readFileSync(p, 'utf8')
    } catch (e) {
      if (e.code === 'ENOENT') continue // a missing config is the normal case
      throw new Error(`cannot read whetstone config at ${p}: ${e.message}`)
    }
    try {
      merged = { ...merged, ...JSON.parse(text) }
    } catch (e) {
      throw new Error(`malformed whetstone config at ${p}: ${e.message}`)
    }
  }
  return merged
}

// defaults: persistent config-file values (loadConfig). Precedence is CLI flag > config > built-in.
export function parseCli(argv, defaults = {}) {
  const get = (name, def) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : def
  }
  // Collect a REPEATABLE flag (every occurrence). `get` returns only the first — wrong for --forge-oracle,
  // whose values are full scorer COMMAND strings (commas/spaces/quotes), so they must repeat, not comma-split.
  const getAll = (name) => argv.reduce((a, t, i) => (t === name && argv[i + 1] != null ? [...a, argv[i + 1]] : a), [])
  // The goal is the FIRST positional only (argv[2]). Scanning for any non-`--` token would pick
  // up a flag's value (e.g. --artifact x.txt) as the goal when the positional is omitted, slipping
  // past the usage guard and running with a garbage goal in every paid edit prompt.
  const positional = argv[2] && !argv[2].startsWith('--') ? argv[2] : undefined
  return {
    goal: positional ?? get('--goal'),
    artifactPath: get('--artifact'),
    scorerCmd: get('--scorer'),
    confirmScorerCmd: get('--confirm-scorer', null),
    observeCmd: get('--observe', null),
    targetScore: get('--target') ? Number(get('--target')) : defaults.targetScore,
    hardCap: get('--cap') ? Number(get('--cap')) : defaults.hardCap,
    budgetUsd: get('--budget') ? Number(get('--budget')) : defaults.budgetUsd,
    budgetTokens: get('--budget-tokens') ? Number(get('--budget-tokens')) : defaults.budgetTokens,
    stabilityRuns: get('--stability-runs') ? Number(get('--stability-runs')) : defaults.stabilityRuns,
    // Plateau knobs (consumed by initState -> gate.mjs). Previously unreadable here, so they were pinned
    // to initState's 3 / 1 fallback; exposing them lets a long overnight run widen the window / lower the
    // min improvement so a hard target keeps grinding instead of stalling out early.
    plateauWindow: get('--plateau-window') ? Number(get('--plateau-window')) : defaults.plateauWindow,
    minDelta: get('--min-delta') ? Number(get('--min-delta')) : defaults.minDelta,
    model: get('--model', defaults.model ?? 'sonnet'),
    effort: get('--effort', defaults.effort ?? 'medium'),
    escalateModel: get('--model-escalate', defaults.escalateModel ?? 'opus'),
    noEscalate: argv.includes('--no-escalate'),
    mcpConfig: get('--mcp-config', defaults.mcpConfig ?? null),
    loopDir: get('--loop-dir', `.loop/run_${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`),
    // Verifier Forge (brick 4a): opt-in. On a recovered-veto done, generate->admit->store private checks.
    forge: argv.includes('--forge'),
    forgeStorePath: get('--forge-store', null),
    scorerAllow: (get('--scorer-allow', '') || '').split(',').map((s) => s.trim()).filter(Boolean),
    // Frontier 2a: independent operator-trusted oracle command(s) that must corroborate a veto before the
    // Forge learns from it (repeatable). Empty => single-oracle behavior (today's). Run verbatim, NOT
    // through forgeAllowlist (operator-authored, same trust class as --confirm-scorer).
    forgeOracleCmds: getAll('--forge-oracle'),
    // Mutation-backed admit (item 1): strengthen admission from "fails the one observed bad" to "kills an
    // oracle-confirmed mutant neighbourhood". Requires --forge-oracle (the entry guard refuses it otherwise).
    forgeMutationAdmit: argv.includes('--forge-mutation-admit'),
    forgeMutationThreshold: get('--forge-mutation-threshold') ? Number(get('--forge-mutation-threshold')) : defaults.forgeMutationThreshold,
    // Brick 1.5: also require an admitted candidate to SURVIVE the executable exploit archive (reject a check an
    // archived gaming pattern can dodge). Composes after mutation-admit. Opt-in.
    forgeExploitRegression: argv.includes('--forge-exploit-regression'),
  }
}

// On resume, only the flags the operator actually typed become overrides — anything absent
// keeps the value carried in the loaded state.json (NO defaults, unlike a fresh run).
function parseResumeOverrides(argv) {
  const get = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const o = {}
  const cap = get('--cap')
  const budget = get('--budget')
  const budgetTokens = get('--budget-tokens')
  const target = get('--target')
  const model = get('--model')
  const stability = get('--stability-runs')
  const plateauWindow = get('--plateau-window')
  const minDelta = get('--min-delta')
  if (cap !== undefined) o.hard_cap = Number(cap)
  if (budget !== undefined) o.budget_usd = Number(budget)
  if (budgetTokens !== undefined) o.budget_tokens = Number(budgetTokens)
  if (target !== undefined) o.target_score = Number(target)
  if (model !== undefined) o.model = model
  if (stability !== undefined) o.stability_runs = Number(stability)
  if (plateauWindow !== undefined) o.plateau_window = Number(plateauWindow)
  if (minDelta !== undefined) o.min_delta = Number(minDelta)
  return o
}

// Robust entry-point check: pathToFileURL percent-encodes the path (spaces, etc.) so it matches
// import.meta.url even when the repo lives under a path with spaces. Node realpath-resolves
// import.meta.url but leaves process.argv[1] as the launch path, so also compare argv[1]'s realpath —
// otherwise a symlinked launch (`npm link`, or any `npm i -g` global bin) never matches and the CLI
// silently no-ops. The `||` short-circuits, so the realpathSync only runs on the symlink path.
if (process.argv[1] && (
  import.meta.url === pathToFileURL(process.argv[1]).href ||
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
)) {
  const argv = process.argv
  const flag = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }

  // Verifier Forge retirement: tombstone a false-positive check so it stops gating, without deleting its
  // record. Manual (operator judgment) — auto-retiring a check that vetoes where the base confirm passes
  // could remove a genuine catch the base gate missed. Standalone: load -> match by cmd -> retire -> save.
  if (argv.includes('--forge-retire')) {
    const storePath = flag('--forge-store')
    const cmd = flag('--check')
    if (!storePath || !cmd) {
      process.stderr.write('usage: driver.mjs --forge-retire --forge-store <path> --check "<scorer cmd>"\n')
      process.exit(2)
    }
    const store = loadStore(storePath)
    const keys = findCheckKeys(store, cmd)
    if (!keys.length) {
      process.stderr.write(`no stored check matches: ${cmd}\n`)
      process.exit(1)
    }
    let next = store
    for (const k of keys) next = retireCheck(next, k)
    saveStore(storePath, next)
    process.stdout.write(`retired ${keys.length} check(s) matching: ${cmd}\n`)
    process.exit(0)
  }

  if (argv.includes('--resume')) {
    const loopDir = flag('--loop-dir')
    if (!loopDir) {
      process.stderr.write('usage: driver.mjs --resume --loop-dir <existing run dir> [--cap N] [--budget X] [--budget-tokens N] [--stability-runs N] [--plateau-window N] [--min-delta X] [--target T] [--model M] [--model-escalate opus | --no-escalate] [--mcp-config <path>]\n')
      process.exit(2)
    }
    try {
      const { state, verdict } = await resumeFromConfig({
        loopDir,
        overrides: parseResumeOverrides(argv),
        mcpConfig: flag('--mcp-config') ?? null,
        escalateModel: flag('--model-escalate') ?? 'opus',
        noEscalate: argv.includes('--no-escalate'),
      })
      process.stdout.write(`\n${verdict.reason}\n${formatReport(state)}\n`)
      process.exit(verdict.status === 'done' ? 0 : 1)
    } catch (e) {
      process.stderr.write(`${e.message}\n`)
      process.exit(2)
    }
  }

  const cfg = parseCli(argv, loadConfig())
  if (!cfg.goal || !cfg.artifactPath || !cfg.scorerCmd) {
    process.stderr.write('usage: driver.mjs "<goal>" --artifact <path> --scorer "<cmd>" [--confirm-scorer "<cmd>"] [--observe <cmd>] [--target 90] [--cap 10] [--budget 2.00] [--budget-tokens N] [--stability-runs N] [--plateau-window N] [--min-delta X] [--model sonnet] [--effort medium] [--model-escalate opus | --no-escalate] [--mcp-config <path>] [--loop-dir <dir>] [--forge --forge-store <path> --scorer-allow <scorer.mjs,...> [--forge-oracle "<scorer cmd>" ...] [--forge-mutation-admit [--forge-mutation-threshold 0.75]]]\n  resume: driver.mjs --resume --loop-dir <existing run dir> [--cap N] [--budget X] [--budget-tokens N] [--stability-runs N] [--plateau-window N] [--min-delta X] [--target T] [--model M]\n')
    process.exit(2)
  }
  // Mutation-backed admit needs an independent oracle (codex finding 7): refuse the explicit flag without one
  // rather than silently admitting via the base gate (which would create false "hardened" confidence).
  if (cfg.forgeMutationAdmit && (cfg.forgeOracleCmds ?? []).length === 0) {
    process.stderr.write('--forge-mutation-admit requires at least one --forge-oracle "<scorer cmd>" (the independent oracle that filters equivalent mutants)\n')
    process.exit(2)
  }
  // A malformed --forge-mutation-threshold coerces to NaN, and `ratio >= NaN` is always false — which would
  // silently reject EVERY proposal with no warning. Fail loud on a non-[0,1] value instead.
  if (cfg.forgeMutationThreshold !== undefined && !(Number.isFinite(cfg.forgeMutationThreshold) && cfg.forgeMutationThreshold >= 0 && cfg.forgeMutationThreshold <= 1)) {
    process.stderr.write('--forge-mutation-threshold must be a number in [0,1]\n')
    process.exit(2)
  }
  // F2 preflight: warn (non-fatal) when editing a file in a DIFFERENT repo that carries a broad Claude
  // permission surface — the editor inherits it (runs --permission-mode acceptEdits in the artifact's dir).
  const permWarn = crossRepoPermissionWarning({ targetDir: dirname(resolve(cfg.artifactPath)) })
  if (permWarn) process.stderr.write(permWarn + '\n')
  const { state, verdict } = await runFromConfig(cfg)
  process.stdout.write(`\n${verdict.reason}\n${formatReport(state)}\n`)
  process.exit(verdict.status === 'done' ? 0 : 1)
}
