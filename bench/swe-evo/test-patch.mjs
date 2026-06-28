// bench/swe-evo/test-patch.mjs
// Unified-diff splitter for SWE-EVO's gold `test_patch`. Used for SOURCE ISOLATION (codex REVISE):
// the adapter applies ONLY the V test files' hunks to the editor's tree, so the C/T held-out test
// bodies are physically absent (read-only stops *weakening* a test, not *reading* its assertions).
// Pure string logic, no fs.

function destPath(plusLine) {
  let p = plusLine.slice(4).trim().split('\t')[0] // drop "+++ " and any trailing tab metadata
  if (p === '/dev/null') return null // deletion — no destination file
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2)
  return p
}

// Split a unified diff into per-file sections, each tagged with its destination file.
export function parseSections(diff) {
  const sections = []
  let cur = null
  for (const line of String(diff).split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (cur) sections.push(cur)
      cur = { file: null, lines: [line] }
    } else if (cur) {
      cur.lines.push(line)
      if (cur.file == null && line.startsWith('+++ ')) cur.file = destPath(line)
    }
  }
  if (cur) sections.push(cur)
  return sections
}

export function filesInPatch(diff) {
  return parseSections(diff).map((s) => s.file).filter(Boolean)
}

// Return a sub-diff containing only the hunks for `files` (the V set). Unknown files are ignored.
export function selectPatchForFiles(diff, files) {
  const want = new Set(files)
  const kept = parseSections(diff).filter((s) => s.file && want.has(s.file))
  return kept.length ? kept.map((s) => s.lines.join('\n')).join('\n') + '\n' : ''
}
