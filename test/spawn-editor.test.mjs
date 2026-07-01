// spawn-editor: the async twin of spawnSync for the editor step. These tests spawn REAL, trivial
// `node -e` children (fast, deterministic, no model) and assert the returned object is spawnSync-SHAPED
// so every downstream pure helper keeps working, plus the timeout / overflow / spawn-failure error paths.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execPath } from 'node:process'
import { spawnEditorAsync } from '../src/spawn-editor.mjs'

test('clean exit: status 0, stdout captured, no error', async () => {
  const res = await spawnEditorAsync(execPath, ['-e', "process.stdout.write('hello')"], {})
  assert.equal(res.status, 0)
  assert.equal(res.stdout, 'hello')
  assert.equal(res.error, null)
  assert.equal(typeof res.pid, 'number')
})

test('non-zero exit: status + stderr surfaced, error null (not a spawn failure)', async () => {
  const res = await spawnEditorAsync(execPath, ['-e', "process.stderr.write('boom'); process.exit(3)"], {})
  assert.equal(res.status, 3)
  assert.equal(res.stderr, 'boom')
  assert.equal(res.error, null)
})

test('timeout: killed, error.code ETIMEDOUT', async () => {
  const res = await spawnEditorAsync(execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 120 })
  assert.ok(res.error, 'expected an error')
  assert.equal(res.error.code, 'ETIMEDOUT')
  assert.notEqual(res.status, 0) // SIGKILLed -> status null / signal set, never a clean 0
})

test('maxBuffer overflow: killed, error.code ENOBUFS', async () => {
  const res = await spawnEditorAsync(execPath, ['-e', "process.stdout.write('x'.repeat(5000))"], { maxBuffer: 100 })
  assert.ok(res.error, 'expected an error')
  assert.equal(res.error.code, 'ENOBUFS')
})

test('spawn failure (missing binary): error surfaced, status null', async () => {
  const res = await spawnEditorAsync('definitely-not-a-real-binary-xyzzy', ['-e', '1'], {})
  assert.ok(res.error, 'expected a spawn error')
  assert.equal(res.status, null)
})

test('onSpawn receives the child pid', async () => {
  let seen = null
  await spawnEditorAsync(execPath, ['-e', '0'], { onSpawn: (pid) => { seen = pid } })
  assert.equal(typeof seen, 'number')
})

test('onExit fires with the child pid once the process settles (kill-map clearing hook)', async () => {
  let spawned = null
  let exited = null
  await spawnEditorAsync(execPath, ['-e', '0'], { onSpawn: (pid) => { spawned = pid }, onExit: (pid) => { exited = pid } })
  assert.equal(typeof exited, 'number')
  assert.equal(exited, spawned) // same pid on spawn and exit -> the orchestrator can key its kill-map on it and clear it
})

test('detached timeout: process-group SIGKILL via -pid still resolves ETIMEDOUT', async () => {
  // Exercises the detached branch (process.kill(-pid, 'SIGKILL')) that the orchestrator's killChild relies on:
  // a detached child that hangs is reaped by its own timeout without leaking or throwing.
  const res = await spawnEditorAsync(execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 150, detached: true })
  assert.ok(res.error, 'expected an error')
  assert.equal(res.error.code, 'ETIMEDOUT')
})
