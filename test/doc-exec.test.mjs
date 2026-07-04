// doc-exec is the EXECUTABLE-accuracy leg (doctest/rustdoc-style): fenced js examples in the doc are
// actually run — in the same locked-down out-of-process child the io-* scorers use — and a stale or wrong
// example turns the score red. Blocks that import nothing from the repo are illustrative, not claims:
// they leave the denominator. Zero runnable claims inherits the doc-coverage recall floor, never a free 100.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractJsBlocks, rewriteImports, judgeBlockObs } from '../scorers/doc-exec.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const scorer = join(here, '..', 'scorers', 'doc-exec.mjs')

// ---------- extractJsBlocks ----------

test('extracts js/javascript/mjs fences, ignores bash/text/plain fences', () => {
  const md = [
    '```js', 'const a = 1', '```', '',
    '```javascript', 'const b = 2', '```', '',
    '```mjs', 'const c = 3', '```', '',
    '```bash', 'echo not-js', '```', '',
    '```', 'plain fence', '```', '',
    '```text', "import { x } from './fake.mjs' // looks like code, is prose", '```',
  ].join('\n')
  const blocks = extractJsBlocks(md)
  assert.equal(blocks.length, 3)
  assert.match(blocks[0], /const a/)
  assert.match(blocks[2], /const c/)
})

// ---------- rewriteImports ----------

test('rewrites relative specifiers to file:// URLs under the repo and counts them', () => {
  const repo = '/tmp/fake repo' // space on purpose: URL must be percent-encoded
  const src = [
    "import { add } from './lib.mjs'",
    "import assert from 'node:assert/strict'",
    "import '../side-effect.mjs'",
    "const dyn = await import('./dyn.mjs')",
  ].join('\n')
  const { code, repoImports } = rewriteImports(src, repo)
  assert.equal(repoImports, 3)
  assert.match(code, /file:\/\/\/tmp\/fake%20repo\/lib\.mjs/)
  assert.match(code, /file:\/\/\/tmp\/side-effect\.mjs/) // ../ resolves OUT of repo dir name
  assert.match(code, /node:assert\/strict/) // builtins untouched
  assert.doesNotMatch(code, /'\.\/lib\.mjs'/)
})

test('a block with only builtin imports counts zero repo imports (illustrative, not a claim)', () => {
  const { repoImports } = rewriteImports("import assert from 'node:assert'\nassert.ok(true)", '/tmp/x')
  assert.equal(repoImports, 0)
})

test('a whole-line commented-out import is not a runnable claim (power-review MEDIUM)', () => {
  const src = "// import { add } from './lib.mjs'\nconst ok = true\nif (!ok) throw new Error('never')"
  const { repoImports } = rewriteImports(src, '/tmp/x')
  assert.equal(repoImports, 0)
})

// ---------- judgeBlockObs (pure observation -> verdict mapping) ----------

test('judgeBlockObs: ok+true passes; import failure and crashes fail; runtime floor is a scorer error', () => {
  assert.deepEqual(judgeBlockObs({ ok: true, results: [{ value: true }] }), { pass: true })
  assert.equal(judgeBlockObs({ ok: false, reason: 'import', error: 'boom' }).pass, false)
  assert.equal(judgeBlockObs({ ok: false, reason: 'no-frame', stderr: 'x' }).pass, false)
  assert.equal(judgeBlockObs({ ok: true, results: [{ threw: true, error: 'e' }] }).pass, false)
  assert.equal(judgeBlockObs({ ok: false, reason: 'runtime', error: 'node too old' }).scorerError, 'node too old')
})

// ---------- CLI end-to-end (real iso execution in tmp repos) ----------

const run = (args) => spawnSync('node', [scorer, ...args], { encoding: 'utf8' })

function tmpRepo({ manifest = true } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'docexec-'))
  writeFileSync(join(d, 'lib.mjs'), 'export const add = (a, b) => a + b\n')
  if (manifest) {
    mkdirSync(join(d, 'scorers'), { recursive: true })
    writeFileSync(join(d, 'scorers', 'doc-required.json'), JSON.stringify({
      docKind: 'readme',
      flags: ['--alpha', '--beta'],
      scorers: [], configKeys: [], modules: [],
      wordFloors: { desc: 4, prose: 8 },
    }))
  }
  return d
}

const PASSING = [
  '```js',
  "import { add } from './lib.mjs'",
  "import assert from 'node:assert/strict'",
  'assert.equal(add(2, 3), 5)',
  '```',
].join('\n')

const FAILING = [
  '```js',
  "import { add } from './lib.mjs'",
  "import assert from 'node:assert/strict'",
  'assert.equal(add(2, 3), 6) // stale claim: wrong expected value',
  '```',
].join('\n')

test('CLI: a correct runnable example scores 100', () => {
  const d = tmpRepo()
  try {
    writeFileSync(join(d, 'README.md'), `# doc\n\n${PASSING}\n`)
    const r = run(['--output', join(d, 'README.md'), '--repo', d])
    assert.equal(r.status, 0, r.stderr)
    const j = JSON.parse(r.stdout)
    assert.equal(j.score, 100)
    assert.match(j.critique, /1\/1/)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('CLI: a wrong example fails its block — one passing + one failing = 50', () => {
  const d = tmpRepo()
  try {
    writeFileSync(join(d, 'README.md'), `# doc\n\n${PASSING}\n\n${FAILING}\n`)
    const r = run(['--output', join(d, 'README.md'), '--repo', d])
    assert.equal(r.status, 0, r.stderr)
    const j = JSON.parse(r.stdout)
    assert.equal(j.score, 50)
    assert.equal(j.findings.length, 1)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('CLI: an import-nothing block is illustrative — zero runnable claims inherit the recall floor', () => {
  const d = tmpRepo()
  try {
    // README documents --alpha substantively but not --beta -> coverage floor = 50.
    writeFileSync(join(d, 'README.md'), [
      '# doc', '',
      'Use `--alpha` to enable the first stage of the pipeline during long runs.', '',
      '```js',
      "import assert from 'node:assert/strict'",
      'assert.ok(true) // imports nothing from the repo: not a doc claim',
      '```',
    ].join('\n'))
    const r = run(['--output', join(d, 'README.md'), '--repo', d])
    assert.equal(r.status, 0, r.stderr)
    const j = JSON.parse(r.stdout)
    assert.equal(j.score, 50)
    assert.match(j.critique, /no runnable examples/i)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('CLI: blocks beyond the execution cap stay in the DENOMINATOR — the score carries the signal (power-review MEDIUM)', () => {
  const d = tmpRepo()
  try {
    // 11 identical passing blocks: 10 execute, 1 is skipped by the cap. Score must be 10/11 = 90.91,
    // never a silent 100 — a consumer gating on score alone must see that a block went unproven.
    writeFileSync(join(d, 'README.md'), `# doc\n\n${Array(11).fill(PASSING).join('\n\n')}\n`)
    const r = run(['--output', join(d, 'README.md'), '--repo', d])
    assert.equal(r.status, 0, r.stderr)
    const j = JSON.parse(r.stdout)
    assert.equal(j.score, 90.91)
    assert.match(j.critique, /not executed/)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('CLI: zero runnable claims + missing manifest = scorer error (fail-closed, exit 2)', () => {
  const d = tmpRepo({ manifest: false })
  try {
    writeFileSync(join(d, 'README.md'), '# doc with no examples at all\n')
    const r = run(['--output', join(d, 'README.md'), '--repo', d])
    assert.equal(r.status, 2)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('CLI: --output is required', () => {
  const r = run([])
  assert.equal(r.status, 2)
})
