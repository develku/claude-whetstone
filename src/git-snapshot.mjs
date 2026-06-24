// Git-backed keep-best for the scope (repo/dir) loop — the multi-file replacement for state.mjs's
// single-file copy snapshot/restore. Each pass is a commit on the orchestrator's OWN branch, so the
// commit SHA doubles as state.history[].snapshot AND gives a self-commit + audit trail for free.
// execFileSync throws on a non-zero git exit, so failures propagate (no silent corruption).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const git = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()

// Snapshot the current scope state; return the commit SHA used verbatim as history[].snapshot.
export function gitSnapshot(scopeDir, label) {
  git(scopeDir, ['add', '-A'])
  git(scopeDir, ['commit', '--quiet', '--allow-empty', '-m', `whetstone: ${label}`])
  return git(scopeDir, ['rev-parse', 'HEAD'])
}

// keep-best rollback: make the working tree EXACTLY match a prior snapshot — reverting edits and
// removing files a regressing pass added. reset --hard moves the branch to the snapshot (discarding
// worse later commits, which is the point); clean -fdq sweeps any leftover untracked files.
// SAFE only on the orchestrator's own branch / a clean tree it created (enforced by the CLI guard).
export function gitRestore(scopeDir, sha) {
  git(scopeDir, ['reset', '--hard', sha])
  git(scopeDir, ['clean', '-fdq'])
}

// The Forge graft (v1): run `fn` against a PRISTINE checkout of `ref` in a throwaway worktree, isolated
// from the live (possibly dirty) working tree. Used for the done-edge confirm — the held-out gate is
// scored on exactly the COMMITTED state, never the editor's uncommitted leftovers, so a pass can't game
// the finish with stray working-tree state. The worktree is always removed.
export function gitVerifyAt(scopeDir, ref, fn) {
  const wt = mkdtempSync(join(tmpdir(), 'whet-verify-'))
  try {
    git(scopeDir, ['worktree', 'add', '--detach', '-q', wt, ref])
    return fn(wt)
  } finally {
    try { git(scopeDir, ['worktree', 'remove', '--force', wt]) } catch { /* fall through to rm */ }
    rmSync(wt, { recursive: true, force: true })
  }
}

// The current HEAD sha — the snapshot/restore anchor a fan-out captures before running children.
export function gitHead(dir) {
  return git(dir, ['rev-parse', 'HEAD'])
}

// True iff the tree CONTENT differs between fromSha and HEAD. Children commit --allow-empty baselines
// so HEAD always moves; the fan-out's "changed" signal must compare trees, not commit ids, so an
// all-empty-commit fan-out reads as an honest no-op. `git diff --quiet` exits 1 when a diff exists.
export function gitTreeChanged(dir, fromSha) {
  try {
    execFileSync('git', ['diff', '--quiet', fromSha, 'HEAD'], { cwd: dir })
    return false
  } catch {
    return true
  }
}
