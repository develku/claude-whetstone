// Track A's coverage heuristic (spec §6) — surface SPAN only, REPORT-ONLY. coverage_score is the fraction
// of the editable surface covered by the SET-UNION of objective editScopes. Set-union over files so an
// overlapping leaf adds ZERO (leaf-multiplication-resistant). It is NEVER a gate: globalVerdict never reads
// it, objectives_sufficiency stays 'unproven'. The scorer-strength proxy is DELIBERATELY DROPPED — the
// safety-capture refuter proved "reward io-*" INVERTS (a tautological io-* --case pair scores HIGH), so
// coverage is spatial span, never semantic fitness (the headline §11.2 residual).
//
// Pure: coverageScore/coverageDetail take the already-computed editableSurface (git ls-files minus
// globalReadOnly minus test dirs) as input; the I/O surface computation lives in the orchestration layer.
import { canonRel } from './converge-shared.mjs'

// A file is covered by an editScope iff the scope equals or is an ancestor directory of the file.
const covers = (scope, file) => {
  const s = canonRel(scope)
  const f = canonRel(file)
  return s === '' || s === f || f.startsWith(s + '/')
}

// coverageDetail(manifest, editableSurface) -> { score, surfaceSize, coveredSize, coveredFiles }. The
// denominator (surfaceSize) is part of the report so a shrunk surface that inflates the score is visible.
export function coverageDetail(manifest, editableSurface) {
  const surface = [...new Set((editableSurface ?? []).map(canonRel))].filter(Boolean)
  const scopes = (manifest?.objectives ?? []).map((o) => o.editScope).filter((s) => typeof s === 'string')
  const coveredFiles = surface.filter((f) => scopes.some((s) => covers(s, f)))
  const score = surface.length === 0 ? 0 : Math.round((coveredFiles.length / surface.length) * 100)
  return { score, surfaceSize: surface.length, coveredSize: coveredFiles.length, coveredFiles }
}

// coverageScore(manifest, editableSurface) -> 0..100 (a plain number — never a verdict).
export const coverageScore = (manifest, editableSurface) => coverageDetail(manifest, editableSurface).score

// The loud GATE-DID-NOT-PROVE residuals (spec §11) — printed prominently in plan-report.json + stdout.
export const PLAN_DISCLOSURES = [
  "objectives_sufficiency: 'unproven' — the objective SET is auto-generated, NOT proven sufficient for the goal. Hard-coded; no code path flips it.",
  'GATE-DID-NOT-PROVE (HEADLINE): scorer-to-region misassignment and self-authored tautological/trivial test cases are NOT caught — they pass every structural guard AND convergeRefusal. coverage_score is spatial SPAN, never semantic fitness. The model authoring io-* cases + pairing a scorer with a region is the ONE trust boundary Track A widens beyond Track C; the real fix is a held-out per-region SEMANTIC confirm (frontier, deferred).',
  'coverage_score is a STRUCTURAL PROXY — span over the editable surface, not a coverage proof. A shrunk denominator or a barbell decomposition can inflate it (the surface size is disclosed alongside so the denominator is auditable).',
  "Scorer-menu + arg adequacy is the OPERATOR's contract — the planner selects from your --scorer-allow allowlist; a weak menu yields weak objectives. --pin-scorers (operator fixedArgs) is the lever to remove the model's arg freedom (deferred).",
  'Deterministic scorers reading repo-controlled fixtures remain an indirect-capture surface (Track C disclosure, ×N objectives).',
]
