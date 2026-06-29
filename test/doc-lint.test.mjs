import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extractRefs, lintDoc, isCheckableRef, refResolves } from '../scorers/doc-lint.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const scorer = join(here, '..', 'scorers', 'doc-lint.mjs')

// ── extractRefs: which paths in a doc are real, checkable repo references ──────

test('extractRefs picks repo paths from a non-shell fenced block, skips glob patterns', () => {
  const md = ['```', 'src/gate.mjs        the gate    test/gate.test.mjs', 'src/converge*.mjs   alpha glob', '```'].join('\n')
  const refs = extractRefs(md)
  assert.deepEqual(refs, ['src/gate.mjs', 'test/gate.test.mjs'])
})

test('extractRefs skips paths inside shell blocks (illustrative command examples)', () => {
  // src/thing.mjs is a fictional example artifact — a bash block must NOT be linted as a real ref
  const md = ['```bash', 'node src/driver.mjs --artifact src/thing.mjs', '```'].join('\n')
  assert.deepEqual(extractRefs(md), [])
})

test('extractRefs picks markdown-link hrefs but skips anchors and external urls', () => {
  const md = 'see [design](docs/orchestrator-design.md), [stable](#whats-stable), [home](https://x.io/y.md)'
  assert.deepEqual(extractRefs(md), ['docs/orchestrator-design.md'])
})

test('extractRefs picks html src/href attributes', () => {
  const md = '<img src="assets/logo.svg"> <a href="docs/x.md">x</a>'
  assert.deepEqual(extractRefs(md).sort(), ['assets/logo.svg', 'docs/x.md'])
})

test('extractRefs dedupes a path referenced twice', () => {
  const md = ['```', 'src/gate.mjs', '```', 'and again [g](src/gate.mjs)'].join('\n')
  assert.deepEqual(extractRefs(md), ['src/gate.mjs'])
})

test('isCheckableRef rejects a path-traversal ref (no out-of-repo existence oracle)', () => {
  // a model-authored doc must not be able to probe the filesystem outside --repo via `..`
  assert.equal(isCheckableRef('../sibling/secret.mjs'), false)
  assert.equal(isCheckableRef('src/../../outside.txt'), false)
  assert.equal(isCheckableRef('a/b/../../../escape.mjs'), false)
  assert.equal(isCheckableRef('src/gate.mjs'), true) // a clean repo-relative ref still passes
  assert.equal(isCheckableRef('a..b/file.mjs'), true) // ".." not a path segment — a valid filename
})

test('extractRefs excludes traversal refs from a fenced block and a link', () => {
  const md = ['```', 'src/real.mjs', '../escape.mjs', '```', '[x](src/../../oops.mjs)'].join('\n')
  assert.deepEqual(extractRefs(md), ['src/real.mjs'])
})

test('extractRefs is not catastrophically slow on a pathological slash-run (ReDoS bound)', () => {
  // a ~100KB single fenced line of slash-separated tokens with NO terminal extension forced the old
  // PATH_TOKEN regex into O(n^2) backtracking (80KB ≈ 8s). The bounded quantifier must keep it linear.
  const md = '```\nsrc/' + 'abc/'.repeat(25000) + '\n```'
  const t0 = performance.now()
  const refs = extractRefs(md)
  const ms = performance.now() - t0
  assert.ok(ms < 2000, `extractRefs took ${ms.toFixed(0)}ms — must stay bounded, was O(n^2)`)
  assert.deepEqual(refs, []) // no terminal .ext -> no checkable ref (behavior unchanged)
})

test('extractRefs still matches multi-dot filenames after the ReDoS bound (token-identity)', () => {
  const md = '```\ntest/doc-lint.test.mjs   a.b.c/x.y.z.json   src/io-effect.mjs\n```'
  assert.deepEqual(extractRefs(md).sort(), ['a.b.c/x.y.z.json', 'src/io-effect.mjs', 'test/doc-lint.test.mjs'])
})

// ── lintDoc: score = fraction of checkable claims that hold ────────────────────

test('lintDoc scores 100 when every ref exists and the version is advertised', () => {
  const md = '```\nsrc/a.mjs\nsrc/b.mjs\n```\nStatus: v1.0.0'
  const r = lintDoc(md, { version: '1.0.0', exists: () => true })
  assert.equal(r.score, 100)
  assert.match(r.critique, /check out/)
  assert.deepEqual(r.findings, [])
})

test('lintDoc drops the score for a missing ref and names it in critique + findings', () => {
  const md = '```\nsrc/real.mjs\nsrc/ghost.mjs\n```\nv1.0.0'
  const r = lintDoc(md, { version: '1.0.0', exists: (ref) => ref === 'src/real.mjs' })
  // 2 file refs + 1 version = 3 claims, 1 broken → 2/3
  assert.equal(r.score, 66.67)
  assert.match(r.critique, /src\/ghost\.mjs/)
  assert.equal(r.findings.length, 1)
  assert.equal(r.findings[0].severity, 'high')
})

test('lintDoc counts a stale version as a broken claim', () => {
  const md = '```\nsrc/a.mjs\n```\nStatus: v1.0.0'
  // package.json moved to 2.0.0 but the doc still says v1.0.0
  const r = lintDoc(md, { version: '2.0.0', exists: () => true })
  assert.equal(r.score, 50) // 1 good ref of (1 ref + 1 version) claims
  assert.match(r.critique, /2\.0\.0/)
})

test('lintDoc version check is boundary-anchored — v1.0.0.1 does not satisfy a 1.0.0 claim', () => {
  // substring match would falsely pass; a doc must advertise the exact version, not a superstring
  const r = lintDoc('built from v1.0.0.1', { version: '1.0.0', exists: () => true })
  assert.equal(r.score, 0) // the only claim (version) is unmet
  assert.match(r.critique, /1\.0\.0/)
})

test('lintDoc scores 100 when there is nothing checkable to contradict', () => {
  const r = lintDoc('just prose, no refs', { version: undefined, exists: () => true })
  assert.equal(r.score, 100)
})

// ── refResolves: existence check is repo-contained (realpath) + percent-decoded ─

test('refResolves does NOT follow an in-repo symlink to a target outside the repo (closes the existence oracle)', () => {
  const repo = tmp()
  const outside = tmp()
  try {
    writeFileSync(join(outside, 'secret.txt'), 'x')
    symlinkSync(outside, join(repo, 'ext')) // in-repo symlink pointing OUTSIDE the repo
    // ext/secret.txt resolves to a real EXTERNAL file — must be treated as absent, never confirmed
    assert.equal(refResolves(repo, 'ext/secret.txt'), false)
    mkdirSync(join(repo, 'src'))
    writeFileSync(join(repo, 'src', 'real.mjs'), '')
    assert.equal(refResolves(repo, 'src/real.mjs'), true) // a genuine in-repo file still resolves
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('refResolves percent-decodes a link target before checking existence (spec-correct encoded path)', () => {
  const repo = tmp()
  try {
    mkdirSync(join(repo, 'docs'))
    writeFileSync(join(repo, 'docs', 'a b.md'), 'x') // a real file whose name contains a space
    assert.equal(refResolves(repo, 'docs/a%20b.md'), true) // the only CommonMark-correct way to link it
    assert.equal(refResolves(repo, 'docs/ghost%20x.md'), false) // encoded but genuinely missing → absent
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('refResolves finds a real file whose name contains a LITERAL %XX (raw link must not be decode-mangled)', () => {
  const repo = tmp()
  try {
    mkdirSync(join(repo, 'docs'))
    writeFileSync(join(repo, 'docs', 'report-50%20done.md'), 'x') // real file literally named with %20
    writeFileSync(join(repo, 'docs', 'data%2Fexport.json'), '{}') // %2F would decode to an invented slash
    assert.equal(refResolves(repo, 'docs/report-50%20done.md'), true)
    assert.equal(refResolves(repo, 'docs/data%2Fexport.json'), true)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('refResolves blocks percent-encoded `..` traversal (decoded .. cannot escape the repo)', () => {
  const base = tmp()
  const repo = join(base, 'repo')
  try {
    mkdirSync(repo)
    writeFileSync(join(base, 'outside.md'), 'x') // sibling of repo, OUTSIDE it
    assert.equal(refResolves(repo, '%2e%2e%2foutside.md'), false) // decodes to ../outside.md
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// ── CLI contract: --output JSON to stdout, exit 0 ok / exit 2 scorer-error ─────

const tmp = () => mkdtempSync(join(tmpdir(), 'doclint-'))

test('CLI scores 100 on a doc whose refs all exist and version matches package.json', () => {
  const d = tmp()
  try {
    mkdirSync(join(d, 'src'))
    writeFileSync(join(d, 'src', 'real.mjs'), '')
    writeFileSync(join(d, 'package.json'), JSON.stringify({ version: '3.1.0' }))
    writeFileSync(join(d, 'README.md'), '```\nsrc/real.mjs\n```\nStatus: v3.1.0')
    const r = spawnSync('node', [scorer, '--output', join(d, 'README.md'), '--repo', d], { encoding: 'utf8' })
    assert.equal(r.status, 0)
    assert.equal(JSON.parse(r.stdout).score, 100)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('CLI drops the score and reports the dangling ref (exit 0)', () => {
  const d = tmp()
  try {
    writeFileSync(join(d, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    writeFileSync(join(d, 'README.md'), '```\nsrc/ghost.mjs\n```\nv1.0.0')
    const r = spawnSync('node', [scorer, '--output', join(d, 'README.md'), '--repo', d], { encoding: 'utf8' })
    assert.equal(r.status, 0)
    const j = JSON.parse(r.stdout)
    assert.ok(j.score < 100)
    assert.match(j.critique, /ghost\.mjs/)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('CLI exits 2 (scorer error) when --output cannot be read', () => {
  const r = spawnSync('node', [scorer, '--output', '/no/such/doc.md'], { encoding: 'utf8' })
  assert.equal(r.status, 2)
})
