import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { parseScorerList, parseSubResult, combine } from '../scorers/composite.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const composite = join(here, '..', 'scorers', 'composite.mjs')
const seq = join(here, 'fixtures', 'seq-scorer.mjs')

const runComposite = (manifestLines) => {
  const dir = mkdtempSync(join(tmpdir(), 'whet-composite-'))
  const file = join(dir, 'gate.txt')
  writeFileSync(file, manifestLines.join('\n'))
  return spawnSync('node', [composite, '--scorers-file', file, '--output', 'x', '--loop-dir', '.', '--pass', '0'], {
    encoding: 'utf8',
  })
}

// parseScorerList(fileText) -> [command, ...]: one raw sub-scorer command per line,
// trimmed; blank lines and #-comments dropped. This is the composite's gate manifest.
test('parseScorerList returns one command per non-blank, non-comment line', () => {
  const text = [
    '# the gate dimensions',
    'node scorers/test-pass-rate.mjs --cmd "node --test"',
    '',
    '   node scorers/llm-judge.mjs --rubric @sec.md   ',
    '# trailing comment',
  ].join('\n')
  assert.deepEqual(parseScorerList(text), [
    'node scorers/test-pass-rate.mjs --cmd "node --test"',
    'node scorers/llm-judge.mjs --rubric @sec.md',
  ])
})

test('parseScorerList returns [] when there are no real commands', () => {
  assert.deepEqual(parseScorerList('\n# only comments\n   \n'), [])
})

// parseSubResult(name, {status, stdout, stderr}) -> {score, critique, findings}.
// A broken dimension must NOT silently drop (that would let a green pass through on
// partial signal); it throws, and the CLI turns the throw into exit 2 so the driver halts.
test('parseSubResult parses a healthy sub-scorer result', () => {
  const res = { status: 0, stdout: JSON.stringify({ score: 60, critique: 'fix X', findings: [{ area: 'a' }] }) }
  assert.deepEqual(parseSubResult('sub-A', res), { score: 60, critique: 'fix X', findings: [{ area: 'a' }] })
})

test('parseSubResult defaults critique to "" and findings to [] when absent', () => {
  const r = parseSubResult('sub-A', { status: 0, stdout: JSON.stringify({ score: 100 }) })
  assert.equal(r.critique, '')
  assert.deepEqual(r.findings, [])
})

test('parseSubResult throws (naming the sub) on a non-zero exit', () => {
  const res = { status: 2, stdout: '', stderr: 'boom' }
  assert.throws(() => parseSubResult('sub-A', res), /sub-A/)
})

test('parseSubResult throws on a score outside 0..100', () => {
  const res = { status: 0, stdout: JSON.stringify({ score: 150 }) }
  assert.throws(() => parseSubResult('sub-A', res), /0\.\.100|range/)
})

test('parseSubResult throws on non-JSON stdout', () => {
  assert.throws(() => parseSubResult('sub-A', { status: 0, stdout: 'not json' }))
})

// combine(results) -> {score, critique, findings}: score is the MIN (the weakest
// dimension gates `done`); critique is the binding (min) sub-scorer's critique, prefixed
// with a one-line breakdown so the editor is steered at the currently-weakest dimension.
test('combine takes the min score and steers the critique at the binding dimension', () => {
  const out = combine([
    { score: 100, critique: 'tests pass', findings: [{ area: 't' }] },
    { score: 60, critique: 'unhandled NaN path', findings: [{ area: 's' }] },
  ])
  assert.equal(out.score, 60)
  assert.match(out.critique, /#0=100 #1=60/) // the breakdown
  assert.match(out.critique, /binding #1/) // names the weakest dimension
  assert.match(out.critique, /unhandled NaN path/) // and carries ITS critique, not #0's
  assert.deepEqual(out.findings, [{ area: 't' }, { area: 's' }]) // findings flattened
})

test('combine with a single sub-scorer is a passthrough of its score', () => {
  const out = combine([{ score: 82, critique: 'do Y', findings: [] }])
  assert.equal(out.score, 82)
  assert.match(out.critique, /binding #0/)
})

test('combine breaks ties on the first minimum', () => {
  const out = combine([
    { score: 60, critique: 'first', findings: [] },
    { score: 60, critique: 'second', findings: [] },
  ])
  assert.match(out.critique, /binding #0/)
  assert.match(out.critique, /first/)
})

// End-to-end: the CLI reads the manifest, forwards --output/--loop-dir/--pass to each
// sub-scorer, and prints the combined {score, critique, findings} — exit 0 on success.
test('composite (e2e) takes the min across sub-scorers and exits 0', () => {
  const r = runComposite([`node ${JSON.stringify(seq)} --scores 100`, `node ${JSON.stringify(seq)} --scores 60`])
  assert.equal(r.status, 0)
  const j = JSON.parse(r.stdout)
  assert.equal(j.score, 60)
  assert.match(j.critique, /#0=100 #1=60/)
})

test('composite (e2e) exits 2 when any sub-scorer fails (no silent drop)', () => {
  const r = runComposite([`node ${JSON.stringify(seq)} --scores 100`, `node -e "process.exit(2)"`])
  assert.equal(r.status, 2)
})

test('composite (e2e) exits 2 when --scorers-file is missing', () => {
  const r = spawnSync('node', [composite, '--output', 'x', '--loop-dir', '.', '--pass', '0'], { encoding: 'utf8' })
  assert.equal(r.status, 2)
})
