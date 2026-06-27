// src/forge/mutate.mjs
// Pure textual mutant generator for mutation-backed admit (src/forge/mutation-admit.mjs). Given a GOOD source
// string, produce a bounded NEIGHBOURHOOD of small single-point deviations (return-constant, arithmetic-swap,
// comparison-flip, boolean-flip, increment-tweak). Deliberately crude — robustness is NOT this layer's job:
// downstream, a non-parsing mutant makes the trusted oracle ERROR (excluded) and an equivalent mutant makes
// the oracle ACCEPT it (excluded). Only oracle-confirmed-bad mutants become required-kills. So a simple,
// dependency-free, language-agnostic-ish (JS/TS-tuned) regex mutator is the right altitude. Pure given source.

// Emit one mutant per match site: replace EXACTLY that occurrence, leaving the rest of the source untouched.
// toReplacement(match) -> a replacement string, an array of them (e.g. several constants), or null to skip.
function atEachSite(source, regex, toReplacement) {
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g')
  const results = []
  let m
  while ((m = re.exec(source)) !== null) {
    const rep = toReplacement(m)
    const reps = rep == null ? [] : Array.isArray(rep) ? rep : [rep]
    for (const r of reps) results.push(source.slice(0, m.index) + r + source.slice(m.index + m[0].length))
    if (m.index === re.lastIndex) re.lastIndex++ // guard a zero-width match from looping forever
  }
  return results
}

// Fixed operator set. Each .run(source) returns candidate mutant SOURCES (identity/dedup is handled in mutate).
// Space-delimited binary-operator patterns (` + `, ` < `) deliberately avoid ++/--/+=/=>/=== etc., so
// arithmetic-swap never corrupts an increment into "+-"; increment-tweak owns ++/--.
// return-constant always emits all three constants; identity/cosmetic mutants (e.g. `return null` -> `return null`)
// fall out via the seen-dedup + identity check in mutate(), not here.
const OPERATORS = [
  { name: 'return-constant', run: (s) => atEachSite(s, /return\s+([^\n;}]+)/g, () => ['return 0', 'return null', 'return true']) },
  { name: 'increment-tweak', run: (s) => atEachSite(s, /\+\+|--/g, (m) => (m[0] === '++' ? '--' : '++')) },
  {
    name: 'comparison-flip',
    run: (s) => [
      ...atEachSite(s, /===/g, () => '!=='),
      ...atEachSite(s, /!==/g, () => '==='),
      ...atEachSite(s, /(?<![=!<>])==(?![=>])/g, () => '!='),
      ...atEachSite(s, /(?<![=!<>])!=(?!=)/g, () => '=='),
      ...atEachSite(s, / <= /g, () => ' >= '),
      ...atEachSite(s, / >= /g, () => ' <= '),
      ...atEachSite(s, / < /g, () => ' > '),
      ...atEachSite(s, / > /g, () => ' < '),
    ],
  },
  {
    name: 'boolean-flip',
    run: (s) => [
      ...atEachSite(s, /\btrue\b/g, () => 'false'),
      ...atEachSite(s, /\bfalse\b/g, () => 'true'),
    ],
  },
  {
    name: 'arithmetic-swap',
    run: (s) => [
      ...atEachSite(s, / \+ /g, () => ' - '),
      ...atEachSite(s, / - /g, () => ' + '),
      ...atEachSite(s, / \* /g, () => ' / '),
      ...atEachSite(s, / \/ /g, () => ' * '),
    ],
  },
]

// Produce up to maxMutants distinct mutants, never the input itself, each tagged with its operator. Operators
// run in array order; the cap truncates the tail (deterministic), so the earliest operators are favoured.
export function mutate(source, { maxMutants = 24 } = {}) {
  const seen = new Set()
  const out = []
  for (const op of OPERATORS) {
    for (const mutantSource of op.run(source)) {
      if (mutantSource === source || seen.has(mutantSource)) continue
      seen.add(mutantSource)
      out.push({ operator: op.name, source: mutantSource })
      if (out.length >= maxMutants) return out
    }
  }
  return out
}
