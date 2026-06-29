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

test('runScopeForgeHook SKIPS when good/bad SHAs differ but the trees are identical (no changed files)', async () => {
  // a same-tree/different-SHA pair (an --allow-empty recovery commit, or a revert-to-identical): gitDiffNames
  // returns [] and the fire must short-circuit, NOT iterate an empty learnSet and falsely report
  // coverageComplete with nothing learned.
  const dir = mkdtempSync(join(tmpdir(), 'scope-hook-empty-'))
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'm.mjs'), 'export const f = (n) => n * 2\n')
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'gamed'); const gamedSha = git(dir, 'rev-parse', 'HEAD')
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'honest') // HEAD tree === gamedSha tree -> empty diff
  const storePath = join(mkdtempSync(join(tmpdir(), 'st-')), 'checks.json')
  const cfg = { forge: true, forgeStorePath: storePath, scorerAllow: [IO_ASSERT], model: 'sonnet' }
  const state = { goal: 'g', artifact_path: dir, last_critique: '', confirm_vetoed_at_pass: 0, history: [{ snapshot: gamedSha }] }
  const r = await runScopeForgeHook({ cfg, state }, { propose: stubPropose, log: () => {} })
  assert.equal(r.skipped, true)
  assert.match(JSON.stringify(r), /no changed files/) // the empty-diff branch, distinct from the non-SHA guard
})

test('rankChangedFiles orders code before non-code, then by path (stable, never drops)', () => {
  const out = rankChangedFiles(['z.md', 'src/b.mjs', 'a.json', 'src/a.mjs'])
  assert.deepEqual(out, ['src/a.mjs', 'src/b.mjs', 'a.json', 'z.md'])
  assert.equal(rankChangedFiles(['x.txt']).length, 1) // never drops
})

// --- frontier 2a on scope: corroborate-on-scope ---

const writeOracle = (body) => { const p = join(mkdtempSync(join(tmpdir(), 'oracle-')), 'oracle.mjs'); writeFileSync(p, body); return `node ${p}` }

test('corroborate-on-scope: a disputing oracle declines the WHOLE fire (no learning, no prune)', async () => {
  const { dir, gamedSha } = setupRepo()
  const storePath = join(mkdtempSync(join(tmpdir(), 'st-')), 'checks.json')
  const cfg = { forge: true, forgeStorePath: storePath, scorerAllow: [IO_ASSERT], forgeOracleCmds: ['node oracle'] }
  const state = { goal: 'g', artifact_path: dir, last_critique: '', confirm_vetoed_at_pass: 0, history: [{ snapshot: gamedSha }] }
  let pruned = false
  const corroborate = async () => ({ corroborated: false, conflicts: [{ oracleCmd: 'node oracle', reason: 'rejects good' }], excluded: [] })
  const r = await runScopeForgeHook({ cfg, state }, { propose: stubPropose, corroborate, pruneFlaky: async () => { pruned = true; return [] }, log: () => {} })
  assert.equal(r.corroborated, false)
  assert.equal(r.admitted.length, 0)
  assert.equal(r.conflicts.length, 1)
  assert.equal(r.coverageComplete, false) // not "cap did not truncate" — learning never ran
  assert.deepEqual(r.perFile, [])
  assert.equal(pruned, false) // decline returns BEFORE prune (auto-retirement trusts goodArtifact — the disputed label)
  assert.equal(loadStore(storePath).checks.length, 0)
})

test('corroborate-on-scope: a flaky oracle is excluded (non-blocking) — learning still proceeds', async () => {
  const { dir, gamedSha } = setupRepo()
  const storePath = join(mkdtempSync(join(tmpdir(), 'st-')), 'checks.json')
  const cfg = { forge: true, forgeStorePath: storePath, scorerAllow: [IO_ASSERT] }
  const state = { goal: 'g', artifact_path: dir, last_critique: '', confirm_vetoed_at_pass: 0, history: [{ snapshot: gamedSha }] }
  const corroborate = async () => ({ corroborated: true, conflicts: [], excluded: [{ oracleCmd: 'node flaky', reason: 'not reproducible' }] })
  const r = await runScopeForgeHook({ cfg, state }, { propose: stubPropose, corroborate, log: () => {} })
  assert.equal(r.corroborated, true)
  assert.equal(r.admitted.length, 1)
  assert.deepEqual(r.excluded.map((e) => e.oracleCmd), ['node flaky']) // surfaced, non-blocking
})

test('corroborate-on-scope: a real repo-relative oracle runs with cwd=worktree (agrees -> learns)', async () => {
  const { dir, gamedSha } = setupRepo()
  // The oracle reads src/m.mjs RELATIVE TO CWD (not via --output). It only resolves correctly if the oracle
  // runs with cwd = the materialized worktree — guarding the cwd fix. honest worktree -> 'n * 2' -> 100 (accepts
  // good); gamed worktree -> 'n * 3' -> 0 (rejects bad) => the oracle AGREES with the veto => learning proceeds.
  const oracle = writeOracle("import { readFileSync } from 'node:fs'\nlet s = -1\ntry { s = readFileSync('src/m.mjs', 'utf8').includes('* 2') ? 100 : 0 } catch {}\nprocess.stdout.write(JSON.stringify({ score: s, critique: '', findings: [] }))\n")
  const storePath = join(mkdtempSync(join(tmpdir(), 'st-')), 'checks.json')
  const cfg = { forge: true, forgeStorePath: storePath, scorerAllow: [IO_ASSERT], forgeOracleCmds: [oracle] }
  const state = { goal: 'g', artifact_path: dir, last_critique: '', confirm_vetoed_at_pass: 0, history: [{ snapshot: gamedSha }] }
  const r = await runScopeForgeHook({ cfg, state }, { propose: stubPropose, log: () => {} })
  assert.equal(r.corroborated, true) // false here would mean the oracle read the wrong tree (cwd bug)
  assert.equal(r.admitted.length, 1)
})

test('corroborate-on-scope: a real oracle that rejects the good artifact declines the fire', async () => {
  const { dir, gamedSha } = setupRepo()
  const oracle = writeOracle("process.stdout.write(JSON.stringify({ score: 0, critique: '', findings: [] }))\n") // always rejects
  const storePath = join(mkdtempSync(join(tmpdir(), 'st-')), 'checks.json')
  const cfg = { forge: true, forgeStorePath: storePath, scorerAllow: [IO_ASSERT], forgeOracleCmds: [oracle] }
  const state = { goal: 'g', artifact_path: dir, last_critique: '', confirm_vetoed_at_pass: 0, history: [{ snapshot: gamedSha }] }
  const r = await runScopeForgeHook({ cfg, state }, { propose: stubPropose, log: () => {} })
  assert.equal(r.corroborated, false)
  assert.equal(r.admitted.length, 0)
  assert.equal(r.conflicts.length, 1)
  assert.equal(loadStore(storePath).checks.length, 0)
})
