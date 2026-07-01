// bench/swe-evo/split.mjs
// V/C/T behaviour-cluster split for the SWE-EVO benchmark adapter (H1). See
// docs/design/specs/2026-06-28-h1-benchmark-adapter-design.md §3.
//
// SWE-EVO holds its grading tests out from the agent, so whetstone's loop needs a MANUFACTURED
// in-loop scorer. We leak a subset of FAIL_TO_PASS as the visible scorer (V) and hold the rest out
// as a confirm set (C, the gated arm's finish-line check) and a truth set (T, held out from EVERY
// arm and used only for the final grade — this is what makes the gated-vs-baseline Δ identifiable;
// Codex review (REVISE)).
//
// We cluster at FILE level (pytest node id -> file). Whole files go to V/C/T so the C/T test bodies
// can be PHYSICALLY removed from the editor's tree (read-only stops *weakening* a test, not *reading*
// its assertions — codex). Tasks with < 3 FAIL_TO_PASS files cannot form V/C/T and are excluded.
//
// File-level lexicographic assignment is a v1 heuristic for "different behaviours in V vs T"; the
// veto-opportunity audit (spec §5) empirically validates it — if V trivially predicts T, P(T fail |
// V pass) ≈ 0 and the audit tells us to re-cluster before spending.

export function fileOfNode(nodeId) {
  return String(nodeId).split('::')[0] // pytest node id: "path/file.py::Class::test[param]" -> file
}

const EMPTY = () => ({ files: [], nodes: [] })

export function planSplit({ failToPass = [], passToPass = [] } = {}) {
  const byFile = new Map()
  for (const n of failToPass) {
    const f = fileOfNode(n)
    if (!byFile.has(f)) byFile.set(f, [])
    byFile.get(f).push(n)
  }
  const files = [...byFile.keys()].sort()
  const pass = [...passToPass]

  if (files.length < 3) {
    return { excluded: true, reason: `only ${files.length} FAIL_TO_PASS file cluster(s); need >= 3 for a V/C/T split`, V: EMPTY(), C: EMPTY(), T: EMPTY(), passToPass: pass }
  }

  const n = files.length
  const tCount = Math.max(1, Math.floor(n * 0.25))
  const cCount = Math.max(1, Math.floor(n * 0.25))
  const vCount = n - tCount - cCount // >= 1 for all n >= 3

  const vFiles = files.slice(0, vCount)
  const cFiles = files.slice(vCount, vCount + cCount)
  const tFiles = files.slice(vCount + cCount)
  const bucket = (fs) => ({ files: fs, nodes: fs.flatMap((f) => byFile.get(f)) })

  return { excluded: false, V: bucket(vFiles), C: bucket(cFiles), T: bucket(tFiles), passToPass: pass }
}
