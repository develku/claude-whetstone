// src/blast-radius.mjs
// Code-owned edit-boundary enforcement for the single-file loop (AUD-06). The editor prompt asks the model to
// "edit ONLY <artifact>" (act-claude.mjs), but that is advisory: a model that also writes a sibling file can
// launder the measured signal (io-* scorers can import repo siblings). Scope mode enforces this with git
// (scope-act.mjs enforceReadOnly); single-file mode has no git guarantee (the artifact's dir need not be a repo),
// so this module enforces it directly: snapshot the artifact's sibling files before the edit, revert any that
// changed after. The artifact ITSELF is never touched, so the loop's artifact-hash change-detection is unaffected.
//
// Bounded by design: content is copied for up to copyCap files (revertable); beyond that, up to walkCap files are
// hash-tracked (detect-only — changes are reported but NOT reverted); beyond walkCap the walk stops and reports
// `capped` (edits there are UNMONITORED — surfaced loudly, never silently swallowed). Symlinks are not followed.
import { readdirSync, lstatSync, readFileSync, writeFileSync, rmSync, mkdirSync, realpathSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { createHash } from 'node:crypto'

const MAX_COPY_BYTES = 16 * 1024 * 1024 // don't buffer a giant sibling — hash-only above this
const DEFAULT_EXCLUDE_DIRS = new Set(['node_modules'])
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// Walk dirname(artifact) recursively, collecting a hash (and, within copyCap, the content) of every regular
// sibling file. Excludes: the artifact itself, dot-entries (.git/.loop/.claude/.forge-mutant-*/.gate-audit-mutant-*),
// node_modules, symlinks. Returns { dir, files: Map<relpath,{hash, content|null}>, trackCap, capped }.
function walkSiblings(dir, { artifactReal, copyCap, walkCap }) {
  const files = new Map()
  let tracked = 0
  let capped = false
  const visit = (abs) => {
    if (capped) return
    let entries
    try { entries = readdirSync(abs, { withFileTypes: true }) } catch { return } // unreadable dir -> skip, don't throw out of act
    for (const ent of entries) {
      if (capped) return
      if (ent.name.startsWith('.') || DEFAULT_EXCLUDE_DIRS.has(ent.name)) continue
      const full = join(abs, ent.name)
      let st
      try { st = lstatSync(full) } catch { continue }
      if (st.isSymbolicLink()) continue // never follow a symlink (escape/cycle safety)
      if (st.isDirectory()) { visit(full); continue }
      if (!st.isFile()) continue
      let real
      try { real = realpathSync(full) } catch { real = full }
      if (real === artifactReal) continue // the artifact is not a sibling
      if (tracked >= walkCap) { capped = true; return }
      tracked++
      let content = null
      let hash
      try {
        const buf = readFileSync(full)
        hash = sha256(buf)
        if (files.size < copyCap && st.size <= MAX_COPY_BYTES) content = buf
      } catch { continue }
      files.set(relative(dir, full), { hash, content })
    }
  }
  visit(dir)
  return { dir, files, trackCap: walkCap, capped }
}

export function snapshotSiblings(artifactPath, { copyCap = 100, walkCap = 1000 } = {}) {
  const dir = dirname(artifactPath)
  let artifactReal
  try { artifactReal = realpathSync(artifactPath) } catch { artifactReal = artifactPath }
  const snap = walkSiblings(dir, { artifactReal, copyCap, walkCap })
  return { ...snap, artifactReal, copyCap, walkCap }
}

// Compare the current sibling tree against the snapshot; revert what we can, report what we can't.
export function settleSiblings(snap) {
  const reverted = []
  const detectedOnly = []
  const current = walkSiblings(snap.dir, { artifactReal: snap.artifactReal, copyCap: 0, walkCap: snap.walkCap })
  // modified or deleted siblings (present in the snapshot)
  for (const [rel, before] of snap.files) {
    const now = current.files.get(rel)
    const changed = !now || now.hash !== before.hash
    if (!changed) continue
    if (before.content != null) {
      // fail SOFT: if the editor deleted the parent dir, recreate it; a file we cannot restore is surfaced
      // loudly in detectedOnly, never a silent swallow that throws out of settle and masks the act's result.
      try { mkdirSync(dirname(join(snap.dir, rel)), { recursive: true }); writeFileSync(join(snap.dir, rel), before.content); reverted.push(rel) }
      catch { detectedOnly.push(rel) }
    }
    else detectedOnly.push(rel) // over copy cap -> we saw it change but cannot restore it
  }
  // added siblings (absent from the snapshot) -> delete, but ONLY when both walks provably saw the whole tree.
  // If either walk capped, "absent from snap.files" no longer proves "added": the settle window may have slid
  // onto pre-existing files beyond the snapshot's cap — deleting those would destroy data the guard never saw.
  const canDelete = !snap.capped && !current.capped
  for (const rel of current.files.keys()) {
    if (!snap.files.has(rel)) {
      if (!canDelete) { detectedOnly.push(rel); continue } // capped -> detect-only, never rmSync
      try { rmSync(join(snap.dir, rel), { force: true }); reverted.push(rel) } catch { detectedOnly.push(rel) }
    }
  }
  return { violated: reverted.length > 0 || detectedOnly.length > 0, reverted, detectedOnly, capped: current.capped }
}

// Wrap an act so any sibling edit it makes is reverted (revert runs even if act throws — containment on error
// paths too). warn(msg) surfaces per-pass; record(entry) collects for the driver's final state stamp.
export function withBlastRadius(act, { artifactPath, warn = () => {}, record = () => {}, copyCap, walkCap } = {}) {
  return async (state) => {
    const snap = snapshotSiblings(artifactPath, { copyCap, walkCap })
    try {
      return await act(state)
    } finally {
      const settled = settleSiblings(snap)
      const capped = snap.capped || settled.capped // either walk capping means edits beyond are unmonitored
      if (settled.violated || capped) {
        record({ pass: state?.pass ?? null, reverted: settled.reverted, detectedOnly: settled.detectedOnly, capped })
        if (settled.reverted.length) warn(`blast-radius: reverted ${settled.reverted.length} out-of-bounds sibling edit(s): ${settled.reverted.slice(0, 5).join(', ')}${settled.reverted.length > 5 ? ' …' : ''}`)
        if (settled.detectedOnly.length) warn(`blast-radius: ${settled.detectedOnly.length} sibling(s) changed but NOT reverted (over copy budget or beyond monitoring cap): ${settled.detectedOnly.slice(0, 5).join(', ')}`)
        if (capped) warn(`blast-radius: sibling monitoring capped at ${snap.walkCap} files — edits beyond are UNMONITORED`)
      }
    }
  }
}
