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

// The NESTED-CONFIG hazard, and the twin of the check below: that one asks whether the target's OWN
// .claude grants too much, this one asks whether the target sits INSIDE somebody's .claude at all.
// Claude Code merges every .claude config it finds walking UP from cwd, and the editor's cwd IS the
// artifact's directory — so an artifact inside a live config tree inherits that tree's whole hook stack.
// The editor then spends its turn on hook ceremony and edits nothing. Measured on the maintainer's
// machine: ~USD 2.08 / 1.04M tokens for ZERO edits, ending in ERROR. Deliberately a PURE path check with
// no fs and no cwd comparison: the burn happened with the target inside cwd (where crossRepoPermission-
// Warning returns null by design) and with permissions that were never too broad. Returns null or a
// one-line warning naming the offending tree.
export function nestedClaudeConfigWarning({ targetDir } = {}) {
  if (!targetDir) return null
  const parts = resolve(targetDir).split(sep)
  const at = parts.indexOf('.claude') // outermost wins — that is the first tree the walk-up reaches
  if (at === -1) return null
  const tree = parts.slice(0, at + 1).join(sep)
  return `⚠ nested config: ${resolve(targetDir)} sits inside the live Claude config tree ${tree}. The editor runs with cwd there and inherits that tree's whole hook stack — measured ~USD 2.08 / 1.04M tokens of hook ceremony for ZERO edits. Copy the artifact to a scratch dir outside every .claude ancestor, loop there, then diff back.`
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
