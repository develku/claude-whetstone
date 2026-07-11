#!/usr/bin/env node
// Reference scorer (deterministic): the RECALL mirror of doc-lint. doc-lint walks refs IN the doc and asks
// "does the repo have this?" (precision — a claim that's made must hold); doc-coverage walks a COMMITTED
// required set (scorers/doc-required.json under --repo) and asks "does the doc DESCRIBE this?" (recall — a
// claim that must be made is present). score = 100 * (substantively documented / required). Together under
// composite MIN they close the omission blind spot: a doc can no longer score 100 by simply not mentioning
// what it fails to document.
//
// ANTI-GAMING CORE — "documented" is substantive, never token-presence:
//   - a mention inside ANY fenced code block never counts (a flag flashed in a command example is not a description);
//   - a table row counts only when a DIFFERENT cell carries >= wordFloors.desc words of description;
//   - a heading counts only when its body (to the next heading) carries >= wordFloors.prose words;
//   - any other line counts only when the line minus the token carries >= wordFloors.prose words —
//     so a bare `- --observe` list item is a name-drop, not documentation;
//   - matching is boundary-anchored (doc-lint's version-claim idiom): `--observe-foo` never satisfies
//     `--observe`, `xbudgetTokens` never satisfies `budgetTokens`; a `.mjs` suffix and a path prefix are
//     allowed so `src/forge/gate-probe.mjs` documents the module `gate-probe`;
//   - floors count DISTINCT words, so repetition stuffing (`the the the the`) never clears one
//     (power-review HIGH #1);
//   - EVERY required token is stripped before counting, not just the one under test — one dump line
//     naming six flags gives each of them zero description words, so a single cross-token filler
//     paragraph satisfies nothing (power-review HIGH #2).
//
// Residual (accepted, the honest $0 ceiling): distinct-word filler that LOOKS like prose ("alpha beta
// gamma delta") still clears a floor — whether a substantive-looking description is TRUE is prose truth,
// which no deterministic counter can decide; that axis belongs to a clamped judge or a human read.
//
// The required set is the COMMITTED manifest, never derived from the live tree at eval time — the editor
// cannot shrink its own denominator (blast-radius reverts sibling edits in single-file runs; the drift
// tripwire in test/doc-required.test.mjs keeps the manifest honest against driver.mjs). An absent or empty
// manifest is a scorer ERROR (exit 2, fail-closed): an empty required set must never mint a free 100.
//
// Contract (every whetstone scorer honors this): read --output/--rel/--repo, print
// {score, critique, findings} JSON to stdout, exit 0 on success, exit 2 on scorer error.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isMainModule } from '../src/is-main.mjs'
import { resolveOutput } from '../src/safe-rel.mjs'

// Delimiter-agnostic (backtick AND tilde), UNLIKE doc-lint's/doc-exec's backtick-only FENCE: the `\1`
// backreference makes a ``` block still close with ``` (identical to before) and a ~~~ block close with
// ~~~ — anti-gaming, so a tilde-fenced example can't be counted as prose and the header's "ANY fenced
// code block never counts" claim actually holds (a ~~~ help dump must not mint a required flag as documented).
const FENCE = /(```|~~~)(\w*)[^\n]*\n([\s\S]*?)\1/g
const HEADING = /^#{1,6}\s/
const DEFAULT_FLOORS = { desc: 4, prose: 8 }

// Drop every fenced block (any language) but keep inline `code` — flags/modules are typographically
// written in backticks in prose, and that must still count as a mention.
export function stripFences(md) {
  return String(md).replace(FENCE, '\n')
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Boundary-anchored token matcher: not embedded in a longer word/flag, optional `.mjs` suffix.
const tokenRe = (token) => new RegExp(`(?<![\\w-])${escapeRe(token)}(?:\\.mjs)?(?![\\w-])`, 'g')

// DISTINCT words (case-folded): repetition stuffing ("the the the the") counts as ONE word, so it can
// never clear a floor (power-review HIGH #1).
const countWords = (text) => new Set((String(text).match(/[A-Za-z]{2,}/g) || []).map((w) => w.toLowerCase())).size

// Is `token` substantively documented anywhere in `md`? See the anti-gaming rules in the header.
// `allTokens` (when supplied) is the FULL required set: every token in it is stripped before words are
// counted, so other required tokens never serve as description words for this one (power-review HIGH #2).
export function substantiveMention(md, token, floors = DEFAULT_FLOORS, allTokens = []) {
  const re = tokenRe(token)
  const stripSet = allTokens.includes(token) ? allTokens : [...allTokens, token]
  const stripTokens = (text) => stripSet.reduce((t, tok) => t.replace(tokenRe(tok), ' '), String(text))
  const lines = stripFences(md).split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    re.lastIndex = 0
    if (!re.test(line)) continue

    if (line.trim().startsWith('|')) {
      // Table row: the row minus EVERY required token must still carry a real description. Counting the
      // whole stripped row (not "cells without the token") lets a description that echoes the token —
      // a command example like `node driver --forge-retire --check` — still count, while a token-only
      // junk row strips to nothing and fails.
      if (countWords(stripTokens(line)) >= floors.desc) return true
      continue
    }
    if (HEADING.test(line)) {
      // Heading: its body (up to the next heading) must carry real prose.
      const body = []
      for (let j = i + 1; j < lines.length && !HEADING.test(lines[j]); j++) body.push(lines[j])
      if (countWords(stripTokens(body.join(' '))) >= floors.prose) return true
      continue
    }
    // Prose (or list) line: the line minus every required token must clear the prose floor.
    if (countWords(stripTokens(line)) >= floors.prose) return true
  }
  return false
}

// Score the doc against the required items. Pure: no fs here. `required` is [{group, token}].
export function scoreCoverage(md, required, floors = DEFAULT_FLOORS) {
  const allTokens = required.map((r) => r.token)
  const missing = required.filter((r) => !substantiveMention(md, r.token, floors, allTokens))
  const total = required.length
  const documented = total - missing.length
  const score = total === 0 ? 100 : Math.round(((100 * documented) / total) * 100) / 100

  const findings = missing.map((r) => ({
    area: 'doc-coverage',
    severity: 'high',
    suggestion: `\`${r.token}\` (${r.group}) is not substantively documented — describe it in prose or a table row with a real description (bare name-drops and code-fence mentions don't count)`,
  }))

  const critique = missing.length === 0
    ? `doc-coverage: all ${total} required items substantively documented`
    : `doc-coverage: ${documented}/${total} required items substantively documented; missing:\n${missing
        .map((r) => `- \`${r.token}\` (${r.group})`)
        .join('\n')}`.slice(0, 3000)

  return { score, critique, findings }
}

// Read the committed manifest under repoDir and flatten it to [{group, token}]. Throws (fail-closed) on a
// missing/unreadable/empty manifest — the caller maps that to exit 2, never to a score.
export function loadRequired(repoDir) {
  const p = join(repoDir, 'scorers', 'doc-required.json')
  let j
  try {
    j = JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) {
    throw new Error(`doc-required manifest unreadable at ${p}: ${e.message}`)
  }
  const items = []
  for (const group of ['flags', 'scorers', 'configKeys', 'modules']) {
    for (const token of Array.isArray(j[group]) ? j[group] : []) items.push({ group, token: String(token) })
  }
  if (items.length === 0) throw new Error(`doc-required manifest at ${p} has an empty required set — refusing to score (an empty set would mint a free 100)`)
  return items
}

if (isMainModule(import.meta.url)) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(name)
    return i >= 0 ? process.argv[i + 1] : def
  }
  const die = (msg) => {
    process.stderr.write(`doc-coverage: ${msg}\n`)
    process.exit(2)
  }

  let output = arg('--output')
  if (!output) die('--output <path> is required')
  try {
    output = resolveOutput(output, arg('--rel')) // scope mode: --output root + --rel file
  } catch (e) {
    die(e.message)
  }

  let md = ''
  try {
    md = readFileSync(output, 'utf8')
  } catch (e) {
    die(`cannot read output ${output}: ${e.message}`)
  }

  const repo = arg('--repo', dirname(output))
  let required
  let floors = DEFAULT_FLOORS
  try {
    required = loadRequired(repo)
    const manifest = JSON.parse(readFileSync(join(repo, 'scorers', 'doc-required.json'), 'utf8'))
    if (manifest.wordFloors) floors = { ...DEFAULT_FLOORS, ...manifest.wordFloors }
  } catch (e) {
    die(e.message)
  }

  process.stdout.write(JSON.stringify(scoreCoverage(md, required, floors)))
}
