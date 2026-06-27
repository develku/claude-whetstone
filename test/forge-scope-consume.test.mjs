// test/forge-scope-consume.test.mjs
// Brick 1 (consume) de-risking, per the codex review: prove a HAND-SEEDED scope check BITES on a scope run
// before any admission/generation. A scope check (per-file io-assert with --output=root + --rel) is composed
// (kind-filtered) into the scope confirm and run inside gitVerifyAt's pristine worktree: it passes the honest
// tree and vetoes a gamed tree that the base confirm alone would pass. $0 (real git, no model).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { emptyStore, addCheck, saveStore, checkStorePath } from '../src/forge/store.mjs'
import { composeConfirm } from '../src/forge/gate.mjs'
import { scopeBuildContext } from '../src/scope-context.mjs'
import { shq } from '../src/shq.mjs'

const IO_ASSERT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scorers', 'io-assert.mjs')
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()

const commit = (dir, mSrc, msg) => {
  writeFileSync(join(dir, 'src', 'm.mjs'), mSrc)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', msg)
  return git(dir, 'rev-parse', 'HEAD')
}

test('a seeded SCOPE check bites: passes the honest tree, vetoes a gamed tree (consume path)', async () => {
  // always-pass base confirm (ignores --output) so ONLY the seeded scope check can veto.
  const passScorer = join(mkdtempSync(join(tmpdir(), 'pass-')), 'pass.mjs')
  writeFileSync(passScorer, 'process.stdout.write(JSON.stringify({ score: 100, critique: "", findings: [] }))\n')
  const base = `node ${shq(passScorer)}`

  const repo = mkdtempSync(join(tmpdir(), 'scope-consume-'))
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 't@e.com'); git(repo, 'config', 'user.name', 't')
  mkdirSync(join(repo, 'src'))
  const honestSha = commit(repo, 'export const f = (n) => n * 2\n', 'honest')

  // seed a SCOPE check: src/m.mjs must satisfy f(2)===4 (a behavioural per-file check)
  const storePath = checkStorePath(mkdtempSync(join(tmpdir(), 'store-')))
  const checkCmd = `node ${shq(IO_ASSERT)} --rel src/m.mjs --fn f --case ${shq('2=>4')}`
  saveStore(storePath, addCheck(emptyStore(), { cmd: checkCmd, target: 100, kind: 'scope' }))

  const loopDir = mkdtempSync(join(tmpdir(), 'loop-'))
  const composed = composeConfirm({ baseConfirmCmd: base, storePath, loopDir, kind: 'scope' })
  assert.ok(composed.includes('composite.mjs')) // the scope check was composed in

  const { confirm } = scopeBuildContext(loopDir)
  const okReview = await confirm({ artifact_path: repo, confirm_scorer_cmd: composed, history: [{ snapshot: honestSha }] })
  assert.equal(okReview.score, 100) // honest tree passes (base + scope check both 100)

  const gamedSha = commit(repo, 'export const f = (n) => n * 3\n', 'gamed') // f(2)=6, base still passes
  const vetoReview = await confirm({ artifact_path: repo, confirm_scorer_cmd: composed, history: [{ snapshot: gamedSha }] })
  assert.equal(vetoReview.score, 0) // the scope check VETOES the gamed tree — it bites
})

test('a FILE-kind seeded check is NOT composed into a scope gate (no cross-poison, integration)', () => {
  const storePath = checkStorePath(mkdtempSync(join(tmpdir(), 'store-')))
  saveStore(storePath, addCheck(emptyStore(), { cmd: 'node /file-check.mjs --fn f --case 1=>1', target: 100 })) // file (no kind)
  const loopDir = mkdtempSync(join(tmpdir(), 'loop-'))
  const composed = composeConfirm({ baseConfirmCmd: 'node base.mjs', storePath, loopDir, kind: 'scope' })
  assert.equal(composed, 'node base.mjs') // no scope checks -> passthrough; the file check is not consumed
})
