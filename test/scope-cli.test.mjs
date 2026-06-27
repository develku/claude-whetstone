import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseScopeCli, cleanTreeGuard, buildAllowlist, decomposeNeedsConfirm, decomposeNeedsBudget, scopeDeps, forgeStoreInsideScope, forgeNeedsStoreAndConfirm, forgeMaxFilesInvalid } from '../src/scope-cli.mjs'

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

test('buildAllowlist: excludes composite from the auto set AND refuses to re-add it via --scorer-allow', () => {
  const m = buildAllowlist([])
  assert.equal(m.has('test-pass-rate'), true)
  assert.equal(m.has('composite'), false) // shell-executes manifest lines -> not an auto sub-gate
  // A model-authored decompose finding can name a sub-gate id, so a command-executing scorer must NOT be
  // re-addable via --scorer-allow either (shared isUnsafeScorer with the Forge denylist). Dodges blocked too.
  assert.equal(buildAllowlist(['/x/composite.mjs']).has('composite'), false)
  assert.equal(buildAllowlist(['/x/composite.v2.mjs']).has('composite.v2'), false)
  assert.equal(buildAllowlist(['/x/Composite.mjs']).has('Composite'), false)
  // test-pass-rate IS a legitimate decompose sub-gate (a child's test command), so it stays allowed.
  assert.equal(buildAllowlist(['/x/test-pass-rate.mjs']).has('test-pass-rate'), true)
})

test('forgeStoreInsideScope: refuses a --forge-store located inside --scope (trust boundary)', () => {
  assert.equal(forgeStoreInsideScope({ forge: true, scope: '/r', forgeStorePath: '/r/.loop/checks.json' }), true)
  assert.equal(forgeStoreInsideScope({ forge: true, scope: '/r', forgeStorePath: '/elsewhere/checks.json' }), false)
  assert.equal(forgeStoreInsideScope({ forge: false, scope: '/r', forgeStorePath: '/r/checks.json' }), false) // no --forge
  assert.equal(forgeStoreInsideScope({ forge: true, scope: '/r' }), false) // no store path
})

test('forgeNeedsStoreAndConfirm: --forge on scope requires --forge-store and --confirm-scorer', () => {
  assert.equal(forgeNeedsStoreAndConfirm({ forge: true, forgeStorePath: '/s', confirmScorerCmd: 'c' }), false)
  assert.equal(forgeNeedsStoreAndConfirm({ forge: true, forgeStorePath: '/s' }), true) // no confirm
  assert.equal(forgeNeedsStoreAndConfirm({ forge: true, confirmScorerCmd: 'c' }), true) // no store
  assert.equal(forgeNeedsStoreAndConfirm({ forge: false }), false)
})

test('scopeDeps injects the scope Forge hook (runForgeHook) so a recovered-veto scope run can learn', () => {
  const deps = scopeDeps({ scope: '/r', readOnly: [], model: 'sonnet', effort: 'medium', escalateModel: 'opus', noEscalate: true, mcpConfig: null, decompose: false, scorerAllow: [], loopDir: '/r/.loop/x' })
  assert.equal(typeof deps.runForgeHook, 'function')
})

test('parseScopeCli parses --forge-max-files (scope multi-file learn cap)', () => {
  const cfg = parseScopeCli(['node', 'scope-cli.mjs', 'g', '--scope', '/r', '--scorer', 'npm test', '--forge-max-files', '3'])
  assert.equal(cfg.forgeMaxFiles, 3)
})

test('parseScopeCli leaves forgeMaxFiles undefined when --forge-max-files absent (hook default applies)', () => {
  const cfg = parseScopeCli(['node', 'scope-cli.mjs', 'g', '--scope', '/r', '--scorer', 'npm test'])
  assert.equal(cfg.forgeMaxFiles, undefined)
})

test('parseScopeCli parses --forge-max-files 0 as 0 (not silently undefined) so the guard can catch it', () => {
  const cfg = parseScopeCli(['node', 'scope-cli.mjs', 'g', '--scope', '/r', '--scorer', 'npm test', '--forge-max-files', '0'])
  assert.equal(cfg.forgeMaxFiles, 0)
})

test('forgeMaxFilesInvalid: refuses non-positive-integer --forge-max-files, allows positive/unset', () => {
  assert.equal(forgeMaxFilesInvalid({ forgeMaxFiles: undefined }), false) // unset -> hook default 8
  assert.equal(forgeMaxFilesInvalid({ forgeMaxFiles: 8 }), false)
  assert.equal(forgeMaxFilesInvalid({ forgeMaxFiles: 0 }), true)
  assert.equal(forgeMaxFilesInvalid({ forgeMaxFiles: -1 }), true)
  assert.equal(forgeMaxFilesInvalid({ forgeMaxFiles: 2.5 }), true)
  assert.equal(forgeMaxFilesInvalid({ forgeMaxFiles: NaN }), true) // 'abc' -> Number -> NaN
})
