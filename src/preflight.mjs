// Cross-repo permission-surface preflight (F2, dogfood ledger docs/quality-loop/dogfood-tracegram.md).
// whetstone spawns `claude -p --permission-mode acceptEdits` in the ARTIFACT's own directory, so the editor
// inherits THAT project's .claude/settings*.json. When the target is a DIFFERENT repo than the driver's cwd
// (the cross-repo dogfood case — hit in BOTH external runs), a broad permission surface there silently
// widens what the editor may do. The maintainer used to eyeball this by hand (whet.md SAFETY); this
// automates it as a NON-FATAL warning. Pure + testable: the fs read is injectable so tests need no files.
import { readFileSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'

const isInside = (dir, base) => {
  const d = resolve(dir); const b = resolve(base)
  return d === b || d.startsWith(b + sep)
}

// Parse a settings file; null on absent/unparseable — a missing or broken settings file is not this
// check's concern (it looks only for an explicitly BROAD surface, never infers risk from absence).
function readSettings(path, read) {
  try { return JSON.parse(read(path, 'utf8')) } catch { return null }
}

// A one-line warning when `targetDir` is OUTSIDE cwd AND carries a broad Claude permission surface, else null.
// Broad = a non-empty permissions.allow, or a bypass-by-default mode (defaultMode:'bypassPermissions' /
// dangerouslySkipPermissions). Same-repo targets return null: that is the operator's own surface, not a
// cross-repo surprise. Checks both settings.json and settings.local.json.
export function crossRepoPermissionWarning({ targetDir, cwd = process.cwd(), read = readFileSync } = {}) {
  if (!targetDir || isInside(targetDir, cwd)) return null
  const findings = []
  for (const name of ['settings.json', 'settings.local.json']) {
    const s = readSettings(join(targetDir, '.claude', name), read)
    if (!s) continue
    const allow = s?.permissions?.allow
    if (Array.isArray(allow) && allow.length) findings.push(`${name}: permissions.allow has ${allow.length} rule(s)`)
    if (s?.permissions?.defaultMode === 'bypassPermissions' || s?.dangerouslySkipPermissions === true) {
      findings.push(`${name}: permissions are bypassed by default`)
    }
  }
  if (!findings.length) return null
  return `⚠ cross-repo target ${targetDir} has a broad Claude permission surface (${findings.join('; ')}). The editor runs there with --permission-mode acceptEdits and inherits it — review that repo's .claude/settings before an unattended run.`
}
