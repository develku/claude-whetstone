// doc-coverage is the RECALL mirror of doc-lint's precision check: doc-lint walks refs IN the doc and asks
// "does the repo have this?"; doc-coverage walks the committed required set and asks "does the doc DESCRIBE
// this?". These tests encode the anti-gaming core: a bare name-drop (list item, code fence) never counts as
// "documented" — only a substantive mention (table row with a real description cell / heading with a body /
// prose line clearing the word floor) does, and matching is boundary-anchored so `--observe-foo` can't
// satisfy `--observe`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { substantiveMention, scoreCoverage, loadRequired, stripFences } from '../scorers/doc-coverage.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const scorer = join(here, '..', 'scorers', 'doc-coverage.mjs')
const FLOORS = { desc: 4, prose: 8 }

// ---------- substantiveMention: the anti-name-drop predicate ----------

test('bare-list name-drop does NOT count as documented', () => {
  const md = '# flags\n\n- `--observe`\n- `--cap`\n- `--target`\n'
  assert.equal(substantiveMention(md, '--observe', FLOORS), false)
})

test('sub-floor filler in a table description cell does NOT count', () => {
  const md = '| flag | what |\n|---|---|\n| `--observe` | runs it |\n'
  assert.equal(substantiveMention(md, '--observe', FLOORS), false) // 2 words < desc floor 4
})

test('a genuine table row with a >=desc-word description cell counts', () => {
  const md = '| flag | what |\n|---|---|\n| `--observe <cmd>` | gather fresh evidence before every scoring pass |\n'
  assert.equal(substantiveMention(md, '--observe', FLOORS), true)
})

test('a table row whose description REPEATS the token (a command example) still counts — and token-only junk still fails', () => {
  // whet-run false negative: `--forge-retire`'s row shows the full command in its description cell, which
  // used to disqualify the cell as "contains the token". Words are counted across the whole row AFTER
  // stripping every required token, so a real description passes and token-echo junk still cannot.
  const real = '| `--forge-retire` | run `node src/driver.mjs --forge-retire --check` to tombstone a learned check |\n'
  assert.equal(substantiveMention(real, '--forge-retire', FLOORS), true)
  const junk = '| `--observe` | `--observe` `--observe` |\n'
  assert.equal(substantiveMention(junk, '--observe', FLOORS), false)
})

test('a prose sentence clearing the prose word floor counts', () => {
  const md = 'Pass `--observe` to run a shell command before each pass so the editor sees fresh evidence.\n'
  assert.equal(substantiveMention(md, '--observe', FLOORS), true)
})

test('a heading whose body clears the prose floor counts; an empty heading does not', () => {
  const withBody = '### `--observe`\n\nRuns a shell command before each scoring pass so the critique reflects live state.\n'
  const emptyHeading = '### `--observe`\n\n### next section\n\nsome unrelated body text that belongs to the next heading entirely.\n'
  assert.equal(substantiveMention(withBody, '--observe', FLOORS), true)
  assert.equal(substantiveMention(emptyHeading, '--observe', FLOORS), false)
})

test('a mention ONLY inside a code fence never counts (any language)', () => {
  const md = 'Usage:\n\n```bash\nnode driver.mjs --observe "npm test" --cap 10 and eight more words here\n```\n'
  assert.equal(substantiveMention(md, '--observe', FLOORS), false)
})

test('word-count stuffing is dead: repeated/nonsense filler never clears a floor (distinct words count)', () => {
  // power-review HIGH: raw word counts let '| `--observe` | the the the the |' pass. Floors count DISTINCT words.
  assert.equal(substantiveMention('| `--observe` | the the the the |\n', '--observe', FLOORS), false)
  assert.equal(substantiveMention('| `--observe` | aa aa aa aa |\n', '--observe', FLOORS), false)
  assert.equal(substantiveMention('- `--cap` blah blah blah blah blah blah blah blah\n', '--cap', FLOORS), false)
})

test('cross-token dump is dead: one filler line naming many required tokens satisfies none of them', () => {
  // power-review HIGH: other required tokens must not count as description words for THIS token.
  const dump = 'Flags: `--cap` `--observe` `--target` `--budget` `--model` `--effort` tune the loop.\n'
  const all = ['--cap', '--observe', '--target', '--budget', '--model', '--effort']
  for (const t of all) assert.equal(substantiveMention(dump, t, FLOORS, all), false)
  // ...while a real per-item description still passes even with the full token list supplied.
  const real = 'Pass `--observe` to run a shell command before each pass so evidence stays fresh.\n'
  assert.equal(substantiveMention(real, '--observe', FLOORS, all), true)
})

test('boundary anchoring: --observe-foo does not satisfy --observe; xbudgetTokens does not satisfy budgetTokens', () => {
  const md1 = 'The `--observe-foo` flag gathers fresh evidence before every single scoring pass runs.\n'
  assert.equal(substantiveMention(md1, '--observe', FLOORS), false)
  const md2 = 'Set xbudgetTokens in the config to hold the loop under a strict total-token ceiling.\n'
  assert.equal(substantiveMention(md2, 'budgetTokens', FLOORS), false)
})

test('a module mention with .mjs suffix and a path prefix counts', () => {
  const md = 'The `src/blast-radius.mjs` guard reverts any sibling file the editor touches during a pass.\n'
  assert.equal(substantiveMention(md, 'blast-radius', FLOORS), true)
})

test('stripFences removes every fenced block but keeps inline code', () => {
  const md = 'keep `--cap` here\n```js\ndrop --cap here\n```\ntail\n'
  const out = stripFences(md)
  assert.match(out, /keep `--cap` here/)
  assert.doesNotMatch(out, /drop/)
})

// ---------- scoreCoverage: the number the gate reads ----------

test('score = 100 * documented/required, missing items become findings', () => {
  const md = 'Pass `--observe` to run a shell command before each pass so evidence stays fresh.\n'
  const required = [
    { group: 'flags', token: '--observe' },
    { group: 'flags', token: '--cap' },
  ]
  const r = scoreCoverage(md, required, FLOORS)
  assert.equal(r.score, 50)
  assert.equal(r.findings.length, 1)
  assert.match(r.findings[0].suggestion, /--cap/)
  assert.match(r.critique, /1\/2/)
})

test('all documented -> 100 with an affirmative critique', () => {
  const md = 'Pass `--cap` to bound the number of paid passes the loop may ever spend running.\n'
  const r = scoreCoverage(md, [{ group: 'flags', token: '--cap' }], FLOORS)
  assert.equal(r.score, 100)
  assert.deepEqual(r.findings, [])
})

// ---------- loadRequired: fail-closed manifest loading ----------

test('loadRequired flattens the real committed manifest into grouped items', () => {
  const items = loadRequired(join(here, '..'))
  assert.ok(items.length >= 50, `expected >=50 required items, got ${items.length}`)
  assert.ok(items.some((i) => i.group === 'flags' && i.token === '--observe'))
  assert.ok(items.some((i) => i.group === 'modules' && i.token === 'blast-radius'))
})

test('loadRequired throws on a missing or empty manifest (fail-closed, never a free 100)', () => {
  const d = mkdtempSync(join(tmpdir(), 'doccov-'))
  try {
    assert.throws(() => loadRequired(d), /doc-required/)
    mkdirSync(join(d, 'scorers'), { recursive: true })
    writeFileSync(join(d, 'scorers', 'doc-required.json'), JSON.stringify({ docKind: 'readme', flags: [], scorers: [], configKeys: [], modules: [] }))
    assert.throws(() => loadRequired(d), /empty/)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

// ---------- CLI contract (spawnSync, like doc-lint's tests) ----------

const run = (args) => spawnSync('node', [scorer, ...args], { encoding: 'utf8' })

test('CLI: scores a doc against a tmp repo manifest and prints the scorer contract JSON', () => {
  const d = mkdtempSync(join(tmpdir(), 'doccov-'))
  try {
    mkdirSync(join(d, 'scorers'), { recursive: true })
    writeFileSync(join(d, 'scorers', 'doc-required.json'), JSON.stringify({
      docKind: 'readme',
      flags: ['--alpha', '--beta'],
      scorers: [], configKeys: [], modules: [],
      wordFloors: { desc: 4, prose: 8 },
    }))
    writeFileSync(join(d, 'README.md'), 'Use `--alpha` to enable the first stage of the pipeline during long runs.\n\n- `--beta`\n')
    const r = run(['--output', join(d, 'README.md'), '--repo', d])
    assert.equal(r.status, 0, r.stderr)
    const j = JSON.parse(r.stdout)
    assert.equal(j.score, 50)
    assert.equal(j.findings.length, 1)
    assert.match(j.critique, /--beta/)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('CLI: missing manifest exits 2 (scorer error), never a score', () => {
  const d = mkdtempSync(join(tmpdir(), 'doccov-'))
  try {
    writeFileSync(join(d, 'README.md'), 'hello\n')
    const r = run(['--output', join(d, 'README.md'), '--repo', d])
    assert.equal(r.status, 2)
    assert.match(String(r.stderr), /doc-required/)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('CLI: --output is required', () => {
  const r = run([])
  assert.equal(r.status, 2)
})
