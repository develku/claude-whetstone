// test/forge-scope-hook.test.mjs — Brick 2 (produce): the scope Forge hook learns a per-file check from a
// repo gaming, materializing good/bad SHAs into held worktrees. Stub proposer -> $0 (no model).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { runScopeForgeHook, rankChangedFiles } from '../src/forge/scope-hook.mjs'
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

test('runScopeForgeHook learns per gamed file; admit filters a refactor-only (non-gamed) file', async () => {
  // Two code files change in the recovery: src/m.mjs is GAMED (n*3 -> n*2), src/same.mjs is a behaviour-
  // PRESERVING refactor (n+n -> n*2, both = n doubled). The stub proposes the same `f, 2=>4` check for each;
  // it discriminates on m.mjs (gamed f(2)=6 fails) but PASSES BOTH sides of same.mjs -> admit rejects it.
  const dir = mkdtempSync(join(tmpdir(), 'scope-mf-'))
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'm.mjs'), 'export const f = (n) => n * 3\n')
  writeFileSync(join(dir, 'src', 'same.mjs'), 'export const f = (n) => n + n\n')
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'gamed'); const gamedSha = git(dir, 'rev-parse', 'HEAD')
  writeFileSync(join(dir, 'src', 'm.mjs'), 'export const f = (n) => n * 2\n')
  writeFileSync(join(dir, 'src', 'same.mjs'), 'export const f = (n) => n * 2\n')
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'honest')
  const storePath = join(mkdtempSync(join(tmpdir(), 'st-')), 'checks.json')
  const cfg = { forge: true, forgeStorePath: storePath, scorerAllow: [IO_ASSERT], model: 'sonnet' }
  const state = { goal: 'g', artifact_path: dir, last_critique: '', confirm_vetoed_at_pass: 0, history: [{ snapshot: gamedSha }] }
  const r = await runScopeForgeHook({ cfg, state }, { propose: stubPropose, log: () => {} })
  assert.equal(r.admitted.length, 1) // only src/m.mjs — same.mjs passes BOTH sides, so admit rejects it
  assert.equal(r.coverageComplete, true)
  assert.equal(r.perFile.find((p) => p.rel === 'src/m.mjs').status, 'admitted')
  assert.equal(r.perFile.find((p) => p.rel === 'src/same.mjs').status, 'none') // ran, learned nothing
  assert.equal(loadStore(storePath).checks.filter((c) => c.kind === 'scope').length, 1)
})

// two code files BOTH gamed->honest (for cap + partial-error tests)
const setupTwoGamed = () => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-cap-'))
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const f = (n) => n * 3\n')
  writeFileSync(join(dir, 'src', 'b.mjs'), 'export const f = (n) => n * 3\n')
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'gamed'); const gamedSha = git(dir, 'rev-parse', 'HEAD')
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const f = (n) => n * 2\n')
  writeFileSync(join(dir, 'src', 'b.mjs'), 'export const f = (n) => n * 2\n')
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'honest')
  return { dir, gamedSha }
}

test('runScopeForgeHook caps learning at --forge-max-files and surfaces skipped files (coverage incomplete)', async () => {
  const { dir, gamedSha } = setupTwoGamed()
  const storePath = join(mkdtempSync(join(tmpdir(), 'st-')), 'checks.json')
  const cfg = { forge: true, forgeStorePath: storePath, scorerAllow: [IO_ASSERT], model: 'sonnet', forgeMaxFiles: 1 }
  const state = { goal: 'g', artifact_path: dir, last_critique: '', confirm_vetoed_at_pass: 0, history: [{ snapshot: gamedSha }] }
  const logs = []
  const r = await runScopeForgeHook({ cfg, state }, { propose: stubPropose, log: (m) => logs.push(m) })
  assert.equal(r.coverageComplete, false)
  assert.deepEqual(r.skippedFiles.map((s) => s.rel), ['src/b.mjs']) // a.mjs rank-0, b.mjs capped
  assert.equal(r.admitted.length, 1)
  assert.match(logs[0], /coverage incomplete/)
})

test('runScopeForgeHook isolates a per-file failure (status:error) and still learns the others', async () => {
  const { dir, gamedSha } = setupTwoGamed()
  const storePath = join(mkdtempSync(join(tmpdir(), 'st-')), 'checks.json')
  const cfg = { forge: true, forgeStorePath: storePath, scorerAllow: [IO_ASSERT], model: 'sonnet' }
  const state = { goal: 'g', artifact_path: dir, last_critique: '', confirm_vetoed_at_pass: 0, history: [{ snapshot: gamedSha }] }
  let n = 0
  const runForge = async () => { n++; if (n === 2) throw new Error('boom'); return { admitted: [{ cmd: 'x', target: 100 }], rejected: [], candidates: [], costUsd: 0, tokens: 0 } }
  const r = await runScopeForgeHook({ cfg, state }, { runForge, pruneFlaky: async () => [], log: () => {} })
  assert.equal(r.perFile.length, 2)
  assert.equal(r.perFile.filter((p) => p.status === 'error').length, 1)
  assert.equal(r.admitted.length, 1)
})

test('runScopeForgeHook refuses a non-SHA snapshot (trust boundary)', async () => {
  const { dir } = setupRepo()
  const storePath = join(mkdtempSync(join(tmpdir(), 'st-')), 'checks.json')
  const cfg = { forge: true, forgeStorePath: storePath, scorerAllow: [IO_ASSERT] }
  const state = { goal: 'g', artifact_path: dir, confirm_vetoed_at_pass: 0, history: [{ snapshot: '../evil' }] }
  const r = await runScopeForgeHook({ cfg, state, loopDir: dir }, { propose: stubPropose })
  assert.equal(r.skipped, true)
})

test('rankChangedFiles orders code before non-code, then by path (stable, never drops)', () => {
  const out = rankChangedFiles(['z.md', 'src/b.mjs', 'a.json', 'src/a.mjs'])
  assert.deepEqual(out, ['src/a.mjs', 'src/b.mjs', 'a.json', 'z.md'])
  assert.equal(rankChangedFiles(['x.txt']).length, 1) // never drops
})
