import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sha256 = (p) => createHash('sha256').update(readFileSync(join(root, p))).digest('hex')

// The 8 INVARIANT files: the gate + loop core, the Verifier Forge bricks, and the composite scorer. Track C
// (converge-*) builds AROUND them by COMPOSITION and must NEVER edit them. This is a code-owned TRIPWIRE:
// if any hash changes, this test fails loudly. A LEGITIMATE change to one of these is a high-blast-radius
// edit that requires a DCA (the project's verifier-lifecycle discipline) — update the expected hash here as
// part of that deliberate, reviewed change, never to silence a surprise. NOTE (scope): this is a byte-drift
// tripwire that FORCES a surprise core edit into deliberate review — NOT a runtime/security boundary (the hash
// is dev-updatable) and NOT a semantic-soundness guarantee (it can't see drift via callers/scorer inputs/new
// paths that bypass the gate). src/gate.mjs added per a cross-model design review (#8): loop.mjs was pinned but
// imports its verdict fn (gateVerdict/validScore) from the then-unpinned gate — the actual "code owns the gate" core.
const INVARIANT = {
  'src/gate.mjs': 'b0cb2139ef36bbed304e6a6cf10e9ed02209e3488fd6ce03b4079d2f3819ac11',
  // loop.mjs hash DELIBERATELY updated 2026-07-02 (v1.6.0): actEscalated generalized from one jump to an
  // ordered escalation LADDER (single fn stays a one-rung ladder — historical behavior byte-for-byte in
  // semantics, proven by the pre-existing escalation tests passing unchanged). Reviewed change, operator-
  // requested (sonnet→opus→fable); decision provenance in the v1.6.0 commit body.
  'src/loop.mjs': '223863b356de2fca02d91457c8320a6f43246a37d9cd3551d18fe8bae304e226',
  'src/forge/run.mjs': '60aef92be0dfed2d9891da67ebbcd0b49dd36f684b060027b0fd68d8ac9b063b',
  'src/forge/gate.mjs': '16b6bcb3ad3600a45456ca3486137ffd94d1c186dd90aadb8ab09420ccdad5c9',
  'src/forge/store.mjs': 'cd8d0049e5070a3757456c0eea8030c34c084a378ace03c6e2fd8678473d8c66',
  'src/forge/prune.mjs': '2464dd2c8fed0d32b781709b5d8de5770f2eec89e3e5cd43f67bf4ce447720cd',
  'src/forge/admit.mjs': '459d9d25a52c2c19f1fbb0336b18d2417105b3f660782b52e3218c798c5e11fe',
  'scorers/composite.mjs': 'd526408268932e15472842b41e31e9ec9e67d49d51c14b87cd0301993692780b',
}

test('the 8 invariant files are byte-identical — Track C builds around them, edits none', () => {
  for (const [p, expected] of Object.entries(INVARIANT)) {
    assert.equal(sha256(p), expected, `INVARIANT FILE CHANGED: ${p} — this is a DCA-gated edit; update the baked hash deliberately, never to silence a surprise`)
  }
})
