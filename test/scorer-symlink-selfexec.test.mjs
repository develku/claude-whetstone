import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCORERS = join(HERE, '..', 'scorers')

// Scorers that self-exec via `node <scorer>.mjs --...`. Launched through a symlink (npm link,
// plugin cache, symlinked dotfiles) the naive main-guard silently no-opped: exit 0 with empty
// stdout AND empty stderr. Each must instead RUN its main block — proven by spawning it through
// a symlink with NO args, where a live scorer dies LOUDLY (exit 2 + a stderr message) instead of
// vanishing. Deterministic and $0 (every scorer dies on missing required args before any model call).
const SELF_EXEC_SCORERS = [
  'test-pass-rate.mjs',
  'llm-judge.mjs',
  'doc-lint.mjs',
  'floor.mjs',
  'io-assert.mjs',
  'io-effect.mjs',
  'io-invariant.mjs',
  'io-trace.mjs',
]

for (const name of SELF_EXEC_SCORERS) {
  test(`${name} self-execs when launched via a symlink (no silent no-op)`, () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'symrun-')))
    try {
      const link = join(dir, name)
      symlinkSync(join(SCORERS, name), link)
      const res = spawnSync('node', [link], { encoding: 'utf8' })
      const silentNoop = res.status === 0 && res.stdout === '' && res.stderr === ''
      assert.ok(
        !silentNoop,
        `${name} silently no-opped when launched via a symlink (exit ${res.status}, empty stdout+stderr) — its main guard did not fire`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
