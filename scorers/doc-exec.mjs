#!/usr/bin/env node
// Reference scorer (deterministic, EXECUTABLE): the doctest/rustdoc move applied to the doc gate — every
// fenced ```js example that imports from the repo is a RUNNABLE CLAIM about the code, so run it. Each block
// is executed in the SAME locked-down out-of-process child the io-* scorers use (src/iso-runner.mjs: Node
// --permission, socket-builtin deny set, scrubbed fetch/WebSocket, allowlisted env, nonce-framed fd3) — a
// README example is editor-authored, i.e. untrusted, and gets no weaker sandbox than any other model code.
// score = 100 * (examples that execute-and-pass / runnable examples): a stale example — wrong expected
// value, renamed export, changed signature — turns the score red instead of rotting silently.
//
// What does NOT count as a claim: blocks in other languages, and js blocks that import nothing from the
// repo (illustrative snippets). With ZERO runnable claims the score INHERITS the doc-coverage recall floor
// — never a free 100 — so under composite MIN this leg is inert until examples exist, and binding once they
// do. (Demanding examples exist is doc-coverage's job via its required set, not this leg's.)
//
// Residuals, accepted and named (doc-lint's own regex-over-AST tradeoff, applied here):
//   - a block that imports the repo and asserts something trivial still passes — this leg proves runnable
//     claims RUN, not that they are meaningful (doctest's own honest scope);
//   - import detection strips WHOLE-LINE // comments first (a commented-out import is not a claim,
//     power-review MEDIUM #1) but stays textual beyond that: a trailing-comment import or a string
//     literal shaped like `from './x.mjs'` is still detected/rewritten — string literals resembling
//     import clauses may be mangled in the executed copy (rare in real examples; a proper parser is the fix);
//   - a block declaring its own __docexec__ collides with the appended sentinel and fails at import —
//     it sabotages itself, never the gate.
//
// Contract (every whetstone scorer honors this): read --output/--rel/--repo, print
// {score, critique, findings} JSON to stdout, exit 0 on success, exit 2 on scorer error.
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isMainModule } from '../src/is-main.mjs'
import { resolveOutput } from '../src/safe-rel.mjs'
import { runIsolated } from '../src/iso-runner.mjs'
import { loadRequired, scoreCoverage } from './doc-coverage.mjs'

const FENCE = /```(\w*)[^\n]*\n([\s\S]*?)```/g // same shape as doc-lint's
const JS_LANGS = new Set(['js', 'javascript', 'mjs'])
const MAX_BLOCKS = 10 // bound scoring wall-clock; anything beyond is REPORTED in the critique, never silent

// Pull the source of every js-language fenced block, in order. Exported for test.
export function extractJsBlocks(md) {
  const blocks = []
  let m
  FENCE.lastIndex = 0
  while ((m = FENCE.exec(md))) {
    if (JS_LANGS.has((m[1] || '').toLowerCase())) blocks.push(m[2])
  }
  return blocks
}

// Rewrite relative import specifiers against the repo root (README examples are written as if run from
// there) into absolute file:// URLs, so the block executes from a temp file yet resolves repo modules.
// Whole-line // comments are stripped FIRST (comments are inert at execution, and a commented-out import
// must not count as a runnable claim — power-review MEDIUM #1). Every remaining relative import is a repo
// claim; builtins/bare specifiers are untouched. Exported for test.
export function rewriteImports(src, repoDir) {
  let repoImports = 0
  const code = String(src)
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(
      /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.\.?\/[^'"]+)\2/g,
      (_whole, prefix, q, spec) => {
        repoImports++
        return `${prefix}${q}${pathToFileURL(resolve(repoDir, spec)).href}${q}`
      },
    )
  return { code, repoImports }
}

// Map one isolated observation to a block verdict. Pure + exported. `scorerError` is set only for the
// Node-floor case — that is a scorer malfunction (exit 2), never a block failure.
// DELIBERATE deviation from iso-runner's shared classifyObservation (which maps an import failure to
// exit 2): here the imported artifact IS the doc's example, so a stale example with a renamed export or a
// top-level assertion throw must degrade the SCORE (0 for that block), not abort the whole gate. Do not
// "fix" this back to classifyObservation — per-block semantics are the point (power-review LOW #1).
export function judgeBlockObs(obs) {
  if (!obs.ok) {
    if (obs.reason === 'runtime') return { pass: false, scorerError: obs.error }
    const detail = obs.error || obs.reason
    return { pass: false, error: `${detail}${obs.stderr ? ` (${obs.stderr})` : ''}` }
  }
  const r = obs.results && obs.results[0]
  if (!r || r.threw || r.value !== true) return { pass: false, error: r && r.error ? r.error : 'example did not complete' }
  return { pass: true }
}

if (isMainModule(import.meta.url)) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(name)
    return i >= 0 ? process.argv[i + 1] : def
  }
  const die = (msg) => {
    process.stderr.write(`doc-exec: ${msg}\n`)
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
  // The child's --allow-fs-read grants are REALPATHS and Node's permission model compares paths literally
  // (it does not follow symlinks at check time) — so imports must be rewritten against the repo's realpath,
  // or a symlinked tmp/repo dir (macOS /tmp, /var/folders) reads as an out-of-grant path and every block fails.
  let repoReal = repo
  try {
    repoReal = realpathSync(repo)
  } catch {
    /* unresolvable --repo: keep as-is; runIsolated will surface the artifact/read failure */
  }
  const runnable = extractJsBlocks(md)
    .map((src) => rewriteImports(src, repoReal))
    .filter((b) => b.repoImports > 0)

  if (runnable.length === 0) {
    // No runnable claims: inherit the recall floor (fail-closed via loadRequired), never a free 100.
    let floor
    try {
      const required = loadRequired(repo)
      const manifest = JSON.parse(readFileSync(join(repo, 'scorers', 'doc-required.json'), 'utf8'))
      floor = scoreCoverage(md, required, { desc: 4, prose: 8, ...(manifest.wordFloors || {}) })
    } catch (e) {
      die(e.message)
    }
    process.stdout.write(JSON.stringify({
      score: floor.score,
      critique: `doc-exec: no runnable examples (js blocks importing from the repo) — inheriting the doc-coverage recall floor ${floor.score}; add a runnable example to earn independent accuracy credit`,
      findings: [],
    }))
  } else {
    const executed = runnable.slice(0, MAX_BLOCKS)
    const skipped = runnable.length - executed.length
    const workDir = mkdtempSync(join(tmpdir(), 'doc-exec-'))
    const failures = []
    try {
      executed.forEach((block, i) => {
        const file = join(workDir, `block-${i}.mjs`)
        writeFileSync(file, `${block.code}\n\nexport function __docexec__() { return true }\n`)
        const obs = runIsolated({ artifact: file, mode: 'assert', spec: { fn: '__docexec__', cases: [[]] }, readRoot: repo })
        const verdict = judgeBlockObs(obs)
        if (verdict.scorerError) die(verdict.scorerError)
        if (!verdict.pass) failures.push({ index: i + 1, error: verdict.error })
      })
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }

    const passed = executed.length - failures.length
    // Skipped blocks stay in the DENOMINATOR: unexecuted = unproven, and the score is the only signal a
    // composite consumer reads — a silent-to-score cap would launder a broken 11th example past the gate
    // (power-review MEDIUM #2). The critique still names the cap for the human reader.
    const score = Math.round(((100 * passed) / runnable.length) * 100) / 100
    const capNote = skipped ? ` (${skipped} block(s) beyond the ${MAX_BLOCKS}-block cap not executed — they count as unproven)` : ''
    const critique = failures.length === 0
      ? `doc-exec: ${passed}/${runnable.length} runnable examples execute-and-pass${capNote}`
      : `doc-exec: ${passed}/${runnable.length} runnable examples execute-and-pass${capNote}; failing:\n${failures
          .map((f) => `- example #${f.index}: ${f.error}`)
          .join('\n')}`.slice(0, 3000)

    process.stdout.write(JSON.stringify({
      score,
      critique,
      findings: failures.map((f) => ({
        area: 'doc-exec',
        severity: 'high',
        suggestion: `runnable example #${f.index} fails against the current code: ${f.error} — update the example or fix the behaviour it demonstrates`,
      })),
    }))
  }
}
