// The fence-safe discard-memory (v1.8.0): a code-owned registry of scorer-authored finding-areas so
// the editor stops re-attacking strategy classes that never moved the score — the bounded semantic
// complement to the numbers-only ledger (ledger.mjs), which can say "REGRESSED, try something else"
// but not WHICH somethings already failed.
//
// Trust contract: CODE decides which areas qualify (pure number comparisons below); the area STRINGS
// are scorer-authored — a model-backed scorer writes them from artifact content the editor influences,
// an indirect capture channel — so they must NEVER be interpolated into the trusted prompt region, even
// sanitized. renderTriedAreas output is carried ONLY inside a nonce fence (see act-claude/scope-act).
// Storage is state.json's `area_ledger` (code is the only writer; kept across --resume — it is exactly
// the memory that stops a resumed editor from re-attacking dead areas). Within-run only; a cross-run
// registry is a separate, deliberate decision.

// Dedupe key — SAME coercion as decompose.mjs's finding key, so the two findings consumers cannot drift.
const areaKey = (f) => String(f?.area ?? '')

const finiteOrNull = (n) => (Number.isFinite(n) ? n : null)

// Fold one pass's findings into the registry. Immutable: returns a new array; entries are
// { area, first_pass, last_pass, seen_count, best_at_first }. best_at_first is the best score INCLUDING
// the sighting pass (persist updates after recordPass) — the bar later gain is measured against.
export function updateAreaRegistry(registry, findings, { pass, best_score } = {}) {
  const reg = Array.isArray(registry) ? registry : []
  const found = Array.isArray(findings) ? findings : []
  const p = finiteOrNull(pass)
  const best = finiteOrNull(best_score)
  const seenThisCall = new Set() // duplicates within ONE review count once
  let out = reg
  for (const f of found) {
    const key = areaKey(f)
    if (!key || seenThisCall.has(key)) continue
    seenThisCall.add(key)
    const i = out.findIndex((e) => e.area === key)
    out =
      i >= 0
        ? out.map((e, j) =>
            j === i
              ? { ...e, seen_count: (Number.isFinite(e.seen_count) ? e.seen_count : 1) + 1, last_pass: p ?? e.last_pass }
              : e,
          )
        : [...out, { area: key, first_pass: p, last_pass: p, seen_count: 1, best_at_first: best }]
  }
  return out === reg ? [...reg] : out
}

// The areas worth telling the editor about: attacked >= 2 times AND the best score never moved past
// where it stood at first sighting (all-numbers rule — a steering heuristic, not a gate). Most recently
// re-attacked first, capped so the prompt cannot bloat.
export function qualifyStale(registry, best_score, { cap = 8 } = {}) {
  const best = finiteOrNull(best_score)
  if (best == null) return []
  return (Array.isArray(registry) ? registry : [])
    .filter(
      (e) =>
        e?.area &&
        (Number.isFinite(e.seen_count) ? e.seen_count : 0) >= 2 &&
        Number.isFinite(e.best_at_first) &&
        best <= e.best_at_first,
    )
    .sort((a, b) => (finiteOrNull(b.last_pass) ?? -1) - (finiteOrNull(a.last_pass) ?? -1))
    .slice(0, cap)
    .map((e) => ({ area: e.area, seen_count: e.seen_count, first_pass: e.first_pass }))
}

// Render the fence PAYLOAD (one line per area). Clip at RENDER only — the stored value stays verbatim
// for audit. null when there is nothing to say, so callers emit no fence block at all (zero prompt tax).
export function renderTriedAreas(qualified) {
  if (!Array.isArray(qualified) || !qualified.length) return null
  const clip = (s) => {
    const flat = String(s).replace(/\s+/g, ' ').trim()
    return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat
  }
  const lines = qualified
    .map((q) => ({ area: clip(q.area), q }))
    .filter(({ area }) => area)
    .map(({ area, q }) => `- ${area} — attacked ${q.seen_count}x since pass ${Number.isFinite(q.first_pass) ? q.first_pass : '?'}, best score unchanged`)
  return lines.length ? lines.join('\n') : null
}

// The one helper both persists (driver.mjs and scope-context.mjs) call after recordPass: thread the
// pass's review findings into the state the caller is about to save.
export function withAreaLedger(prev, next, review) {
  return {
    ...next,
    area_ledger: updateAreaRegistry(prev?.area_ledger ?? [], Array.isArray(review?.findings) ? review.findings : [], {
      pass: next.pass,
      best_score: next.best_score,
    }),
  }
}
