// test/forge-scope-hook.test.mjs — Brick 2 (produce): the scope Forge hook learns a per-file check from a
// repo gaming, materializing good/bad SHAs into held worktrees. Stub proposer -> $0 (no model).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { runScopeForgeHook } from '../src/forge/scope-hook.mjs'
import { loadStore } from '../src/forge/store.mjs'

const IO_ASSERT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scorers', 'io-assert.mjs')
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()

// gamed (HEAD~1) then honest (HEAD): the recovery the Forge fires on. badSha = the gamed commit.
const setupRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-hook-'))
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'm.mjs'), 'export const f = (n) => n * 3\n'); writeFileSync(join(dir, 'keep.txt'), 'k')
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'gamed')
  const gamedSha = git(dir, 'rev-parse', 'HEAD')
  writeFileSync(join(dir, 'src', 'm.mjs'), 'export const f = (n) => n * 2\n')
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'honest')
  return { dir, gamedSha }
}
const stubPropose = async () => ({ text: JSON.stringify({ candidates: [{ scorerId: 'io-assert', args: ['--fn', 'f', '--case', '2=>4'], rationale: 'honest n*2 -> 4, gamed n*3 -> 6' }] }) })

test('runScopeForgeHook learns a per-file scope check from a repo gaming (produce)', async () => {
  const { dir, gamedSha } = setupRepo()
  const storePath = join(mkdtempSync(join(tmpdir(), 'st-')), 'checks.json')
  const cfg = { forge: true, forgeStorePath: storePath, scorerAllow: [IO_ASSERT], model: 'sonnet' }
  const state = { goal: 'f doubles n', artifact_path: dir, last_critique: '', confirm_vetoed_at_pass: 0, history: [{ snapshot: gamedSha }] }
  const r = await runScopeForgeHook({ cfg, state, loopDir: dir }, { propose: stubPropose })
  assert.equal(r.admitted.length, 1)
  const checks = loadStore(storePath).checks
  assert.equal(checks[0].kind, 'scope')
  assert.match(checks[0].cmd, /--rel 'src\/m\.mjs'/) // rel is shq-quoted (safe)
})

test('runScopeForgeHook skips (MVP) when more than one file changed', async () => {
  const { dir, gamedSha } = setupRepo()
  writeFileSync(join(dir, 'keep.txt'), 'changed too'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'second file')
  const storePath = join(mkdtempSync(join(tmpdir(), 'st-')), 'checks.json')
  const cfg = { forge: true, forgeStorePath: storePath, scorerAllow: [IO_ASSERT], model: 'sonnet' }
  const state = { goal: 'g', artifact_path: dir, confirm_vetoed_at_pass: 0, history: [{ snapshot: gamedSha }] }
  const r = await runScopeForgeHook({ cfg, state, loopDir: dir }, { propose: stubPropose })
  assert.equal(r.skipped, true)
  assert.equal(r.admitted.length, 0)
})

test('runScopeForgeHook refuses a non-SHA snapshot (trust boundary)', async () => {
  const { dir } = setupRepo()
  const storePath = join(mkdtempSync(join(tmpdir(), 'st-')), 'checks.json')
  const cfg = { forge: true, forgeStorePath: storePath, scorerAllow: [IO_ASSERT] }
  const state = { goal: 'g', artifact_path: dir, confirm_vetoed_at_pass: 0, history: [{ snapshot: '../evil' }] }
  const r = await runScopeForgeHook({ cfg, state, loopDir: dir }, { propose: stubPropose })
  assert.equal(r.skipped, true)
})
