import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// End-to-end coverage of the F2 cross-repo permission preflight wired into the driver CLI entry. Runs the
// real driver against a cross-repo artifact whose .claude/settings.json carries a broad permissions.allow;
// a $0 inline scorer returns 100 so the baseline is immediately `done` (no editor spawn, no spend), which is
// enough to reach the preflight line. Asserts the non-fatal warning lands on stderr AND does not block.
const here = dirname(fileURLToPath(import.meta.url))
const driver = realpathSync(join(here, '..', 'src', 'driver.mjs'))
// A scorer FILE (not -e): trailing --output/--loop-dir/--pass become script args node ignores, so the
// baseline scores 100 -> gate `done` at pass 0 -> no editor spawn -> $0, exit 0. Single-quote the path:
// the scorer command runs under shell:true and this repo's path contains spaces.
const SCORER_100 = `${process.execPath} '${join(here, 'fixtures', 'always-100.mjs')}'`

test('driver CLI: warns (non-fatal) when the --artifact lives in a cross-repo with a broad permission surface', () => {
  const target = mkdtempSync(join(realpathSync(tmpdir()), 'whet-xrepo-'))
  const loopDir = mkdtempSync(join(realpathSync(tmpdir()), 'whet-run-'))
  try {
    mkdirSync(join(target, '.claude'), { recursive: true })
    writeFileSync(join(target, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(rm:*)', 'Bash(curl:*)'] } }))
    const artifact = join(target, 'a.txt')
    writeFileSync(artifact, 'already good\n')
    const r = spawnSync(process.execPath, [
      driver, 'improve it', '--artifact', artifact, '--scorer', SCORER_100,
      '--target', '90', '--cap', '1', '--loop-dir', join(loopDir, 'run'),
    ], { encoding: 'utf8', input: '' })
    assert.match(r.stderr, /cross-repo target/, `expected the preflight warning on stderr (stderr: ${JSON.stringify(r.stderr)})`)
    assert.match(r.stderr, /permissions\.allow has 2 rule/)
    assert.equal(r.status, 0, 'the warning is NON-fatal: a baseline-done run still exits 0') // done at baseline 100
  } finally {
    rmSync(target, { recursive: true, force: true }); rmSync(loopDir, { recursive: true, force: true })
  }
})
