// src/forge/hook.mjs
// Verifier Forge brick 4a — the loop integration (produce side). forgeShouldFire decides when the Forge
// runs (a single-file run that RECOVERED to true-done after a veto); runForgeHook sources the good/bad pair
// and runs the cycle (src/forge/run.mjs). Kept out of driver.mjs so the driver change stays a thin guarded
// call. The allowlist is built inline from --scorer-allow (not imported from scope-cli) to avoid a
// driver<->scope-cli import cycle.
import { resolve, basename, join, dirname } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { shq } from '../shq.mjs'
import { safeSnapshotPath } from '../state.mjs'
import { isUnsafeScorer, SHELL_SCORERS, SHELL_SCORER_PATHS } from '../scorer-safety.mjs'
import { generateCandidates, claudePropose } from './generate.mjs'
import { admitCheck, scorerRunCheck } from './admit.mjs'
import { mutationAdmit } from './mutation-admit.mjs'
import { admitSurvivesExploits, exploitArchivePath, loadExploitArchive, appendExploit, saveExploitArchive } from './exploit-regression.mjs'
import { corroborateLabels } from './corroborate.mjs'
import { pruneFlaky } from './prune.mjs'
import { loadStore, saveStore, addCheck, listActiveChecks } from './store.mjs'
import { runForge } from './run.mjs'

// Fire ONLY when a run recovered to true-done after a veto, with forge enabled + a confirm scorer + a store
// path. confirm_vetoed_at_pass is never cleared on a later confirm-pass, so != null at a done verdict means
// "recovered from a veto at that pass" (the one moment a reliable good/bad pair exists). The marker is set by
// BOTH a confirm veto (gaming) and a stability veto (flaky score) — intentionally: both are verifier-weakness
// signals worth learning from, and admitCheck (brick 1) drops any proposal that doesn't reproducibly
// discriminate, so a flaky-sourced `bad` simply yields nothing admittable rather than a bad store write.
// (A precise confirm-vs-stability source marker would need a loop.mjs change — deferred to brick 4b.)
export function forgeShouldFire(cfg, state, verdict) {
  // The confirm gate may come from --confirm-scorer (cfg) OR from the auto-composed store gate
  // (state.confirm_scorer_cmd set by composeConfirmFromStore at run start, cfg flag null) — a veto by
  // the auto-composed gate that recovers is the forge's prime learning moment, so accept either source.
  return !!cfg.forge && verdict.status === 'done' && state.confirm_vetoed_at_pass != null &&
    !!(cfg.confirmScorerCmd || state.confirm_scorer_cmd) && !!cfg.forgeStorePath
}

// Fire on a SUSPICIOUSLY-EASY done (v1.8.0): exactly 1 edit pass to done with NO done-edge check wired
// (the thinScorerWarning condition) — zero finish-line skepticism was paid, so learn from the run instead.
// The (good,bad) pair is (final artifact, BASELINE snapshot): a legitimate discriminating pair for a
// 1-edit done. A 0-edit baseline-done has no pair -> never fires (the warning stays the only response);
// >=2-edit dones took real work. Disjoint from the recovered-veto trigger by construction (a veto needs a
// confirm/stability gate, which "unwired" excludes) — the marker check makes that explicit and testable.
// NOTE the admitted checks pass the current final by construction, so they cannot veto THIS run's done;
// the payoff is the NEXT run, whose gate auto-composes from the store (composeConfirmFromStore).
export function easyForgeShouldFire(cfg, state, verdict) {
  return !!cfg.forge && !!cfg.forgeStorePath && !cfg.scope &&
    verdict.status === 'done' &&
    state.confirm_vetoed_at_pass == null &&
    !state.confirm_scorer_cmd &&
    (state.stability_runs ?? 1) <= 1 &&
    (state.history?.length ?? 0) - 1 === 1
}

// Scorers whose contract is "execute my argument" (a --cmd / raw manifest line run via shell:true) turn
// the shq-quoted DATA args back into code INSIDE the scorer, downstream of the Forge fence — so they must
// NEVER be a proposable Forge check, even if an operator --scorer-allow names one (the MODEL picks the id +
// args; the operator only names paths). The Forge is the SAME model-authors-args threat as Track A's plan
// allowlist, so it subtracts the SAME canonical set: SHELL_SCORERS (composite, floor, test-pass-rate,
// llm-judge) from scorer-safety.mjs — defined once there so the two boundaries cannot drift (they had: this
// list was once {test-pass-rate, composite} only, a model-authored-RCE hole via floor's --cmd / llm-judge's
// --rubric+--mcp-config). The test is normalization-robust + realpath-aware via isUnsafeScorer.
// The io-* behavioural scorers (io-assert/io-trace/io-effect/io-invariant) are safe to propose for TWO
// reasons: (1) their args are DATA only (JSON in/out — no shell exec), and (2) they import & run the model's
// artifact in a locked-down CHILD process (src/iso-runner.mjs, #2), so the artifact code cannot reach the
// oracle. Earlier comments calling these "data-only safe" were half-right — importing artifact CODE was the
// real danger; out-of-process isolation, not the data-only args, is what closes it.

// The proposable-scorer allowlist: operator-named scorers only (--scorer-allow), basename -> absolute path.
// Command-executing scorers are denylisted (SHELL_SCORERS, above).
export function forgeAllowlist(scorerAllow = []) {
  return new Map(
    scorerAllow
      .filter((p) => !isUnsafeScorer(p, SHELL_SCORERS, SHELL_SCORER_PATHS))
      .map((p) => [basename(p).replace(/\.[^.]+$/, ''), resolve(p)]),
  )
}

// Usage hints for the shipped discriminating scorers so the model proposes valid args; '' for unknown ids.
const SCORER_USAGE = {
  'io-assert': "--fn <exported function name> --case 'JSON_INPUT=>JSON_OUTPUT' (repeat --case for several inputs; a BEHAVIOURAL check for a PURE function that ANY correct implementation passes and the gamed one fails — PREFER this over a brittle textual contains)",
  'io-trace': "--new <ClassExport> | --factory <fnExport> [--init '<JSON args>'] --trace '<JSON [[method,...args],...]>' --expect '<JSON [return,...]>' (BEHAVIOURAL check for STATEFUL surfaces — construct a subject and assert a method-call SEQUENCE's returns; end the trace with a getter to assert final state; PREFER this over contains when the export is a class/factory rather than a pure function)",
  'io-invariant': "--fn <exported function name> --case '<JSON arg-list>' (repeat; the arg LIST is SPREAD, so a UNARY array fn is DOUBLE-wrapped: '[[3,1,2]]' means f([3,1,2])) --invariant '<name>[:<JSON param>]' (repeat; ALL must hold) [--basis <argIndex>=0]. A PROPERTY check for a PURE function whose EXACT output can't be pinned (non-deterministic order, input-dependent) — use when io-assert can't. Invariants: sorted, permutation-of-input, length-preserved, unique, in-range:[min,max], input-unchanged (combine e.g. sorted+permutation-of-input for a real sort)",
  'io-effect': "--fn <exported function name> --sink '<JSON initial value, e.g. [] or {}>' --calls '<JSON [[...args],...]>' --expect-sink '<JSON post-call state>' [--expect-returns '<JSON [...]>']. A SIDE-EFFECT check: the fn is called fn(sink, ...args) for each entry and MUTATES the carried first arg; assert the sink's final state. Use for in-place mutation (sortInPlace), accumulators/loggers (push to a sink) — the surface where the contract is a side effect and the RETURN is undefined, which io-trace can't see. A single call with no extra args is --calls '[[]]'.",
  contains: '--needle <substring present only in an honest artifact> (brittle — rejects valid alternate phrasings; use only when a behavioural check is impossible)',
}
export function forgeCatalog(allowlist) {
  return [...allowlist.keys()].map((id) => ({ id, usage: SCORER_USAGE[id] ?? '' }))
}

// The easy-done pair's critique: the DONE-pass critique describes the PASSING artifact, so the
// discriminating text is the BASELINE review's critique ("what was wrong before the edit"). Best-effort
// '' — a missing/corrupt review only weakens the generator prompt, never blocks the learn. The ref is
// resolved through safeSnapshotPath so a tampered critique_ref cannot escape the run dir.
function baselineCritique(loopDir, state) {
  try {
    const ref = state.history?.[0]?.critique_ref
    if (!ref) return ''
    const review = JSON.parse(readFileSync(safeSnapshotPath(loopDir, ref), 'utf8'))
    return typeof review.critique === 'string' ? review.critique : ''
  } catch {
    return ''
  }
}

// Source good/bad from the run and run the cycle. trigger 'recovered-veto' (default): good = the
// confirmed-honest final artifact, bad = the vetoed gamed snapshot. trigger 'easy-done': bad = the
// BASELINE snapshot (iter_000) — the only bad example an unwired 1-edit done has — with an explicit
// existence check (a named throw is caught by the driver's fail-safe as forge-error; the done verdict
// is untouched either way). Real pieces injected by default; tests pass stubs via `deps`.
export async function runForgeHook({ cfg, state, loopDir, trigger = 'recovered-veto' }, deps = {}) {
  // AUD-10 'gate-survivor': the bad/good are caller-provided (a probe survivor mutant + the accepted final) —
  // NEVER index state.history (confirm_vetoed_at_pass is null here) and require both deps, fail loud if missing.
  if (trigger === 'gate-survivor' && (!deps.badArtifact || !deps.goodArtifact)) {
    throw new Error('gate-survivor forge: requires deps.badArtifact (survivor mutant) + deps.goodArtifact (final)')
  }
  const badRef = trigger === 'easy-done'
    ? state.history?.[0]?.snapshot
    : trigger === 'gate-survivor'
      ? null // bad comes from deps.badArtifact; do not touch history
      : state.history[state.confirm_vetoed_at_pass].snapshot
  if (trigger === 'easy-done' && !deps.badArtifact) {
    if (!badRef) throw new Error('easy-done forge: no baseline snapshot ref in history')
    if (!existsSync(safeSnapshotPath(loopDir, badRef))) throw new Error(`easy-done forge: baseline snapshot missing on disk: ${badRef}`)
  }
  const bad = deps.badArtifact ?? safeSnapshotPath(loopDir, badRef)
  const good = deps.goodArtifact ?? state.artifact_path
  // AUD-07: capture the vetoed gamed snapshot into the live exploit archive (beside the store file) so the
  // regression gate grows past its static seeds. recovered-veto ONLY — an easy-done baseline is merely "before",
  // not a confirmed exploit. Best-effort: a missing/unreadable snapshot must never fail a done run (the driver
  // also fail-safes forge errors).
  if (trigger === 'recovered-veto' && cfg.forgeStorePath) {
    try {
      if (existsSync(bad)) {
        const archivePath = exploitArchivePath(cfg.forgeStorePath)
        saveExploitArchive(archivePath, appendExploit(loadExploitArchive(archivePath), {
          source: readFileSync(bad, 'utf8'), taxonomy: 'live-veto', origin: basename(loopDir), ts: state.updated_at ?? null,
        }))
      }
    } catch { /* archive is best-effort; forge learning continues regardless */ }
  }
  const allowlist = forgeAllowlist(cfg.scorerAllow)
  const generate = deps.generate ?? ((a) => generateCandidates({ ...a, propose: (p) => claudePropose(p, { model: cfg.model }) }))
  // Admission composition (centralized order: admitCheck -> mutationAdmit -> admitSurvivesExploits — each is a
  // WRAPPER that calls its base first and only ever ADDS a rejection, so the gate is never more permissive).
  // Item 1 (--forge-mutation-admit): require killing an oracle-confirmed mutant neighbourhood (reuses the 2a
  // oracles). Brick 1.5 (--forge-exploit-regression): require surviving the executable exploit archive. Both
  // opt-in and composable; deps.admit still overrides in tests.
  const baseAdmit = cfg.forgeMutationAdmit
    ? (a) => mutationAdmit({ ...a, runCheck: scorerRunCheck, oracleCmds: cfg.forgeOracleCmds ?? [], mutationKillThreshold: cfg.forgeMutationThreshold })
    : (a) => admitCheck({ ...a, runCheck: scorerRunCheck })
  const admit = deps.admit ?? (cfg.forgeExploitRegression
    ? (a) => admitSurvivesExploits({ ...a, runCheck: scorerRunCheck, baseAdmit, archivePath: cfg.forgeStorePath ? exploitArchivePath(cfg.forgeStorePath) : null })
    : baseAdmit)
  // Frontier 2a: corroborate the veto's good/bad labelling with independent operator oracles before learning.
  // Oracles run VERBATIM via scorerRunCheck (operator-authored, NOT through forgeAllowlist). Empty oracleCmds
  // => corroborateLabels is a $0 passthrough, so this is inert unless --forge-oracle is set.
  const corroborate = deps.corroborate ?? ((a) => corroborateLabels({ ...a, runCheck: scorerRunCheck }))
  const r = await (deps.runForge ?? runForge)({
    goal: state.goal,
    goodArtifact: good,
    badArtifact: bad,
    critique: trigger === 'easy-done'
      ? baselineCritique(loopDir, state)
      : trigger === 'gate-survivor'
        ? 'the composed confirm gate PASSED this broken mutant — learn a check that FAILS it'
        : (state.last_critique ?? ''),
    scorerCatalog: forgeCatalog(allowlist),
    allowlist,
    storePath: cfg.forgeStorePath,
    generate,
    admit,
    corroborate,
    oracleCmds: cfg.forgeOracleCmds ?? [],
    loadStore,
    saveStore,
    addCheck,
  })
  // Auto-flaky retirement: tombstone any active file check now non-reproducible on the honest good artifact
  // (self-healing — a flaky gate would randomly veto honest runs). Only the unstable; stable-fail stays manual.
  // Skip prune on a corroboration decline (corroborated:false): the run learned nothing, so skip the store-
  // maintenance replays too, and stay consistent with scope-hook.mjs. (prune retires only NON-reproducible
  // checks — orthogonal to the label dispute — so this is cost + consistency, NOT a correctness fix.) corroborated
  // is true on the no-oracle passthrough, so strict === false leaves the normal (no --forge-oracle) case untouched.
  if (r.corroborated !== false) {
    const pruned = await (deps.pruneFlaky ?? pruneFlaky)({ storePath: cfg.forgeStorePath, goodArtifact: good, kind: 'file', runCheck: scorerRunCheck })
    if (pruned.length) r.retiredFlaky = pruned
  }
  r.trigger = trigger // provenance for the driver's forge log line (matches r.retiredFlaky's local mutate idiom)
  return r
}

const COMPOSITE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scorers', 'composite.mjs')

// Consume-without-base (v1.8.0). The invariant composeConfirm (forge/gate.mjs) is a passthrough when
// there is no base confirm cmd — so an UNWIRED run could never consume stored checks, and everything an
// easy-done run learns would never bite. This non-invariant sibling composes a confirm gate from the
// store ALONE: same manifest file, same composite MIN semantics, just no base line. Returns null when
// the store has no active checks of the kind. The two compose paths are mutually exclusive (the driver
// picks exactly one per run), so the shared gate-checks.txt filename cannot collide.
export function composeConfirmFromStore(
  { storePath, loopDir, kind = 'file', compositePath = COMPOSITE },
  { loadStore: load = loadStore, listChecks = listActiveChecks, writeManifest = (p, body) => writeFileSync(p, body) } = {},
) {
  const checks = listChecks(load(storePath), kind)
  if (!checks.length) return null
  const manifest = join(loopDir, 'gate-checks.txt')
  writeManifest(manifest, checks.map((c) => c.cmd).join('\n') + '\n')
  return ['node', shq(compositePath), '--scorers-file', shq(manifest)].join(' ')
}
