// src/forge/gate.mjs
// Verifier Forge brick 4b — gate consumption: make the accumulated checks BITE. At a fresh --forge run's
// start, compose the confirm scorer = MIN(base confirm, ...stored checks) by reusing scorers/composite.mjs,
// so future runs face an ever-harder verifier. This closes the verifier-lifecycle loop. The checks live
// outside the edited artifact (in the store + their own allowlisted scorer scripts), so the editor cannot
// tamper with them — single-file isolation is inherent.
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shq } from '../shq.mjs'
import { loadStore as defaultLoadStore, listChecks as defaultListChecks } from './store.mjs'

const COMPOSITE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scorers', 'composite.mjs')

// The composite manifest body: the base confirm scorer plus every stored check, one bare cmd per line.
// Empty when there are no checks (the caller treats that as passthrough). Pure.
export function gateManifestLines(baseConfirmCmd, checks) {
  if (!checks.length) return []
  return [baseConfirmCmd, ...checks.map((c) => c.cmd)]
}

// Compose the run's confirm scorer from base-confirm + the stored checks. Passthrough (return baseConfirmCmd
// unchanged, no write) when there is no base confirm or the store has no checks. Otherwise write the manifest
// to <loopDir>/gate-checks.txt and return a composite over it. loadStore/listChecks/writeManifest are injected
// for testing; they default to the real store ops + fs.
export function composeConfirm(
  { baseConfirmCmd, storePath, loopDir, compositePath = COMPOSITE },
  { loadStore = defaultLoadStore, listChecks = defaultListChecks, writeManifest = (p, body) => writeFileSync(p, body) } = {},
) {
  if (!baseConfirmCmd) return baseConfirmCmd
  const lines = gateManifestLines(baseConfirmCmd, listChecks(loadStore(storePath)))
  if (!lines.length) return baseConfirmCmd
  const manifest = join(loopDir, 'gate-checks.txt')
  writeManifest(manifest, lines.join('\n') + '\n')
  return ['node', shq(compositePath), '--scorers-file', shq(manifest)].join(' ')
}
