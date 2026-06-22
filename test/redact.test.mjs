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
