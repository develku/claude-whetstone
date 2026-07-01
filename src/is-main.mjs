// Robust "is this module the process entry point?" check.
//
// The naive idiom `import.meta.url === pathToFileURL(process.argv[1]).href` SILENTLY
// FAILS when the script is launched through a symlink — npm link, a plugin cache, or
// symlinked dotfiles (e.g. ~/.claude/plugins -> a git repo). Node realpath-resolves
// import.meta.url but leaves process.argv[1] as the *launch* path, so the two URLs
// diverge, the module concludes "I'm imported, not run", and its main block never runs:
// empty stdout, exit 0 (a silent no-op). Comparing process.argv[1]'s realpath too
// recovers the match. src/driver.mjs carries this same guard inline; this is the shared,
// tested form for every other entry file (scorers + CLIs).
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false
  if (importMetaUrl === pathToFileURL(argv1).href) return true
  try {
    return importMetaUrl === pathToFileURL(realpathSync(argv1)).href
  } catch {
    // argv1 does not resolve (deleted/renamed) — it is not this module.
    return false
  }
}
