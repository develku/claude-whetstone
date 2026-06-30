// bench/swe-evo/seal.mjs
// Seal a materialized editor checkout: collapse the repo to a single seed commit so the editor cannot mine
// the upstream fix out of .git history. Cursor's sealed-harness study measured this leak directly — 9% of
// Opus 4.8 resolutions on an UNSEALED harness came from the bundled git history (and 57% more from the web;
// the test run already pins `--network none`). Removing the history converts a possibly-contaminated public
// instance into one where the only path to the oracle is DERIVING the patch — manufacturing gaming pressure
// at the harness level so the soft fix-rate stays an honest metric.
//
// The working TREE is untouched (only the commit graph + remotes + reflog are wiped via a clean re-init), so:
//   - the editor still starts from the exact base_commit content, and
//   - a diff against the returned seed SHA equals a diff against the original base_commit (identical tree),
//     so the captured patch applies cleanly in the ephemeral grading container, which keeps the real
//     base_commit and resets to it (its own .git is separate and stays intact).
// Returns the new seed commit SHA — the host-side EDITOR base to thread through reset/diff (editorBase).
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

// A throwaway identity for the single seal commit — passed inline (-c) so nothing is written to git config.
const IDENT = ['-c', 'user.email=seal@whetstone.local', '-c', 'user.name=whetstone-seal']

function git(dir, args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`seal: git ${args.join(' ')} failed (exit ${res.status}): ${(res.stderr || '').trim()}`)
  return (res.stdout || '').trim()
}

export function sealCheckout(dir) {
  // `rm -rf .git` is the only one-step way to drop ALL of: packed/loose history, every branch/tag, the
  // reflog, and remotes. A `git checkout --orphan` would leave packed objects + remotes still mineable.
  rmSync(join(dir, '.git'), { recursive: true, force: true })
  git(dir, ['init', '-q'])
  git(dir, ['add', '-A'])
  git(dir, [...IDENT, 'commit', '-q', '--no-verify', '-m', 'sealed base (whetstone): upstream history removed'])
  return git(dir, ['rev-parse', 'HEAD'])
}
