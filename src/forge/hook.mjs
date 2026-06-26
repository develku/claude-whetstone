// src/forge/hook.mjs
// Verifier Forge brick 4a — the loop integration (produce side). forgeShouldFire decides when the Forge
// runs (a single-file run that RECOVERED to true-done after a veto); runForgeHook sources the good/bad pair
// and runs the cycle (src/forge/run.mjs). Kept out of driver.mjs so the driver change stays a thin guarded
// call. The allowlist is built inline from --scorer-allow (not imported from scope-cli) to avoid a
// driver<->scope-cli import cycle.
import { resolve, basename } from 'node:path'
import { safeSnapshotPath } from '../state.mjs'
import { generateCandidates, claudePropose } from './generate.mjs'
import { admitCheck, scorerRunCheck } from './admit.mjs'
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

// The proposable-scorer allowlist: operator-named scorers only (--scorer-allow), basename -> absolute path.
// Mirrors scope-cli buildAllowlist's extraPaths handling; kept local to avoid a driver<->scope-cli cycle.
export function forgeAllowlist(scorerAllow = []) {
  return new Map(scorerAllow.map((p) => [basename(p).replace(/\.[^.]+$/, ''), resolve(p)]))
}

// Usage hints for the shipped discriminating scorers so the model proposes valid args; '' for unknown ids.
const SCORER_USAGE = {
  'io-assert': "--fn <exported function name> --case 'JSON_INPUT=>JSON_OUTPUT' (repeat --case for several inputs; a BEHAVIOURAL check that ANY correct implementation passes and the gamed one fails — PREFER this over a brittle textual contains)",
  contains: '--needle <substring present only in an honest artifact> (brittle — rejects valid alternate phrasings; use only when a behavioural check is impossible)',
  'test-pass-rate': '--cmd <test command> --only <test name>',
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
  return (deps.runForge ?? runForge)({
    goal: state.goal,
    goodArtifact: good,
    badArtifact: bad,
    critique: state.last_critique ?? '',
    scorerCatalog: forgeCatalog(allowlist),
    allowlist,
    storePath: cfg.forgeStorePath,
    generate,
    admit,
    loadStore,
    saveStore,
    addCheck,
  })
}
