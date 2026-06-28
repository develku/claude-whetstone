import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

// Smoke-tests the converge-cli ENTRY: only refusal paths (which exit 2 BEFORE any child loop), so no claude
// is ever spawned. This proves the entry wiring (parse -> cleanTreeGuard -> loadManifest -> convergeRefusal)
// without spend.
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'converge-cli.mjs')
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()

function run(args) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf8' })
    return { code: 0, stdout, stderr: '' }
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

function cleanRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'whet-cli-'))
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't')
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'init')
  return dir
}
function manifestFile(obj) {
  const mdir = mkdtempSync(join(tmpdir(), 'whet-cli-m-'))
  const p = join(mdir, 'objectives.json')
  writeFileSync(p, JSON.stringify(obj))
  return { mdir, p }
}

test('converge-cli exits 2 with usage when --scope/--objectives are missing', () => {
  const r = run([])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /usage:/)
})

test('converge-cli refuses (exit 2) a manifest that fails the safety suite (no floor)', () => {
  const dir = cleanRepo()
  const { mdir, p } = manifestFile({ goal: 'g', objectives: [{ id: 'a', goal: 'g', scorer: 'node x.mjs', target: 90, editScope: 'a' }] })
  try {
    const r = run(['--scope', dir, '--objectives', p])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /refusing to start/)
    assert.match(r.stderr, /floor/)
  } finally {
    rmSync(dir, { recursive: true, force: true }); rmSync(mdir, { recursive: true, force: true })
  }
})

test('converge-cli refuses (exit 2) a dirty working tree before doing anything', () => {
  const dir = cleanRepo()
  writeFileSync(join(dir, 'dirty.txt'), 'x') // uncommitted
  const { mdir, p } = manifestFile({ goal: 'g', floor: { cmd: 'true' }, objectives: [{ id: 'a', goal: 'g', scorer: 'node x.mjs', target: 90, editScope: 'a' }] })
  try {
    const r = run(['--scope', dir, '--objectives', p])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /refusing to start/)
  } finally {
    rmSync(dir, { recursive: true, force: true }); rmSync(mdir, { recursive: true, force: true })
  }
})

test('converge-cli refuses (exit 2) a manifest placed INSIDE the scope (meta-gate must be external)', () => {
  const dir = cleanRepo()
  // manifest inside the scope
  const p = join(dir, 'objectives.json')
  writeFileSync(p, JSON.stringify({ goal: 'g', floor: { cmd: 'true' }, global_budget_tokens: 1000, objectives: [
    { id: 'a', goal: 'g', scorer: 'node /opt/x.mjs', target: 90, editScope: 'a' },
    { id: 'b', goal: 'g', scorer: 'node /opt/x.mjs', target: 90, editScope: 'b' },
  ] }))
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'add manifest') // keep tree clean
  try {
    const r = run(['--scope', dir, '--objectives', p])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /OUTSIDE --scope|refusing to start/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
