// The ONE markdown fence parser the three doc scorers share (doc-lint, doc-exec, doc-coverage).
//
// Why it exists: the three used to carry three different fence regexes — doc-coverage was
// delimiter-agnostic but unanchored, doc-lint and doc-exec were backtick-only, and doc-lint was
// anchored while doc-exec was not. That divergence is a bug GENERATOR, not a style wart: the three
// grade the SAME document, so when they disagree about where a fence starts, one scorer's misparse
// silently changes another scorer's verdict. That is exactly how the 2026-07-04 doc-depth run failed —
// an inline ```js written in prose desynchronized fence pairing, and the damage landed on doc-coverage
// and doc-lint at once.
//
// Two properties, both load-bearing:
//
// 1. LINE-ANCHORED open and close (`^` + the `m` flag). A triple-backtick written inside a sentence
//    ("runs every fenced ```js example") must not open a block. Unanchored, it did — and every later
//    delimiter then paired wrongly, turning ordinary prose into fence body while hiding the real fence
//    that followed. Consequence: an INDENTED fence (inside a list item or blockquote) no longer opens
//    or closes a block either.
// 2. DELIMITER-AGNOSTIC with a `\1` backreference, so a ``` block closes with ``` and a ~~~ block
//    closes with ~~~ — never each other. This is anti-gaming, not convenience: the scorers grade
//    model-authored text, so a backtick-only parser lets a dangling ref or a stale example be parked
//    in a ~~~ block where the checker cannot see it, raising the score without fixing anything.
//    (doc-coverage closed this bypass for itself in C6-05; its siblings were left open.)
//
// Delimiters are exactly three characters, matching the previous behaviour: a ```` line opens via its
// first three backticks and closes on the next column-0 ```, as it always did.

// A FRESH regex per call, deliberately. A module-level /g regex shared by three importers carries
// `lastIndex` across them, so one scorer returning early mid-iteration would silently skip blocks in
// the next — a state leak that is invisible until a doc happens to trigger it.
const pattern = () => /^(```|~~~)(\w*)[^\n]*\n([\s\S]*?)^\1/gm

// Every fenced block in order, as {lang, body}. `lang` is '' for a bare fence. Exported for test.
export function eachFence(md) {
  return [...String(md).matchAll(pattern())].map((m) => ({ lang: m[2] || '', body: m[3] }))
}

// Drop every fenced block (any language, any delimiter), keeping inline `code` — flags and modules are
// typographically written in backticks in prose, and that must still count as a mention.
export function stripFences(md) {
  return String(md).replace(pattern(), '\n')
}
