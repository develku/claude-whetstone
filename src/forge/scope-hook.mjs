// src/forge/scope-hook.mjs
// Scope-Forge brick (produce): the multi-file twin of runForgeHook. On a recovered-veto done in a SCOPE
// run, it sources the good (honest final) and bad (vetoed) commit SHAs, MATERIALIZES each into a held
// worktree (gitMaterialize — NOT gitVerifyAt, whose finally would remove the tree mid-await), finds the one
// changed file, and runs the standard runForge with the worktree roots as good/bad artifacts and kind:'scope'.
// Each learned check is a per-file behavioural check (--rel) — so it composes via the existing string gate.
// loop.mjs is untouched; this is the scope deps.runForgeHook.
import { gitMaterialize, gitCleanup, gitDiffNames, gitHead, isSha } from '../git-snapshot.mjs'
import { admitCheck, scorerRunCheck } from './admit.mjs'
import { scopeGenerateCandidates } from './scope-generate.mjs'
import { loadStore, saveStore, addCheck } from './store.mjs'
import { runForge } from './run.mjs'
import { forgeAllowlist, forgeCatalog } from './hook.mjs'

const skip = (reason) => ({ admitted: [], rejected: [{ scorerId: '-', reason }], candidates: [], conflicts: [], excluded: [], corroborated: true, costUsd: 0, tokens: 0, skipped: true })

export async function runScopeForgeHook({ cfg, state }, deps = {}) {
  const scopeDir = state.artifact_path
  const goodSha = deps.goodSha ?? (deps.gitHead ?? gitHead)(scopeDir) // honest final = current HEAD (last committed pass)
  const badSha = deps.badSha ?? state.history[state.confirm_vetoed_at_pass]?.snapshot
  // Trust boundary: a stored snapshot must be a real commit id before any worktree checkout on the repo.
  if (!isSha(goodSha) || !isSha(badSha)) return skip(`scope-forge: good/bad must be commit SHAs (good=${goodSha}, bad=${badSha})`)

  const changed = (deps.gitDiffNames ?? gitDiffNames)(scopeDir, badSha, goodSha)
  if (changed.length !== 1) return skip(`scope-forge MVP learns only when exactly 1 file changed (got ${changed.length})`)
  const rel = changed[0]

  const allowlist = forgeAllowlist(cfg.scorerAllow)
  const materialize = deps.materialize ?? gitMaterialize
  const cleanup = deps.cleanup ?? gitCleanup
  const wtGood = materialize(scopeDir, goodSha)
  const wtBad = materialize(scopeDir, badSha)
  try {
    const generate = deps.generate ?? ((a) => scopeGenerateCandidates({ ...a, rel, model: cfg.model, propose: deps.propose }))
    const admit = deps.admit ?? ((a) => admitCheck({ ...a, runCheck: scorerRunCheck }))
    return await (deps.runForge ?? runForge)({
      goal: state.goal,
      goodArtifact: wtGood,
      badArtifact: wtBad,
      critique: state.last_critique ?? '',
      scorerCatalog: forgeCatalog(allowlist),
      allowlist,
      storePath: cfg.forgeStorePath,
      generate,
      admit,
      loadStore,
      saveStore,
      addCheck,
      kind: 'scope',
    })
  } finally {
    cleanup(scopeDir, wtGood)
    cleanup(scopeDir, wtBad)
  }
}
