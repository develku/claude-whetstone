// The committed required-set manifest is the doc-coverage scorer's ground truth: the scorer reads ONLY
// this file (never the live tree), so the editor can't shrink its own required set — and THIS test is the
// freshness tripwire: every flag call-site in src/driver.mjs must appear in the manifest, so a flag added
// to the code without a manifest entry fails CI here instead of silently escaping the recall gate.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'scorers', 'doc-required.json')

// Extract every quoted '--flag' literal used as a CLI lookup in driver.mjs. Bounded to the two idioms
// parseCli actually uses (get/getAll helpers and argv.includes/indexOf) so incidental '--x' strings in
// comments or error text don't inflate the required set.
export function extractDriverFlags(src) {
  const out = new Set()
  for (const re of [/(?:\bget|\bgetAll)\(\s*'(--[a-z][a-z-]*)'/g, /argv\.(?:includes|indexOf)\(\s*'(--[a-z][a-z-]*)'/g]) {
    let m
    while ((m = re.exec(src))) out.add(m[1])
  }
  return [...out].sort()
}

test('manifest exists, parses, and every group is a non-empty string array', () => {
  const j = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(j.docKind, 'readme')
  for (const group of ['flags', 'scorers', 'configKeys', 'modules']) {
    assert.ok(Array.isArray(j[group]) && j[group].length > 0, `${group} must be a non-empty array`)
    for (const item of j[group]) assert.equal(typeof item, 'string', `${group} entries must be strings`)
  }
  assert.ok(Number.isInteger(j.wordFloors?.desc) && j.wordFloors.desc >= 1, 'wordFloors.desc must be a positive integer')
  assert.ok(Number.isInteger(j.wordFloors?.prose) && j.wordFloors.prose >= 1, 'wordFloors.prose must be a positive integer')
})

test('drift tripwire: every flag call-site in src/driver.mjs is present in the manifest', () => {
  const driverSrc = readFileSync(join(root, 'src', 'driver.mjs'), 'utf8')
  const found = extractDriverFlags(driverSrc)
  assert.ok(found.length >= 20, `extraction sanity: expected >=20 driver flags, got ${found.length} — the parseCli idiom may have changed; update extractDriverFlags`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const missing = found.filter((f) => !manifest.flags.includes(f))
  assert.deepEqual(missing, [], `flags parsed by driver.mjs but absent from doc-required.json (stale manifest): ${missing.join(', ')}`)
})
