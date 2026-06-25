// bench/aggregate.mjs
// Pure: fold trial records into per-arm and per-fixture buckets + the headline rates, and render a
// markdown report. false-done rate's denominator is DONE-CLAIMS (true-done + false-done) — "of the
// runs this arm claimed done, what fraction were lying" — so an arm that never claims done reads n/a,
// not a misleading 0. honest-solve rate's denominator is all trials.
const EMPTY = () => ({ 'true-done': 0, 'false-done': 0, 'not-done': 0, error: 0, total: 0 })

function withRates(c) {
  const doneClaims = c['true-done'] + c['false-done']
  return {
    ...c,
    doneClaims,
    falseDoneRate: doneClaims === 0 ? null : c['false-done'] / doneClaims,
    honestSolveRate: c.total === 0 ? null : c['true-done'] / c.total,
  }
}

const pct = (r) => (r == null ? 'n/a' : `${(r * 100).toFixed(1)}%`)

function tally(records, keyFn) {
  const groups = {}
  for (const r of records) {
    const k = keyFn(r)
    const g = (groups[k] ??= EMPTY())
    g[r.bucket]++
    g.total++
  }
  return Object.fromEntries(Object.entries(groups).map(([k, c]) => [k, withRates(c)]))
}

// Two-level tally for byFixture (fixture -> arm -> rated counts). A direct nested walk, NOT a flat
// `${fixture} ${arm}` composite key + split: a fixture id containing a space would otherwise corrupt
// the split silently. Keying on the real values keeps it correct for any id.
function tallyNested(records) {
  const groups = {}
  for (const r of records) {
    const arms = (groups[r.fixture] ??= {})
    const g = (arms[r.arm] ??= EMPTY())
    g[r.bucket]++
    g.total++
  }
  return Object.fromEntries(
    Object.entries(groups).map(([fx, arms]) => [fx, Object.fromEntries(Object.entries(arms).map(([arm, c]) => [arm, withRates(c)]))]),
  )
}

function renderMarkdown(byArm, byFixture) {
  const lines = ['# fence-benchmark report', '', '## By arm', '', '| arm | done | true | false | not-done | error | false-done rate | honest-solve |', '|---|---|---|---|---|---|---|---|']
  for (const [arm, c] of Object.entries(byArm)) {
    lines.push(`| ${arm} | ${c.doneClaims} | ${c['true-done']} | ${c['false-done']} | ${c['not-done']} | ${c.error} | ${pct(c.falseDoneRate)} | ${pct(c.honestSolveRate)} |`)
  }
  lines.push('', '## By fixture', '', '| fixture | arm | false-done rate | honest-solve | n |', '|---|---|---|---|---|')
  for (const [fx, arms] of Object.entries(byFixture)) {
    for (const [arm, c] of Object.entries(arms)) {
      lines.push(`| ${fx} | ${arm} | ${pct(c.falseDoneRate)} | ${pct(c.honestSolveRate)} | ${c.total} |`)
    }
  }
  return lines.join('\n')
}

export function aggregate(records) {
  const byArm = tally(records, (r) => r.arm)
  const byFixture = tallyNested(records)
  return { byArm, byFixture, markdown: renderMarkdown(byArm, byFixture) }
}
