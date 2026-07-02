import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crossRepoPermissionWarning } from '../src/preflight.mjs'

// A fake fs-read: returns the JSON registered for a path, throws ENOENT otherwise (mirrors readFileSync).
function fakeRead(files) {
  return (p) => { if (p in files) return files[p]; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
}
const cwd = '/home/me/whetstone'

test('crossRepoPermissionWarning: same-repo target (inside cwd) never warns — it is the operator own surface', () => {
  const read = fakeRead({ '/home/me/whetstone/.claude/settings.json': JSON.stringify({ permissions: { allow: ['Bash(rm:*)'] } }) })
  assert.equal(crossRepoPermissionWarning({ targetDir: '/home/me/whetstone/src', cwd, read }), null)
})

test('crossRepoPermissionWarning: cross-repo target with no .claude settings -> null', () => {
  assert.equal(crossRepoPermissionWarning({ targetDir: '/other/repo', cwd, read: fakeRead({}) }), null)
})

test('crossRepoPermissionWarning: cross-repo target with a non-empty permissions.allow warns', () => {
  const read = fakeRead({ '/other/repo/.claude/settings.json': JSON.stringify({ permissions: { allow: ['Bash(git:*)', 'Bash(npm:*)'] } }) })
  const w = crossRepoPermissionWarning({ targetDir: '/other/repo', cwd, read })
  assert.match(w, /cross-repo target \/other\/repo/)
  assert.match(w, /permissions\.allow has 2 rule/)
})

test('crossRepoPermissionWarning: bypassPermissions default (settings.local.json) warns', () => {
  const read = fakeRead({ '/other/repo/.claude/settings.local.json': JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }) })
  const w = crossRepoPermissionWarning({ targetDir: '/other/repo', cwd, read })
  assert.match(w, /bypassed by default/)
})

test('crossRepoPermissionWarning: cross-repo target with an EMPTY allow list does not warn', () => {
  const read = fakeRead({ '/other/repo/.claude/settings.json': JSON.stringify({ permissions: { allow: [] } }) })
  assert.equal(crossRepoPermissionWarning({ targetDir: '/other/repo', cwd, read }), null)
})

test('crossRepoPermissionWarning: an unparseable settings file is ignored (not our concern here)', () => {
  const read = fakeRead({ '/other/repo/.claude/settings.json': '{ not json' })
  assert.equal(crossRepoPermissionWarning({ targetDir: '/other/repo', cwd, read }), null)
})
