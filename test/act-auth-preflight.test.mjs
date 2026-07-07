import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAuthFailure, authRemedyMessage, makeClaudeAct } from '../src/act-claude.mjs'

// Auth-vs-transient discrimination at the ACT layer (SPEC.md:254 "detect OAuth vs API-key auth?"). An
// auth-class editor failure will NOT self-heal across backoff — burning 3 identical retries then throwing
// a cryptic "editor claude exited 1" wastes a paid run and hides the fix. isAuthFailure classifies it so
// makeClaudeAct fails FAST + LOUD with a one-line remedy. The classifier must stay TIGHT: a rate
// limit / overload is transient (keep retrying), only a genuine auth failure short-circuits.

// A [init, result] stream shaped like `claude -p --output-format json`, result carrying `extra`.
const resultStream = (extra) =>
  JSON.stringify([{ type: 'system', subtype: 'init' }, { type: 'result', ...extra }])

test('isAuthFailure — TRUE for structured api_error_status 401', () => {
  assert.equal(isAuthFailure(resultStream({ subtype: 'error_during_execution', is_error: true, api_error_status: 401 }), ''), true)
  // string / object forms of 401 (the CLI is not consistent about the type)
  assert.equal(isAuthFailure(resultStream({ api_error_status: '401' }), ''), true)
  assert.equal(isAuthFailure(resultStream({ api_error_status: { code: 401 } }), ''), true)
})

test('isAuthFailure — TRUE for auth-specific text on stderr', () => {
  assert.equal(isAuthFailure('', 'OAuth token has expired. Please run /login'), true)
  assert.equal(isAuthFailure('', 'Invalid API key'), true)
  assert.equal(isAuthFailure('', 'errSecInteractionNotAllowed'), true)
  assert.equal(isAuthFailure('', 'Not logged in'), true)
  assert.equal(isAuthFailure('', 'Error: Unauthorized'), true)
})

test('isAuthFailure — TRUE when the auth signal is in stdout free text', () => {
  assert.equal(isAuthFailure('some preamble\nInvalid API key\n', ''), true)
})

test('isAuthFailure — FALSE for rate-limit / overload (transient, must retry)', () => {
  assert.equal(isAuthFailure(resultStream({ api_error_status: 429, is_error: true }), ''), false)
  assert.equal(isAuthFailure(resultStream({ api_error_status: 'overloaded_error', result: 'Overloaded' }), ''), false)
  assert.equal(isAuthFailure('', 'rate limit exceeded'), false)
})

test('isAuthFailure — FALSE for error_max_turns and a clean success', () => {
  assert.equal(isAuthFailure(resultStream({ subtype: 'error_max_turns', is_error: false }), ''), false)
  assert.equal(isAuthFailure(resultStream({ subtype: 'success', is_error: false }), ''), false)
})

test('isAuthFailure — FALSE when a NON-401 structured status coincides with auth-phrase text (structured wins)', () => {
  // Regression for the reviewer's HIGH finding: a definitive rate-limit/overload status must NOT be
  // overridden by incidental auth wording in the body — else a transient failure would skip the retries it
  // needs and one blip would kill a paid run (the exact regression the v1.5.1 retry ladder prevents).
  assert.equal(isAuthFailure(resultStream({ api_error_status: 429, is_error: true, result: 'Unauthorized burst — please retry' }), 'invalid api key mentioned in a stray log line'), false)
  assert.equal(isAuthFailure(resultStream({ api_error_status: 'overloaded_error', result: 'not logged in? no — just overloaded' }), ''), false)
})

test('isAuthFailure — FALSE for a plain artifact string that merely mentions 401 in prose', () => {
  // The broad-match guard: a bare "401" in free text must NOT trip the classifier — only the STRUCTURED
  // api_error_status carries the numeric signal.
  assert.equal(isAuthFailure('The HTTP 401 status code is documented in RFC 7235, section 3.1.', ''), false)
})

test('authRemedyMessage — carries the actionable self-heal line', () => {
  const m = authRemedyMessage()
  assert.match(m, /claude \/login/)
  assert.match(m, /claude setup-token/)
  assert.match(m, /CLAUDE_CODE_OAUTH_TOKEN/)
  assert.match(m, /ANTHROPIC_API_KEY/)
})

// ---- wiring: makeClaudeAct short-circuits an auth-class fatal exit ----
const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs')
chmodSync(FAKE, 0o755)
const state = { goal: 'g', last_critique: 'improve the thing', history: [] }

async function withArtifact(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'whet-actauth-'))
  const artifact = join(dir, 'artifact.txt')
  writeFileSync(artifact, 'initial content\n')
  try { return await fn({ dir, artifact }) } finally { rmSync(dir, { recursive: true, force: true }) }
}

async function actWithEnv(act, env) {
  const saved = {}
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k] }
  try { return await act(state) } finally {
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  }
}

const spies = () => {
  const sleeps = []
  const warns = []
  return { sleeps, warns, retry: { sleep: async (ms) => { sleeps.push(ms) }, warn: (m) => warns.push(m) } }
}

test('makeClaudeAct — an auth-class fatal exit throws after ONE attempt with the remedy (no backoff)', async () => {
  await withArtifact(async ({ artifact }) => {
    const { sleeps, warns, retry } = spies()
    const act = makeClaudeAct({ artifactPath: artifact, claudeBin: FAKE, timeoutMs: 10_000, retry })
    await assert.rejects(
      () => actWithEnv(act, { WHET_FAKE_MODE: 'auth' }),
      (e) => /exited 1/.test(e.message) && /claude \/login/.test(e.message) && /CLAUDE_CODE_OAUTH_TOKEN/.test(e.message),
    )
    assert.deepEqual(sleeps, []) // auth won't self-heal across backoff — do NOT consume retries
    assert.equal(warns.length, 0) // it throws immediately, never enters the retry-warn path
  })
})

test('makeClaudeAct — a NON-auth fatal exit (overload) still retries per existing behavior', async () => {
  await withArtifact(async ({ dir, artifact }) => {
    const counter = join(dir, 'counter')
    const { sleeps, warns, retry } = spies()
    const act = makeClaudeAct({ artifactPath: artifact, claudeBin: FAKE, timeoutMs: 10_000, retry })
    await assert.rejects(
      () => actWithEnv(act, { WHET_FAKE_FAIL_TIMES: '99', WHET_FAKE_COUNTER: counter }),
      (e) => /exited 1/.test(e.message) && /Overloaded/.test(e.message) && !/claude \/login/.test(e.message),
    )
    assert.deepEqual(sleeps, [2000, 5000]) // unchanged 3x retry ladder for transient failures
    assert.equal(warns.length, 2)
  })
})
