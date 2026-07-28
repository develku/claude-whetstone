// The CODE-OWNED guards for the scope (repo/dir) loop, extracted from scope-act.mjs. These two are the
// model-independent controls the gate's integrity rests on — RISK #1's read-only enforcement is what makes a
// gate-tampering edit a no-op rather than a moat breach — so they live apart from the prompt/spawn code they
// guard, which changes shape whenever the editor prompt is tuned. Same split rationale as gate.mjs vs loop.mjs:
// the part that must not silently drift is kept small, pure of the editor, and separately pinnable.
import { execFileSync } from 'node:child_process'

const git = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()

// Changed-detection for a multi-file scope: any uncommitted change in the tree. Replaces the
// single-file sha256 before/after — the editor may touch N files, so we ask git what moved.
export function scopeChanged(scopeDir) {
  return git(scopeDir, ['status', '--porcelain']).length > 0
}

// RISK #1 (highest severity) — the editor must NOT edit the gate it is scored by. After the editor
// runs, hard-revert any change to a read-only path (tests / scorer config), whether a tracked edit or
// a newly-added file. This is CODE-OWNED enforcement, not the prompt: the fence in buildScopePrompt is
// advisory; THIS is the control that makes a gate-tampering edit a no-op instead of a moat breach.
export function enforceReadOnly(scopeDir, readOnly = []) {
  if (!readOnly.length) return { violated: false, reverted: [] }
  const status = git(scopeDir, ['status', '--porcelain', '--', ...readOnly])
  const reverted = status.split('\n').filter(Boolean).map((l) => l.slice(3).trim())
  if (!reverted.length) return { violated: false, reverted: [] }
  for (const p of readOnly) {
    try { git(scopeDir, ['checkout', 'HEAD', '--', p]) } catch { /* path may have only untracked additions */ }
  }
  git(scopeDir, ['clean', '-fdq', '--', ...readOnly]) // remove newly-added files under the read-only paths
  return { violated: true, reverted }
}
