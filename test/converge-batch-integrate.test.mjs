import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { squashIntegrateBatch, withWorktreeLock } from '../src/converge-parallel.mjs'
import { gitMaterialize, gitCleanup } from '../src/git-snapshot.mjs'

// Track B inc 3 — the single-commit N-way merge (squashIntegrateBatch) and the worktree-admin mutex
// (withWorktreeLock). Real-git Tier-2: every test runs against a throwaway repo; children are stub commits.

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'whet-batch-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 't@e.com')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'init')
  return dir
}

function write(dir, rel, content) {
  const p = join(dir, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

// Make ONE child commit off last-good editing `rel`, capture its head sha, then reset the tree back to
// last-good (the orchestrator drives off SHAs; the loose child commit stays diffable). Mirrors how a real
// child runs in its OWN worktree off last-good — here flattened onto the main branch for the stub.
function childCommit(dir, lastGood, edits) {
  git(dir, 'reset', '--hard', lastGood)
  for (const [rel, content] of Object.entries(edits)) {
    if (content === null) rmSync(join(dir, rel))
    else write(dir, rel, content)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'child')
  const head = git(dir, 'rev-parse', 'HEAD')
  git(dir, 'reset', '--hard', lastGood)
  return head
}

const surv = (id, editScope, childHead) => ({ obj: { id, editScope }, childHead })

// --- squashIntegrateBatch: ONE commit off last-good carrying every disjoint survivor's allowed paths ---

test('squashIntegrateBatch merges 2 disjoint-scope children into ONE commit whose parent IS last-good', () => {
  const dir = tempRepo()
  try {
    write(dir, 'src/auth/a.txt', '1')
    write(dir, 'src/api/b.txt', '1')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'seed')
    const lastGood = git(dir, 'rev-parse', 'HEAD')
    const childA = childCommit(dir, lastGood, { 'src/auth/a.txt': '2' })
    const childB = childCommit(dir, lastGood, { 'src/api/b.txt': '2' })

    const r = squashIntegrateBatch(dir, lastGood, [surv('A', 'src/auth', childA), surv('B', 'src/api', childB)])
    assert.equal(r.advanced, true)
    assert.equal(git(dir, 'rev-parse', `${r.sha}^`), lastGood) // single commit, parent === last-good
    // both edits landed
    assert.equal(git(dir, 'show', `${r.sha}:src/auth/a.txt`), '2')
    assert.equal(git(dir, 'show', `${r.sha}:src/api/b.txt`), '2')
    assert.deepEqual(
      git(dir, 'diff', '--name-only', lastGood, r.sha).split('\n').sort(),
      ['src/api/b.txt', 'src/auth/a.txt'],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('squashIntegrateBatch THROWS when two survivors claim the same allowed path (disjointness invariant)', () => {
  const dir = tempRepo()
  try {
    write(dir, 'src/x.txt', '1')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'seed')
    const lastGood = git(dir, 'rev-parse', 'HEAD')
    const childA = childCommit(dir, lastGood, { 'src/x.txt': 'A' })
    const childB = childCommit(dir, lastGood, { 'src/x.txt': 'B' })
    // both editScopes are 'src' (overlapping — a manifest-validation regression) → both admit src/x.txt
    assert.throws(
      () => squashIntegrateBatch(dir, lastGood, [surv('A', 'src', childA), surv('B', 'src', childB)]),
      /disjoint/i,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('squashIntegrateBatch carries only editScope-allowed paths; an out-of-scope edit is reverted per child', () => {
  const dir = tempRepo()
  try {
    write(dir, 'src/auth/a.txt', '1')
    write(dir, 'src/api/b.txt', '1')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'seed')
    const lastGood = git(dir, 'rev-parse', 'HEAD')
    // childA edits its own scope AND a sibling's source (the cross-objective hack)
    const childA = childCommit(dir, lastGood, { 'src/auth/a.txt': '2', 'src/api/b.txt': 'HACK' })
    const childB = childCommit(dir, lastGood, { 'src/api/b.txt': '2' })

    const r = squashIntegrateBatch(dir, lastGood, [surv('A', 'src/auth', childA), surv('B', 'src/api', childB)])
    assert.equal(r.advanced, true)
    assert.equal(git(dir, 'show', `${r.sha}:src/auth/a.txt`), '2') // A's in-scope edit
    assert.equal(git(dir, 'show', `${r.sha}:src/api/b.txt`), '2') // B's edit (A's HACK never landed)
    const a = r.perChild.find((c) => c.objectiveId === 'A')
    assert.ok(a.reverted.includes('src/api/b.txt')) // A's cross-objective edit dropped
    assert.deepEqual(a.integrated, ['src/auth/a.txt'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('squashIntegrateBatch drops a no-op child (all out-of-scope) and still merges the contributing one', () => {
  const dir = tempRepo()
  try {
    write(dir, 'src/auth/a.txt', '1')
    write(dir, 'src/other/c.txt', '1')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'seed')
    const lastGood = git(dir, 'rev-parse', 'HEAD')
    const childA = childCommit(dir, lastGood, { 'src/auth/a.txt': '2' })
    const childB = childCommit(dir, lastGood, { 'src/other/c.txt': '2' }) // out of B's scope → no-op

    const r = squashIntegrateBatch(dir, lastGood, [surv('A', 'src/auth', childA), surv('B', 'src/feature', childB)])
    assert.equal(r.advanced, true)
    assert.deepEqual(git(dir, 'diff', '--name-only', lastGood, r.sha).split('\n'), ['src/auth/a.txt'])
    const b = r.perChild.find((c) => c.objectiveId === 'B')
    assert.deepEqual(b.integrated, []) // B contributed nothing
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('squashIntegrateBatch does NOT advance when NO survivor contributes an in-scope change', () => {
  const dir = tempRepo()
  try {
    write(dir, 'src/auth/a.txt', '1')
    write(dir, 'src/api/b.txt', '1')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'seed')
    const lastGood = git(dir, 'rev-parse', 'HEAD')
    const childA = childCommit(dir, lastGood, { 'src/api/b.txt': 'x' }) // out of A's scope
    const childB = childCommit(dir, lastGood, { 'src/auth/a.txt': 'y' }) // out of B's scope

    const r = squashIntegrateBatch(dir, lastGood, [surv('A', 'src/auth', childA), surv('B', 'src/api', childB)])
    assert.equal(r.advanced, false)
    assert.equal(r.sha, lastGood)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('squashIntegrateBatch merges an in-scope DELETE from one child alongside an add from another', () => {
  const dir = tempRepo()
  try {
    write(dir, 'src/auth/a.txt', '1')
    write(dir, 'src/auth/old.txt', 'remove me')
    write(dir, 'src/api/b.txt', '1')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'seed')
    const lastGood = git(dir, 'rev-parse', 'HEAD')
    const childA = childCommit(dir, lastGood, { 'src/auth/old.txt': null }) // delete in-scope
    const childB = childCommit(dir, lastGood, { 'src/api/b.txt': '2' })

    const r = squashIntegrateBatch(dir, lastGood, [surv('A', 'src/auth', childA), surv('B', 'src/api', childB)])
    assert.equal(r.advanced, true)
    assert.equal(git(dir, 'rev-parse', `${r.sha}^`), lastGood)
    assert.throws(() => git(dir, 'show', `${r.sha}:src/auth/old.txt`)) // gone
    assert.equal(git(dir, 'show', `${r.sha}:src/api/b.txt`), '2')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('squashIntegrateBatch throws on a non-sha lastGood or survivor head (trust boundary)', () => {
  assert.throws(() => squashIntegrateBatch('/x', 'HEAD~1', []), /SHA/)
})

// --- withWorktreeLock: an in-process async mutex serializing worktree admin (add/remove) ---

test('withWorktreeLock serializes — never two fns in the critical section at once', async () => {
  let active = 0
  let maxActive = 0
  const task = () => withWorktreeLock(async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((r) => setTimeout(r, 5))
    active -= 1
  })
  await Promise.all([task(), task(), task(), task()])
  assert.equal(maxActive, 1)
})

test('withWorktreeLock resolves with the fn result and runs fns in call order', async () => {
  const order = []
  const results = await Promise.all([
    withWorktreeLock(async () => { order.push('a'); return 1 }),
    withWorktreeLock(async () => { order.push('b'); return 2 }),
    withWorktreeLock(async () => { order.push('c'); return 3 }),
  ])
  assert.deepEqual(results, [1, 2, 3])
  assert.deepEqual(order, ['a', 'b', 'c'])
})

test('withWorktreeLock: a rejecting fn does not wedge the queue', async () => {
  await assert.rejects(withWorktreeLock(async () => { throw new Error('boom') }))
  const r = await withWorktreeLock(async () => 'ok')
  assert.equal(r, 'ok')
})

test('withWorktreeLock guards concurrent materialize/cleanup against worktree-admin corruption', async () => {
  const dir = tempRepo()
  try {
    write(dir, 'f.txt', '1'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'seed')
    const head = git(dir, 'rev-parse', 'HEAD')
    const pairs = Array.from({ length: 4 }, () => withWorktreeLock(async () => {
      const wt = gitMaterialize(dir, head)
      await new Promise((r) => setTimeout(r, 2))
      gitCleanup(dir, wt)
    }))
    await Promise.all(pairs)
    git(dir, 'worktree', 'prune')
    const worktrees = git(dir, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '))
    assert.equal(worktrees.length, 1) // only the main worktree survives
    assert.doesNotThrow(() => git(dir, 'fsck')) // object store intact
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
