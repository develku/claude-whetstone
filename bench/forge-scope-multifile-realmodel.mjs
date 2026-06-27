#!/usr/bin/env node
// bench/forge-scope-multifile-realmodel.mjs
// MULTI-FILE scope-Forge real-model elicitation. The $0 ledger proved the multi-file PRODUCE path learns a
// per-file check for each gamed file mechanically; this asks the harder question with a REAL proposer: does a
// real model PROPOSE a usable per-file check for EACH of TWO independently-gamed files in one recovery?
//
// The proof is deliberately paranoid (codex cross-model review, 2026-06-27). A green composite gate is NOT
// proof: with MIN aggregation, ONE working check vetoes a both-gamed tree even if the other check is useless.
// So we run EACH admitted check INDIVIDUALLY (scorerRunCheck against plain probe dirs — no git needed) and
// prove THREE separate things per file:
//   1. EMISSION    — every changed file gets >=1 admitted scope check targeting it (rel in the cmd). A real
//                    model may propose SEVERAL checks for one file (extra coverage); extras are reported, not
//                    penalized. The criterion is per-FILE proven, NOT "exactly N total" — the 2026-06-27 sonnet
//                    run proposed 3 (2 for the counter, one weaker) and that is a pass, with the weak one flagged.
//   2. ATTRIBUTION — each file's check FAILS its OWN file's gamed tree and PASSES the OTHER file's gamed tree
//                    (so the veto is the right check's doing, not a check that accidentally reads both files).
//   3. BEHAVIOURAL+NON-BRITTLE — each check fails BOTH textually-different gamed variants of its file (defeats a
//                    textual `contains` masquerading as behavioural) and passes the honest AND a semantically-
//                    equivalent alternate honest (not over-fit to one phrasing).
// io-trace vs io-assert is reported as DIAGNOSTIC metadata, never a pass/fail gate (a stateful counter does not
// FORCE io-trace — an io-assert sequence can also catch it).
//
//   node bench/forge-scope-multifile-realmodel.mjs --stub          # $0 harness check (prompt-aware stub)
//   node bench/forge-scope-multifile-realmodel.mjs --model sonnet   # PAID real generate (~$0.5)
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { runScopeForgeHook } from '../src/forge/scope-hook.mjs'
import { loadStore, checkStorePath } from '../src/forge/store.mjs'
import { scorerRunCheck } from '../src/forge/admit.mjs'
import { formatSpend } from '../src/spend-format.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const IO_ASSERT = join(REPO, 'scorers', 'io-assert.mjs')
const IO_TRACE = join(REPO, 'scorers', 'io-trace.mjs')
const CONTAINS = join(REPO, 'scorers', 'contains.mjs')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const STUB = process.argv.includes('--stub')
const model = arg('--model', 'sonnet')
const tmp = (p) => mkdtempSync(join(tmpdir(), p))
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
const typeOf = (cmd) => (cmd.includes('io-trace') ? 'io-trace' : cmd.includes('io-assert') ? 'io-assert' : cmd.includes('contains') ? 'contains' : 'other')

const GOAL = 'src/a.mjs exports f(n) = n doubled; src/b.mjs exports makeCounter() returning { inc(), value() }'

// Two INDEPENDENTLY-gamed files. Each carries: honest, TWO textually-different gamed variants (same file,
// different bug — proves the learned check is behavioural, not a text match on gamed1), and a semantically-
// equivalent alt honest (proves non-brittle). The `stub` is what the prompt-aware $0 proposer returns.
const FILES = {
  'src/a.mjs': {
    honest: 'export const f = (n) => n * 2\n',
    gamed1: 'export const f = (n) => n * 3\n',          // triples — wrong
    gamed2: 'export const f = (n) => n * 2 + 1\n',       // off-by-one — wrong, different text & behaviour
    alt: 'export const f = (n) => n + n\n',              // equivalent honest
    stub: { scorerId: 'io-assert', args: ['--fn', 'f', '--case', '2=>4'], rationale: 'doubling behavioural case' },
  },
  'src/b.mjs': {
    honest: 'export const makeCounter = () => { let n = 0; return { inc() { return ++n }, value() { return n } } }\n',
    gamed1: 'export const makeCounter = () => ({ inc() {}, value() { return 1 } })\n',                     // constant
    gamed2: 'export const makeCounter = () => { let n = 0; return { inc() { n++ }, value() { return 0 } } }\n', // counts but reports 0
    alt: 'export const makeCounter = () => { const c = { n: 0 }; return { inc() { c.n += 1; return c.n }, value() { return c.n } } }\n',
    stub: { scorerId: 'io-trace', args: ['--factory', 'makeCounter', '--trace', '[["inc"],["inc"],["value"]]', '--expect', '[1,2,2]'], rationale: 'stateful counter trace' },
  },
}
const RELS = Object.keys(FILES)
const allHonest = () => Object.fromEntries(RELS.map((rel) => [rel, 'honest']))

// Prompt-aware stub: the per-file generator embeds `Changed file: <rel>` in its prompt; return that file's
// candidate. A fixed stub would propose the same check for both files and the attribution proof would fail.
const stubPropose = async (prompt) => {
  const rel = (prompt.match(/Changed file:\s*(\S+)/) || [])[1]
  const f = FILES[rel]
  return { text: JSON.stringify({ candidates: f ? [{ ...f.stub }] : [] }) }
}

// A throwaway NON-git dir with a chosen variant per file — the probe tree a single check is run against.
// Assumption (true for every shipped scorer): a per-file check reads ONLY its `--rel` file, so the variant
// chosen for the OTHER file in a probe tree is irrelevant to it. The attribution legs exploit this directly
// (own-file gamed must FAIL, other-file gamed must PASS). A future cross-file invariant scorer would break the
// assumption and this fixture would need revisiting — there is none today.
const probeDir = (variantByRel) => {
  const d = tmp('mf-probe-')
  mkdirSync(join(d, 'src'))
  for (const rel of RELS) writeFileSync(join(d, rel), FILES[rel][variantByRel[rel]])
  return d
}
const runCheck = (check, variantByRel) => scorerRunCheck(check.cmd, probeDir(variantByRel), { target: check.target }).pass

const commitTree = (repo, variant, msg) => {
  for (const rel of RELS) writeFileSync(join(repo, rel), FILES[rel][variant])
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', msg)
  return git(repo, 'rev-parse', 'HEAD')
}

async function run() {
  const repo = tmp('mf-scope-')
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 't@e.com'); git(repo, 'config', 'user.name', 't')
  mkdirSync(join(repo, 'src'))
  const badSha = commitTree(repo, 'gamed1', 'gamed')   // both files gamed (the vetoed snapshot)
  commitTree(repo, 'honest', 'honest')                 // HEAD = both files honest (the recovered final)
  const storePath = checkStorePath(tmp('mf-store-'))

  const cfg = { forge: true, forgeStorePath: storePath, scorerAllow: [IO_ASSERT, IO_TRACE, CONTAINS], model }
  const state = { goal: GOAL, artifact_path: repo, last_critique: '', confirm_vetoed_at_pass: 0, history: [{ snapshot: badSha }] }
  const deps = STUB ? { propose: stubPropose } : {}
  const r = await runScopeForgeHook({ cfg, state }, deps)
  const learned = loadStore(storePath).checks.filter((c) => c.kind === 'scope')

  const relOf = (cmd) => RELS.find((rel) => cmd.includes(rel)) || '(unknown)'
  const perCheck = learned.map((c) => {
    const rel = relOf(c.cmd)
    const other = RELS.find((x) => x !== rel)
    const passHonest = runCheck(c, allHonest())
    const passAlt = runCheck(c, Object.fromEntries(RELS.map((x) => [x, 'alt'])))
    const failsOwnGamed1 = rel !== '(unknown)' && !runCheck(c, { ...allHonest(), [rel]: 'gamed1' })
    const failsOwnGamed2 = rel !== '(unknown)' && !runCheck(c, { ...allHonest(), [rel]: 'gamed2' })
    const ignoresOtherGamed1 = !!other && runCheck(c, { ...allHonest(), [other]: 'gamed1' })
    const ignoresOtherGamed2 = !!other && runCheck(c, { ...allHonest(), [other]: 'gamed2' })
    const attributed = failsOwnGamed1 && failsOwnGamed2 && ignoresOtherGamed1 && ignoresOtherGamed2
    const nonBrittle = passHonest && passAlt
    return { rel, type: typeOf(c.cmd), cmd: c.cmd, passHonest, passAlt, failsOwnGamed1, failsOwnGamed2, ignoresOtherGamed1, ignoresOtherGamed2, attributed, nonBrittle, fullProof: attributed && nonBrittle }
  })

  // Regression only (NOT the proof): the composite gate vetoes a both-gamed tree iff at least one check fails it.
  const bothGamed = { 'src/a.mjs': 'gamed1', 'src/b.mjs': 'gamed1' }
  const bothGamedVeto = learned.length > 0 && learned.some((c) => !runCheck({ cmd: c.cmd, target: c.target }, bothGamed))

  return { learned, perCheck, bothGamedVeto, tokens: r.tokens ?? 0, costUsd: r.costUsd ?? 0, rejected: (r.rejected || []).map((x) => `${x.scorerId}: ${x.reason}`) }
}

console.log(`\n=== Forge scope MULTI-FILE real-model elicitation (${STUB ? 'STUB $0 harness check' : `model=${model}`}, 2 gamed files) ===\n`)
const res = await run()

const relsLearned = new Set(res.perCheck.map((c) => c.rel))
const relsCorrect = RELS.every((rel) => relsLearned.has(rel)) && !relsLearned.has('(unknown)')
const attributed = res.perCheck.filter((c) => c.attributed).length
const behavioural = res.perCheck.filter((c) => c.failsOwnGamed1 && c.failsOwnGamed2).length
const spendOK = STUB ? res.tokens === 0 : res.tokens > 0 && res.costUsd > 0
// The multi-file elicitation criterion is per-FILE, not a fixed total: every changed file must have AT LEAST ONE
// fully-proven check. A real model may also propose weaker EXTRA checks for a file — admit accepts any check that
// discriminates the ONE real vetoed snapshot, so a check can pass admission yet miss a SYNTHETIC second-variant
// bug this bench introduces. That is a finding about admit (it tests vs one snapshot), reported as a diagnostic,
// NOT a failure of elicitation — extras are not penalized.
const provenRels = new Set(res.perCheck.filter((c) => c.fullProof).map((c) => c.rel))
const provenFiles = RELS.filter((rel) => provenRels.has(rel)).length
const allFilesProven = provenFiles === RELS.length
const extra = res.learned.length - RELS.length
const behaviourallyComplete = behavioural === res.learned.length

for (const c of res.perCheck) {
  console.log(`[${c.rel}] type=${c.type} honest=${c.passHonest ? 'P' : 'F'} alt=${c.passAlt ? 'P' : 'F'} ownGamed=[${c.failsOwnGamed1 ? 'caught' : 'MISS'},${c.failsOwnGamed2 ? 'caught' : 'MISS'}] ignoresOther=[${c.ignoresOtherGamed1 ? 'ok' : 'LEAK'},${c.ignoresOtherGamed2 ? 'ok' : 'LEAK'}] ${c.fullProof ? '✓ proven' : '✗ not proven'}`)
  console.log(`   ${c.cmd}`)
}
if (res.learned.length === 0) console.log(`   nothing admitted — rejected: ${res.rejected.join(' | ') || '(none)'}`)

console.log('\n=== aggregate ===')
console.log(`per-file proven: ${provenFiles}/${RELS.length} files have a fully-proven check (attribution + behavioural + non-brittle)  ← the elicitation criterion`)
console.log(`emission:        ${res.learned.length} admitted scope check(s)${extra > 0 ? ` (${extra} extra beyond one-per-file — a real model may propose several; reported, not penalized)` : ''}; rels correct (a+b, no unknown): ${relsCorrect ? 'yes' : 'NO'}`)
console.log(`  attribution:   ${attributed}/${res.learned.length} fail OWN file's gaming, pass the OTHER file's gaming`)
console.log(`  behavioural:   ${behavioural}/${res.learned.length} fail BOTH textual gamed variants${behaviourallyComplete ? '' : '  ← an extra admit-passing check misses a synthetic 2nd-variant bug (admit tests vs ONE snapshot, not siblings)'}`)
console.log(`strategy (diagnostic, not gated): ${res.perCheck.map((c) => `${c.rel}=${c.type}`).join(', ') || '(none)'}`)
console.log(`both-gamed VETO (regression): ${res.bothGamedVeto ? 'yes' : 'NO'}`)
console.log(`spend: ${formatSpend({ tokens: res.tokens, costUsd: res.costUsd })}  (${STUB ? 'expect 0' : 'expect >0'}: ${spendOK ? 'ok' : 'UNEXPECTED'})`)

const ok = allFilesProven && relsCorrect && res.bothGamedVeto && spendOK
console.log(
  ok
    ? `\nreading: ${STUB ? '(stub) harness OK — ready for the paid run.' : `NON-NULL — a real ${model}`} proposed a usable per-file check for EVERY gamed file (${provenFiles}/${RELS.length});\neach proven check is ATTRIBUTED to its own file, BEHAVIOURAL (catches two textually-different bugs), and NON-BRITTLE.\nMulti-file scope elicitation is${STUB ? '' : ' real,'} not a vanity green.${behaviourallyComplete ? '' : ` (One extra check passed admit but missed a synthetic 2nd-variant bug — a noted admit-gate limit, not an elicitation failure.)`}`
    : `\nreading: NOT fully proven — allFilesProven=${allFilesProven} (${provenFiles}/${RELS.length}) relsCorrect=${relsCorrect} bothGamedVeto=${res.bothGamedVeto} spendOK=${spendOK}. Inspect the per-file lines${STUB ? ' (harness issue before spending)' : ''}.`,
)
process.exit(ok ? 0 : 1)
