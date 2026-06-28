import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sha256 = (p) => createHash('sha256').update(readFileSync(join(root, p))).digest('hex')

// The 7 INVARIANT files: the loop core, the Verifier Forge bricks, and the composite scorer. Track C
// (converge-*) builds AROUND them by COMPOSITION and must NEVER edit them. This is a code-owned TRIPWIRE:
// if any hash changes, this test fails loudly. A LEGITIMATE change to one of these is a high-blast-radius
// edit that requires a DCA (the project's verifier-lifecycle discipline) — update the expected hash here as
// part of that deliberate, reviewed change, never to silence a surprise.
const INVARIANT = {
  'src/loop.mjs': '5efb984c176d0f528ae8bfd00f7140522e8a5be627e5ac2939fd70140a09d012',
  'src/forge/run.mjs': '60aef92be0dfed2d9891da67ebbcd0b49dd36f684b060027b0fd68d8ac9b063b',
  'src/forge/gate.mjs': '16b6bcb3ad3600a45456ca3486137ffd94d1c186dd90aadb8ab09420ccdad5c9',
  'src/forge/store.mjs': 'cd8d0049e5070a3757456c0eea8030c34c084a378ace03c6e2fd8678473d8c66',
  'src/forge/prune.mjs': '2464dd2c8fed0d32b781709b5d8de5770f2eec89e3e5cd43f67bf4ce447720cd',
  'src/forge/admit.mjs': '24bc8d08fc0b52c045b8099db9eb0f373537e6afba4d8b10dc8fa91b5153875e',
  'scorers/composite.mjs': '8bd286f3b9706a664f135c16aca205a34d9a6065d69269db8c03a17898e50374',
}

test('the 7 invariant files are byte-identical — Track C builds around them, edits none', () => {
  for (const [p, expected] of Object.entries(INVARIANT)) {
    assert.equal(sha256(p), expected, `INVARIANT FILE CHANGED: ${p} — this is a DCA-gated edit; update the baked hash deliberately, never to silence a surprise`)
  }
})
