// src/forge/hook.mjs
// Verifier Forge brick 4a — the loop integration (produce side). forgeShouldFire decides when the Forge
// runs (a single-file run that RECOVERED to true-done after a veto); runForgeHook sources the good/bad pair
// and runs the cycle (src/forge/run.mjs). Kept out of driver.mjs so the driver change stays a thin guarded
// call. The allowlist is built inline from --scorer-allow (not imported from scope-cli) to avoid a
// driver<->scope-cli import cycle.
import { resolve, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { safeSnapshotPath } from '../state.mjs'
import { isUnsafeScorer } from '../scorer-safety.mjs'
import { generateCandidates, claudePropose } from './generate.mjs'
import { admitCheck, scorerRunCheck } from './admit.mjs'
import { corroborateLabels } from './corroborate.mjs'
import { pruneFlaky } from './prune.mjs'
import { loadStore, saveStore, addCheck } from './store.mjs'
import { runForge } from './run.mjs'

// Fire ONLY when a run recovered to true-done after a veto, with forge enabled + a confirm scorer + a store
// path. confirm_vetoed_at_pass is never cleared on a later confirm-pass, so != null at a done verdict means
// "recovered from a veto at that pass" (the one moment a reliable good/bad pair exists). The marker is set by
// BOTH a confirm veto (gaming) and a stability veto (flaky score) — intentionally: both are verifier-weakness
// signals worth learning from, and admitCheck (brick 1) drops any proposal that doesn't reproducibly
// discriminate, so a flaky-sourced `bad` simply yields nothing admittable rather than a bad store write.
// (A precise confirm-vs-stability source marker would need a loop.mjs change — deferred to brick 4b.)
export function forgeShouldFire(cfg, state, verdict) {
  return !!cfg.forge && verdict.status === 'done' && state.confirm_vetoed_at_pass != null &&
    !!cfg.confirmScorerCmd && !!cfg.forgeStorePath
}

// Scorers whose contract is "execute my argument" (a --cmd / raw manifest line run via shell:true) turn
// the shq-quoted DATA args back into code INSIDE the scorer, downstream of the Forge fence — so they must
// NEVER be a proposable Forge check, even if an operator --scorer-allow names one (the MODEL picks the id;
// the operator only names paths). The denylist test is normalization-robust + realpath-aware via
// isUnsafeScorer (shared with scope-cli's SUBGATE_UNSAFE so the two trust boundaries cannot drift).
// io-assert (JSON data only) is the safe behavioural check.
const FORGE_UNSAFE_SCORERS = new Set(['test-pass-rate', 'composite'])
const SCORERS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scorers')
const SHIPPED_UNSAFE = [resolve(SCORERS_DIR, 'test-pass-rate.mjs'), resolve(SCORERS_DIR, 'composite.mjs')]

// The proposable-scorer allowlist: operator-named scorers only (--scorer-allow), basename -> absolute path.
// Command-executing scorers are denylisted (above).
export function forgeAllowlist(scorerAllow = []) {
  return new Map(
    scorerAllow
      .filter((p) => !isUnsafeScorer(p, FORGE_UNSAFE_SCORERS, SHIPPED_UNSAFE))
      .map((p) => [basename(p).replace(/\.[^.]+$/, ''), resolve(p)]),
  )
}

// Usage hints for the shipped discriminating scorers so the model proposes valid args; '' for unknown ids.
const SCORER_USAGE = {
  'io-assert': "--fn <exported function name> --case 'JSON_INPUT=>JSON_OUTPUT' (repeat --case for several inputs; a BEHAVIOURAL check for a PURE function that ANY correct implementation passes and the gamed one fails — PREFER this over a brittle textual contains)",
  'io-trace': "--new <ClassExport> | --factory <fnExport> [--init '<JSON args>'] --trace '<JSON [[method,...args],...]>' --expect '<JSON [return,...]>' (BEHAVIOURAL check for STATEFUL surfaces — construct a subject and assert a method-call SEQUENCE's returns; end the trace with a getter to assert final state; PREFER this over contains when the export is a class/factory rather than a pure function)",
  'io-invariant': "--fn <exported function name> --case '<JSON arg-list>' (repeat; the arg LIST is SPREAD, so a UNARY array fn is DOUBLE-wrapped: '[[3,1,2]]' means f([3,1,2])) --invariant '<name>[:<JSON param>]' (repeat; ALL must hold) [--basis <argIndex>=0]. A PROPERTY check for a PURE function whose EXACT output can't be pinned (non-deterministic order, input-dependent) — use when io-assert can't. Invariants: sorted, permutation-of-input, length-preserved, unique, in-range:[min,max], input-unchanged (combine e.g. sorted+permutation-of-input for a real sort)",
  contains: '--needle <substring present only in an honest artifact> (brittle — rejects valid alternate phrasings; use only when a behavioural check is impossible)',
}
export function forgeCatalog(allowlist) {
  return [...allowlist.keys()].map((id) => ({ id, usage: SCORER_USAGE[id] ?? '' }))
}

// Source good/bad from the recovered run and run the cycle. good = the confirmed-honest final artifact;
// bad = the vetoed gamed snapshot. Real pieces injected by default; tests pass stubs via `deps`.
export async function runForgeHook({ cfg, state, loopDir }, deps = {}) {
  const bad = deps.badArtifact ?? safeSnapshotPath(loopDir, state.history[state.confirm_vetoed_at_pass].snapshot)
  const good = deps.goodArtifact ?? state.artifact_path
  const allowlist = forgeAllowlist(cfg.scorerAllow)
  const generate = deps.generate ?? ((a) => generateCandidates({ ...a, propose: (p) => claudePropose(p, { model: cfg.model }) }))
  const admit = deps.admit ?? ((a) => admitCheck({ ...a, runCheck: scorerRunCheck }))
  // Frontier 2a: corroborate the veto's good/bad labelling with independent operator oracles before learning.
  // Oracles run VERBATIM via scorerRunCheck (operator-authored, NOT through forgeAllowlist). Empty oracleCmds
  // => corroborateLabels is a $0 passthrough, so this is inert unless --forge-oracle is set.
  const corroborate = deps.corroborate ?? ((a) => corroborateLabels({ ...a, runCheck: scorerRunCheck }))
  const r = await (deps.runForge ?? runForge)({
    goal: state.goal,
    goodArtifact: good,
    badArtifact: bad,
    critique: state.last_critique ?? '',
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
  return r
}
