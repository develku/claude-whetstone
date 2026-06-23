import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runFromConfig } from '../src/driver.mjs'

// runFromConfig must validate the config up front (via validateConfig) and refuse to
// run — throwing a clear error — when it's invalid, instead of looping on nonsense.

test('runFromConfig throws on an invalid config instead of running the loop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whetstone-valwire-'))
  let acted = false
  await assert.rejects(
    () =>
      runFromConfig(
        { goal: 'g', artifactPath: join(dir, 'a.txt'), scorerCmd: 's', targetScore: 150, hardCap: 10, loopDir: join(dir, '.loop') },
        { act: async () => { acted = true; return { changed: true } }, log: () => {} },
      ),
    /target_score/,
  )
  assert.equal(acted, false) // the loop must never have started
})
