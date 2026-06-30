import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, symlinkSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// Regression: the main-module guard must recognise the driver even when it is invoked through a symlink.
// `npm link` (and any `npm i -g`) installs the bin as a symlink — Node realpath-resolves import.meta.url
// but leaves process.argv[1] as the symlink path, so a naive `import.meta.url === pathToFileURL(argv[1])`
// is false and the whole CLI block is silently skipped (exit 0, no output). This pins the symlinked path.
const driver = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'driver.mjs'))

test('driver CLI runs when invoked through a symlink (npm-link / global bin)', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'whet-symlink-'))
  try {
    const link = join(dir, 'whetstone')
    symlinkSync(driver, link)
    // No goal/artifact/scorer: the CLI must REACH its usage guard (exit 2), not silently no-op (exit 0).
    const r = spawnSync(process.execPath, [link], { encoding: 'utf8', input: '' })
    assert.equal(r.status, 2, `expected usage exit 2 via symlink, got ${r.status} (stderr: ${JSON.stringify(r.stderr)})`)
    assert.match(r.stderr, /usage: driver\.mjs/, 'expected usage text on stderr when run via symlink')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
