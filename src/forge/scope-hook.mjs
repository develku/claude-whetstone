// src/forge/scope-hook.mjs
// Scope-Forge brick (produce): the multi-file twin of runForgeHook. On a recovered-veto done in a SCOPE
// run, it sources the good (honest final) and bad (vetoed) commit SHAs, MATERIALIZES each into a held
// worktree (gitMaterialize — NOT gitVerifyAt, whose finally would remove the tree mid-await), RISK-ORDERS
// the changed files (rankChangedFiles) and learns a per-file check for the first --forge-max-files of them
// via the standard runForge (worktree roots as good/bad, kind:'scope'). admit (run.mjs) filters out any
// non-gamed (refactor-only) file for free; the cap is a coverage limiter, surfaced as coverageComplete/
// skippedFiles. Each learned check is a per-file behavioural check (--rel) — so it composes via the existing
// string gate. loop.mjs is untouched; this is the scope deps.runForgeHook.
//
// Frontier 2a (corroborate-on-scope): if --forge-oracle is set, independent operator oracles confirm the repo's
// good/bad labelling ONCE at the repo level before learning ANY per-file check. A STABLE oracle that disputes the
// framing declines the WHOLE fire (no per-file learning, and NO prune — auto-retirement also trusts goodArtifact,
// which is exactly what a dissent disputes). Empty oracleCmds => a $0 passthrough, so this is inert by default.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { shq } from '../shq.mjs'
import { parseScorerJson } from '../parse-scorer.mjs'
import { gitMaterialize, gitCleanup, gitDiffNames, gitHead, isSha } from '../git-snapshot.mjs'
import { admitCheck, scorerRunCheck } from './admit.mjs'
import { corroborateLabels } from './corroborate.mjs'
import { scopeGenerateCandidates } from './scope-generate.mjs'
import { pruneFlaky } from './prune.mjs'
import { loadStore, saveStore, addCheck } from './store.mjs'
import { runForge } from './run.mjs'
import { forgeAllowlist, forgeCatalog } from './hook.mjs'

const skip = (reason) => ({ admitted: [], rejected: [{ scorerId: '-', reason }], candidates: [], conflicts: [], excluded: [], corroborated: true, costUsd: 0, tokens: 0, skipped: true })

// Deterministic learn-order for a multi-file recovery diff: CODE files before non-code, then by path. When the
// cap truncates, the LEAST likely-gamed files (docs/config) drop first — never a code file while a doc remains.
// This only sets PRIORITY; it never excludes (every file within the cap is still learned), so it is safe in a
// way an extension PRE-filter (which could drop a gamed file) is not. Pure + stable.
const CODE_EXT = new Set(['.mjs', '.js', '.cjs', '.ts', '.jsx', '.tsx', '.mts', '.cts', '.py', '.go', '.rb', '.rs', '.java', '.php', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp'])
const isCode = (rel) => CODE_EXT.has(extname(rel))
export function rankChangedFiles(changed) {
  return [...changed].sort((a, b) => (isCode(b) - isCode(a)) || (a < b ? -1 : a > b ? 1 : 0))
}

// Scope oracle runner for 2a corroboration. UNLIKE admit.mjs's scorerRunCheck (which runs from the process cwd,
// fine for a single file passed via --output), a scope oracle is a REPO-level scorer — a project test/build cmd
// that may shell out, run a test runner, or read repo-relative paths — so it MUST run with cwd = the materialized
// worktree root, mirroring scope-context.mjs's runScopeScorer. Same {score} contract; score >= target => pass.
function scopeOracleRunCheck(cmd, artifact, { target = 100 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'scope-oracle-'))
  try {
    const full = `${cmd} --output ${shq(artifact)} --loop-dir ${shq(dir)} --pass 000`
    const res = spawnSync(full, { shell: true, cwd: artifact, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 5 * 60 * 1000, killSignal: 'SIGKILL' })
    if (res.status !== 0) throw new Error(`scope oracle exited ${res.status}: ${(res.stderr || '').slice(0, 300)}`)
    return { pass: parseScorerJson(res, full).score >= target }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function runScopeForgeHook({ cfg, state }, deps = {}) {
  const scopeDir = state.artifact_path
  const goodSha = deps.goodSha ?? (deps.gitHead ?? gitHead)(scopeDir) // honest final = current HEAD (last committed pass)
  const badSha = deps.badSha ?? state.history[state.confirm_vetoed_at_pass]?.snapshot
  // Trust boundary: a stored snapshot must be a real commit id before any worktree checkout on the repo.
  if (!isSha(goodSha) || !isSha(badSha)) return skip(`scope-forge: good/bad must be commit SHAs (good=${goodSha}, bad=${badSha})`)

  const changed = (deps.gitDiffNames ?? gitDiffNames)(scopeDir, badSha, goodSha)
  if (changed.length === 0) return skip('scope-forge: no changed files between good/bad')

  const log = deps.log ?? ((m) => process.stderr.write(m + '\n'))
  const allowlist = forgeAllowlist(cfg.scorerAllow)
  const materialize = deps.materialize ?? gitMaterialize
  const cleanup = deps.cleanup ?? gitCleanup
  const corroborate = deps.corroborate ?? ((a) => corroborateLabels({ ...a, runCheck: scopeOracleRunCheck }))
  const oracleCmds = cfg.forgeOracleCmds ?? []
  // let-declare so a second materialize that throws still cleans up the first worktree in finally.
  let wtGood, wtBad
  try {
    wtGood = materialize(scopeDir, goodSha)
    wtBad = materialize(scopeDir, badSha)

    // Frontier 2a (corroborate-on-scope): confirm the recovery's good/bad labelling ONCE at the repo level —
    // oracles run against the worktree ROOTS via scopeOracleRunCheck — BEFORE learning any per-file check. A
    // STABLE oracle that disputes the framing declines the WHOLE fire (every per-file admission would otherwise
    // inherit a suspect known-good/known-bad pair). We return BEFORE the per-file loop AND before prune — auto-
    // retirement also trusts goodArtifact, the exact label a dissent disputes. Empty oracleCmds => $0 passthrough.
    const corr = await corroborate({ goodArtifact: wtGood, badArtifact: wtBad, oracleCmds })
    if (!corr.corroborated) {
      // corroborated:false is the decline marker (distinct from skip()'s skipped:true, a pre-fire no-op). Same
      // key set as the success acc so consumers never see a missing field; coverageComplete:false here means
      // "learning never ran", not "the cap truncated".
      return { admitted: [], rejected: [], candidates: [], costUsd: 0, tokens: 0, conflicts: corr.conflicts, excluded: corr.excluded ?? [], corroborated: false, perFile: [], skippedFiles: [], coverageComplete: false }
    }

    // Risk-order the changed files (only now the veto framing is corroborated), learn for the first
    // --forge-max-files (default 8), and SURFACE the rest as a coverage gap (not a silent/cost-only drop): a gamed
    // file beyond the cap is never generated for, so admit — which only filters GENERATED candidates — cannot
    // rescue it. coverageComplete/skippedFiles say so honestly.
    const maxFiles = cfg.forgeMaxFiles ?? 8
    const ranked = rankChangedFiles(changed)
    const learnSet = ranked.slice(0, maxFiles)
    const skippedFiles = ranked.slice(maxFiles).map((rel, i) => ({ rel, reason: 'cap', rank: maxFiles + i }))
    if (skippedFiles.length) log(`scope-forge: coverage incomplete — ${skippedFiles.length} of ${ranked.length} changed file(s) beyond --forge-max-files=${maxFiles} not learned: ${skippedFiles.map((s) => s.rel).join(', ')}`)

    const admit = deps.admit ?? ((a) => admitCheck({ ...a, runCheck: scorerRunCheck }))
    // Aggregate the per-file runForge results into the back-compat shape (admitted/rejected/candidates concat,
    // cost/tokens summed) plus additive perFile/skippedFiles/coverageComplete. excluded = flaky oracles set aside
    // by corroboration (surfaced, non-blocking). A file whose runForge throws is isolated to a status:'error'
    // entry — the fire does not abort; the other files still learn.
    const acc = { admitted: [], rejected: [], candidates: [], costUsd: 0, tokens: 0, conflicts: [], excluded: corr.excluded ?? [], corroborated: true, perFile: [], skippedFiles, coverageComplete: skippedFiles.length === 0 }
    for (const rel of learnSet) {
      try {
        // To override generation per file in a test, inject deps.propose (it flows through scopeGenerateCandidates
        // with this iteration's `rel`). deps.generate is the whole-step escape hatch and is NOT per-file aware —
        // runForge calls it without `rel`, so an injected generate sees the same args every iteration.
        const generate = deps.generate ?? ((a) => scopeGenerateCandidates({ ...a, rel, allChanged: changed, model: cfg.model, propose: deps.propose }))
        const r = await (deps.runForge ?? runForge)({
          goal: state.goal, goodArtifact: wtGood, badArtifact: wtBad, critique: state.last_critique ?? '',
          scorerCatalog: forgeCatalog(allowlist), allowlist, storePath: cfg.forgeStorePath,
          generate, admit, loadStore, saveStore, addCheck, kind: 'scope',
        })
        acc.admitted.push(...r.admitted); acc.rejected.push(...r.rejected); acc.candidates.push(...(r.candidates ?? []))
        acc.costUsd += r.costUsd ?? 0; acc.tokens += r.tokens ?? 0
        acc.perFile.push({ rel, admitted: r.admitted.length, rejected: r.rejected.length, status: r.admitted.length ? 'admitted' : 'none' })
      } catch (e) {
        acc.perFile.push({ rel, admitted: 0, rejected: 0, status: 'error', error: String(e?.message ?? e) })
      }
    }
    // Auto-flaky retirement (scope kind): prune any active scope check now non-reproducible on the honest
    // worktree. Runs once after the loop, before the finally cleanup, while wtGood is still materialized.
    const pruned = await (deps.pruneFlaky ?? pruneFlaky)({ storePath: cfg.forgeStorePath, goodArtifact: wtGood, kind: 'scope', runCheck: scorerRunCheck })
    if (pruned.length) acc.retiredFlaky = pruned
    return acc
  } finally {
    if (wtGood) cleanup(scopeDir, wtGood)
    if (wtBad) cleanup(scopeDir, wtBad)
  }
}
