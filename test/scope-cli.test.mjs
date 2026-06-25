import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseScopeCli, cleanTreeGuard, buildAllowlist, decomposeNeedsConfirm, decomposeNeedsBudget, scopeDeps } from '../src/scope-cli.mjs'

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()

test('parseScopeCli maps --scope to the artifact and parses --read-only', () => {
  const cfg = parseScopeCli(['node', 'scope-cli.mjs', 'make tests pass', '--scope', '/repo', '--scorer', 'npm test', '--read-only', 'test/,gate.txt', '--cap', '20'])
  assert.equal(cfg.goal, 'make tests pass')
  assert.equal(cfg.scope, '/repo')
  assert.equal(cfg.artifactPath, '/repo') // the scope dir IS the artifact the loop carries
  assert.equal(cfg.scorerCmd, 'npm test')
  assert.deepEqual(cfg.readOnly, ['test/', 'gate.txt'])
  assert.equal(cfg.hardCap, 20)
})

test('cleanTreeGuard refuses a dirty tree, allows a clean one (risk #2)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whet-guard-'))
  try {
    git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't')
    writeFileSync(join(dir, 'a.txt'), 'x'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init')
    assert.equal(cleanTreeGuard(dir).ok, true) // clean
    writeFileSync(join(dir, 'a.txt'), 'dirty')
    assert.equal(cleanTreeGuard(dir).ok, false) // uncommitted change -> refuse (reset --hard would clobber it)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cleanTreeGuard refuses a non-git path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whet-nogit-'))
  try {
    assert.equal(cleanTreeGuard(dir).ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseScopeCli: decompose flags', () => {
  const cfg = parseScopeCli(['node', 'scope-cli.mjs', 'g', '--scope', '/r', '--scorer', 'npm test', '--decompose', '--max-children', '2', '--child-cap', '4', '--scorer-allow', '/x/my.mjs'])
  assert.equal(cfg.decompose, true)
  assert.equal(cfg.maxChildren, 2)
  assert.equal(cfg.childCap, 4)
  assert.deepEqual(cfg.scorerAllow, ['/x/my.mjs'])
})

test('buildAllowlist: includes the built-in scorers and operator extras', () => {
  const m = buildAllowlist(['/extra/custom-judge.mjs'])
  assert.equal(m.has('test-pass-rate'), true)            // a shipped scorer
  assert.equal(m.get('custom-judge'), '/extra/custom-judge.mjs')
})

test('decomposeNeedsConfirm: --decompose requires --confirm-scorer [CR#7]', () => {
  assert.equal(decomposeNeedsConfirm({ decompose: true, confirmScorerCmd: null }), true)
  assert.equal(decomposeNeedsConfirm({ decompose: true, confirmScorerCmd: 'held-out' }), false)
  assert.equal(decomposeNeedsConfirm({ decompose: false, confirmScorerCmd: null }), false)
})

test('scopeDeps: --decompose injects a decompose actEscalated closure', () => {
  const deps = scopeDeps({ scope: '/r', readOnly: [], model: 'sonnet', effort: 'medium', escalateModel: 'opus', noEscalate: false, mcpConfig: null, decompose: true, maxChildren: 4, childCap: 3, scorerAllow: [], loopDir: '/r/.loop/x' })
  assert.equal(typeof deps.actEscalated, 'function')
})

test('decomposeNeedsBudget: --decompose requires --budget or --budget-tokens', () => {
  assert.equal(decomposeNeedsBudget({ decompose: true, budgetUsd: null, budgetTokens: null }), true)
  assert.equal(decomposeNeedsBudget({ decompose: true, budgetUsd: 2, budgetTokens: null }), false)
  assert.equal(decomposeNeedsBudget({ decompose: true, budgetUsd: null, budgetTokens: 100000 }), false)
  assert.equal(decomposeNeedsBudget({ decompose: false, budgetUsd: null, budgetTokens: null }), false)
})

test('buildAllowlist: excludes composite from the auto set; --scorer-allow can re-add it', () => {
  const m = buildAllowlist([])
  assert.equal(m.has('test-pass-rate'), true)
  assert.equal(m.has('composite'), false) // shell-executes manifest lines -> not an auto sub-gate
})
