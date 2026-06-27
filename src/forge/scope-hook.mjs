// src/forge/scope-hook.mjs
// Scope-Forge brick (produce): the multi-file twin of runForgeHook. On a recovered-veto done in a SCOPE
// run, it sources the good (honest final) and bad (vetoed) commit SHAs, MATERIALIZES each into a held
// worktree (gitMaterialize — NOT gitVerifyAt, whose finally would remove the tree mid-await), RISK-ORDERS
// the changed files (rankChangedFiles) and learns a per-file check for the first --forge-max-files of them
// via the standard runForge (worktree roots as good/bad, kind:'scope'). admit (run.mjs) filters out any
// non-gamed (refactor-only) file for free; the cap is a coverage limiter, surfaced as coverageComplete/
// skippedFiles. Each learned check is a per-file behavioural check (--rel) — so it composes via the existing
// string gate. loop.mjs is untouched; this is the scope deps.runForgeHook.
import { extname } from 'node:path'
import { gitMaterialize, gitCleanup, gitDiffNames, gitHead, isSha } from '../git-snapshot.mjs'
import { admitCheck, scorerRunCheck } from './admit.mjs'
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

export async function runScopeForgeHook({ cfg, state }, deps = {}) {
  const scopeDir = state.artifact_path
  const goodSha = deps.goodSha ?? (deps.gitHead ?? gitHead)(scopeDir) // honest final = current HEAD (last committed pass)
  const badSha = deps.badSha ?? state.history[state.confirm_vetoed_at_pass]?.snapshot
  // Trust boundary: a stored snapshot must be a real commit id before any worktree checkout on the repo.
  if (!isSha(goodSha) || !isSha(badSha)) return skip(`scope-forge: good/bad must be commit SHAs (good=${goodSha}, bad=${badSha})`)

  const changed = (deps.gitDiffNames ?? gitDiffNames)(scopeDir, badSha, goodSha)
  if (changed.length === 0) return skip('scope-forge: no changed files between good/bad')

  // Risk-order the changed files, learn for the first --forge-max-files (default 8), and SURFACE the rest as a
  // coverage gap (not a silent/cost-only drop): a gamed file beyond the cap is never generated for, so admit —
  // which only filters GENERATED candidates — cannot rescue it. coverageComplete/skippedFiles say so honestly.
  const log = deps.log ?? ((m) => process.stderr.write(m + '\n'))
  const maxFiles = cfg.forgeMaxFiles ?? 8
  const ranked = rankChangedFiles(changed)
  const learnSet = ranked.slice(0, maxFiles)
  const skippedFiles = ranked.slice(maxFiles).map((rel, i) => ({ rel, reason: 'cap', rank: maxFiles + i }))
  if (skippedFiles.length) log(`scope-forge: coverage incomplete — ${skippedFiles.length} of ${ranked.length} changed file(s) beyond --forge-max-files=${maxFiles} not learned: ${skippedFiles.map((s) => s.rel).join(', ')}`)

  const allowlist = forgeAllowlist(cfg.scorerAllow)
  const materialize = deps.materialize ?? gitMaterialize
  const cleanup = deps.cleanup ?? gitCleanup
  const wtGood = materialize(scopeDir, goodSha)
  const wtBad = materialize(scopeDir, badSha)
  try {
    const admit = deps.admit ?? ((a) => admitCheck({ ...a, runCheck: scorerRunCheck }))
    // Aggregate the per-file runForge results into the back-compat shape (admitted/rejected/candidates concat,
    // cost/tokens summed) plus additive perFile/skippedFiles/coverageComplete. A file whose runForge throws is
    // isolated to a status:'error' entry — the fire does not abort; the other files still learn.
    const acc = { admitted: [], rejected: [], candidates: [], costUsd: 0, tokens: 0, conflicts: [], excluded: [], corroborated: true, perFile: [], skippedFiles, coverageComplete: skippedFiles.length === 0 }
    for (const rel of learnSet) {
      try {
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
    cleanup(scopeDir, wtGood)
    cleanup(scopeDir, wtBad)
  }
}
