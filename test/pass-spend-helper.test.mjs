import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { passSpend, initState, ensureLoopDir, loadState } from '../src/state.mjs'
import { scopeBuildContext } from '../src/scope-context.mjs'

// passSpend is the ONE shared spend-summing helper both persist twins call, so the driver
// (single-file) and scope/converge (repo) budget accounting can never drift again: each pass
// charges BOTH the editor (act) spend AND the scorer's own review.usage (an llm-judge scorer pays
// a second model call every pass). Before this, only the driver charged the scorer usage; a
// scope/converge run silently under-charged --budget/--budget-tokens (register C3-01 twin-drift).

test('passSpend sums the act spend and the scorer-reported usage', () => {
  const s = passSpend({ costUsd: 1.0, tokens: 200000, review: { usage: { costUsd: 0.32, tokens: 52696 } } })
  assert.equal(s.tokens, 252696)
  assert.ok(Math.abs(s.costUsd - 1.32) < 1e-9)
})

test('passSpend with a usage-less review returns act-only spend', () => {
  assert.deepEqual(passSpend({ costUsd: 0.5, tokens: 200000, review: { score: 50 } }), { costUsd: 0.5, tokens: 200000 })
})

test('passSpend charges 0 for non-numeric usage — never NaN', () => {
  const s = passSpend({ costUsd: 0.5, tokens: 100, review: { usage: { costUsd: 'x', tokens: null } } })
  assert.deepEqual(s, { costUsd: 0.5, tokens: 100 })
  assert.ok(!Number.isNaN(s.costUsd) && !Number.isNaN(s.tokens))
})

test('passSpend on a bare ev (no act spend, no review) is {0,0}', () => {
  assert.deepEqual(passSpend({}), { costUsd: 0, tokens: 0 })
})

// --- twin-path parity: scope persist must now charge the scorer usage the driver already did ---

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'whet-spend-'))
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't')
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'init')
  return dir
}
const stateFor = (scopeDir) => initState({ goal: 'g', artifactPath: scopeDir, scorerCmd: 'cat score.json #', targetScore: 90, hardCap: 5 })

test('scope persist charges the scorer review.usage to the recorded pass spend (twin-path parity)', () => {
  const scopeDir = tempRepo()
  const loopDir = mkdtempSync(join(tmpdir(), 'whet-loop-'))
  try {
    ensureLoopDir(loopDir)
    const { persist } = scopeBuildContext(loopDir)
    writeFileSync(join(scopeDir, 'src.js'), 'edited') // a pass's edit
    const next = persist(stateFor(scopeDir), {
      score: 80,
      critique: 'c',
      costUsd: 1.0, // editor (act) spend
      tokens: 200000,
      review: { score: 80, critique: 'c', usage: { costUsd: 0.32, tokens: 52696 } }, // the judge's own spend
    })
    assert.equal(next.spent_tokens, 252696) // was 200000 before the fix (scope dropped usage)
    assert.ok(Math.abs(next.spent_usd - 1.32) < 1e-9)
    assert.equal(loadState(loopDir).spent_tokens, 252696) // and it lands durably in state.json
  } finally {
    rmSync(scopeDir, { recursive: true, force: true }); rmSync(loopDir, { recursive: true, force: true })
  }
})
