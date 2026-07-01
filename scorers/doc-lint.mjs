#!/usr/bin/env node
// Reference scorer (deterministic): grade a markdown doc by how many of its VERIFIABLE
// claims about the repo actually hold — every repo-relative file reference must exist, and
// the advertised version must match package.json. score = 100 * (claims that hold / claims).
// This is "code owns the gate" applied to docs: it turns README drift into a measured number,
// so the loop can raise a stale doc back to accurate, and CI can regression-guard it for free.
//
// It checks only the AUTHORITATIVE refs — paths in non-shell fenced blocks (the file map),
// markdown links, and html src/href — never illustrative paths in ```bash command examples or
// `<run>`/glob placeholders, which would be false positives.
//
// Contract (every whetstone scorer honors this): read --output/--rel/--repo, print
// {score, critique, findings} JSON to stdout, exit 0 on success, exit 2 on scorer error.
//
// Existence checks are repo-contained: refs are percent-decoded, then realpath-resolved and required to
// stay inside realpath(--repo) — an in-repo symlink to an external target is NOT followed (no out-of-repo
// existence oracle via the score/critique). See refResolves.
//
// Known limitations: (1) a ragged ```` ```bash ```` block that itself contains a bare ```` ``` ````
// can close early and leak the trailing line into the next plain fence (a possible false-positive ref
// in docs that print raw Markdown inside a shell block — rare; a proper nesting-aware parser is the fix).
// (2) within a single --repo the score still reveals which doc-named paths exist; constraining a
// model-authorable --repo (so a plan can't widen the probe surface) belongs in the Track A arg schema
// (plan-allowlist), not here.
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { isMainModule } from '../src/is-main.mjs'
import { resolveOutput } from '../src/safe-rel.mjs'

const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'console', 'zsh'])
const FENCE = /```(\w*)[^\n]*\n([\s\S]*?)```/g
// Quantifiers are BOUNDED (not `*`): an unbounded run of slash/dot tokens before the required `.ext`
// drove O(n^2) catastrophic backtracking (a pathological long line burned seconds). No real repo path
// approaches these caps, so the bound is behaviour-preserving on real docs while keeping matching linear.
const PATH_TOKEN = /[A-Za-z0-9_][A-Za-z0-9_.-]{0,512}\/[A-Za-z0-9_./-]{0,512}\.[A-Za-z0-9]+/g
const MD_LINK = /\[[^\]]{0,2048}\]\(([^)\s]+)\)/g
const HTML_ATTR = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi

// A ref is checkable only if it names a repo-relative file: has a directory and an extension,
// and is not a glob / placeholder / url / anchor / absolute / home path. Exported for test.
export function isCheckableRef(r) {
  if (!r || /[*<>\s`]/.test(r)) return false // globs, placeholders, junk
  if (/^(https?:|mailto:|#|\/|~)/.test(r)) return false // url, anchor, absolute, home
  if (r.includes('://')) return false
  if (/(^|\/)\.\.(\/|$)/.test(r)) return false // `..` path segment — would probe outside --repo (existence oracle)
  if (!r.includes('/')) return false // bare filename — not dir-qualified, skip
  if (!/\.[A-Za-z0-9]+$/.test(r)) return false // must end in an extension
  return true
}

// Pull every authoritative, checkable repo reference out of a markdown doc (deduped, in order).
export function extractRefs(md) {
  const candidates = []
  let m
  FENCE.lastIndex = 0
  while ((m = FENCE.exec(md))) {
    if (SHELL_LANGS.has((m[1] || '').toLowerCase())) continue // command example — illustrative paths
    for (const t of m[2].match(PATH_TOKEN) || []) candidates.push(t)
  }
  for (const re of [MD_LINK, HTML_ATTR]) {
    re.lastIndex = 0
    while ((m = re.exec(md))) candidates.push(m[1])
  }
  const seen = new Set()
  const refs = []
  for (const raw of candidates) {
    const r = raw.trim()
    if (isCheckableRef(r) && !seen.has(r)) {
      seen.add(r)
      refs.push(r)
    }
  }
  return refs
}

// Score the doc against ground truth. `exists(ref)` decides whether a file ref resolves; `version`
// (or undefined) is package.json's version — the doc must advertise `v<version>`. Pure: no fs here.
export function lintDoc(md, { version, exists }) {
  const refs = extractRefs(md)
  const broken = refs.filter((r) => !exists(r))
  // boundary-anchored so `v1.0.0` is NOT satisfied by a superstring like `v1.0.0.1` (a gamed/ahead version)
  const esc = String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const versionOk = version ? new RegExp(`(?<![\\w.])v${esc}(?![\\w.-])`).test(md) : true

  const total = refs.length + (version ? 1 : 0)
  const failCount = broken.length + (versionOk ? 0 : 1)
  const score = total === 0 ? 100 : Math.round(((100 * (total - failCount)) / total) * 100) / 100

  const findings = broken.map((r) => ({
    area: 'doc-claim',
    severity: 'high',
    suggestion: `the doc references \`${r}\` which does not exist in the repo — fix the path or remove the reference`,
  }))
  if (!versionOk) {
    findings.push({
      area: 'version',
      severity: 'high',
      suggestion: `advertise the current version v${version} (from package.json) — the doc is behind`,
    })
  }

  let critique
  if (failCount === 0) {
    critique = `all ${total} doc claims check out (${refs.length} file refs${version ? ' + version' : ''})`
  } else {
    const lines = [
      ...broken.map((r) => `- dangling ref: ${r} (no such file in the repo)`),
      ...(versionOk ? [] : [`- version: doc must advertise v${version} (package.json)`]),
    ]
    critique = `${failCount}/${total} doc claims broken:\n${lines.join('\n')}`.slice(0, 3000)
  }
  return { score, critique, findings }
}

// Does `ref` name a file that genuinely exists INSIDE repoDir? Two hardening steps vs a naive
// existsSync(join(repo, ref)): (1) accept the file under EITHER spelling — the literal ref OR its
// percent-decoded form — so a CommonMark link to a spaced/paren'd file (`docs/a%20b.md` → real `a b.md`)
// AND a real file literally named with `%XX` (`report-50%20done.md`) are both found; (2) realpath BOTH the
// repo root and the resolved ref, then require containment — so an in-repo symlink pointing OUTSIDE the
// repo (existsSync follows links) cannot turn the score into an out-of-repo existence oracle. Both spellings
// pass the SAME containment guard, so accepting "either" never relaxes containment. A throw at any step
// (missing file, broken/escaping symlink, malformed %) means "absent" — never a probe.
export function refResolves(repoDir, ref) {
  let repoReal
  try {
    repoReal = realpathSync(repoDir)
  } catch {
    return false
  }
  const spellings = [ref]
  try {
    const dec = decodeURIComponent(ref)
    if (dec !== ref) spellings.push(dec)
  } catch {
    /* malformed %-sequence — only the literal spelling */
  }
  for (const s of spellings) {
    let real
    try {
      real = realpathSync(resolve(repoReal, s))
    } catch {
      continue // this spelling is absent / a broken or escaping symlink
    }
    if (real === repoReal || real.startsWith(repoReal + sep)) return true // contained after following symlinks
  }
  return false
}

if (isMainModule(import.meta.url)) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(name)
    return i >= 0 ? process.argv[i + 1] : def
  }
  const die = (msg) => {
    process.stderr.write(`doc-lint: ${msg}\n`)
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

  const repo = arg('--repo', dirname(output)) // claims resolve against the repo root (default: the doc's dir)
  let version
  try {
    version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version
  } catch {
    version = undefined // no/unreadable package.json → skip the version claim
  }

  process.stdout.write(JSON.stringify(lintDoc(md, { version, exists: (ref) => refResolves(repo, ref) })))
}
