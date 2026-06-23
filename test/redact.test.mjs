import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets } from '../src/redact.mjs'

// Scrub common secrets from a string before it lands in review.json / logs. Patterns:
//   - sk- API keys (sk- followed by 16+ of [A-Za-z0-9-])  -> [REDACTED]
//   - AWS access key ids (AKIA + 16 of [0-9A-Z])          -> [REDACTED]
//   - Bearer tokens (Bearer <8+ token chars>)             -> Bearer [REDACTED]
// Ordinary text is left untouched.

test('redacts an sk- API key', () => {
  assert.equal(redactSecrets('key=sk-abc123DEF456ghi789JKL done'), 'key=[REDACTED] done')
})

test('redacts an AWS access key id', () => {
  assert.equal(redactSecrets('id AKIAIOSFODNN7EXAMPLE x'), 'id [REDACTED] x')
})

test('redacts a bearer token but keeps the scheme', () => {
  assert.equal(redactSecrets('Authorization: Bearer abcdef1234567890'), 'Authorization: Bearer [REDACTED]')
})

test('leaves ordinary text untouched', () => {
  assert.equal(redactSecrets('the quick brown fox jumps'), 'the quick brown fox jumps')
})

test('redacts multiple secrets in one string', () => {
  assert.equal(redactSecrets('sk-aaaaaaaaaaaaaaaa and AKIAIOSFODNN7EXAMPLE'), '[REDACTED] and [REDACTED]')
})

// Broadened coverage — the original 3-pattern set was security theater (missed most shapes).
test('redacts a GitHub personal access token', () => {
  assert.doesNotMatch(redactSecrets('token ghp_0123456789abcdefghijklmnopqrstuvwxyz x'), /ghp_/)
})

test('redacts a fine-grained GitHub token', () => {
  assert.doesNotMatch(redactSecrets('github_pat_0123456789abcdef_0123456789abcdefghij'), /github_pat_/)
})

test('redacts a Slack token', () => {
  assert.doesNotMatch(redactSecrets('xoxb-0123456789-abcdefABCDEF'), /xoxb-/)
})

test('redacts a Google API key', () => {
  assert.doesNotMatch(redactSecrets('AIzaSyA1234567890abcdefghijklmnopqrstuv'), /AIza/)
})

test('redacts the full Anthropic key including the hyphenated suffix', () => {
  const out = redactSecrets('sk-ant-api03-AbCdEf123456')
  assert.equal(out, '[REDACTED]') // no '-api03-...' suffix leak
})

test('redacts a PEM private key block', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc123\n-----END RSA PRIVATE KEY-----'
  assert.equal(redactSecrets(pem), '[REDACTED]')
})

test('redacts a generic api_key= assignment but keeps the name', () => {
  assert.equal(redactSecrets('api_key=supersecretvalue123'), 'api_key=[REDACTED]')
})
