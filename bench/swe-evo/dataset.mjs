#!/usr/bin/env node
// bench/swe-evo/dataset.mjs
// Loader for the SWE-EVO benchmark (HF Fsoft-AIC/SWE-EVO, 48 rows, split=test). Two layers, kept apart
// on purpose:
//   - PURE (normalizeRow, assertNoTruncation): the row->harness field mapping + the truncation guard,
//     $0-unit-tested. Field names mirror the LIVE schema (verified 2026-06-28).
//   - NETWORK (fetchAndCache): one-time acquisition via HF's dataset-viewer /rows API (JSON rows, no
//     parquet parser, no Python `datasets`, no new deps). It writes a JSON cache + a committed PINNED.json
//     manifest. The A/B driver and tests only ever call loadInstances() — a SYNC read of that cache, so
//     the scored run never depends on HF uptime or the network (which must be OFF during editing/scoring).
//
// Pinning (codex Q2): we record the dataset commit SHA at fetch time and re-assert it on every fetch, so a
// silent upstream change is DETECTED rather than silently scored against. The /rows API serves the current
// revision; record-and-verify is the pin.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(HERE, 'data')
const DATASET_ID = 'Fsoft-AIC/SWE-EVO'
const CONFIG = 'default'
const SPLIT = 'test'
const EXPECTED_COUNT = 48

// The harness needs these columns; the gold `patch` + provenance are kept but clearly held out.
const REQUIRED = ['repo', 'instance_id', 'base_commit', 'environment_setup_commit', 'image', 'test_cmds', 'log_parser', 'test_patch', 'problem_statement']

// --- PURE ----------------------------------------------------------------------------------------

export function normalizeRow(raw) {
  for (const k of REQUIRED) {
    if (raw[k] == null) throw new Error(`SWE-EVO row missing required field: ${k} (instance ${raw.instance_id ?? '?'})`)
  }
  if (!Array.isArray(raw.FAIL_TO_PASS)) throw new Error(`SWE-EVO row FAIL_TO_PASS must be a list (instance ${raw.instance_id})`)
  if (!Array.isArray(raw.PASS_TO_PASS)) throw new Error(`SWE-EVO row PASS_TO_PASS must be a list (instance ${raw.instance_id})`)
  return {
    instanceId: raw.instance_id,
    repo: raw.repo,
    baseCommit: raw.base_commit,
    envSetupCommit: raw.environment_setup_commit,
    image: raw.image,
    testCmds: raw.test_cmds,
    logParser: raw.log_parser,
    testPatch: raw.test_patch, // gold TEST diff — the splitter slices V's files out; C/T stay physically absent
    failToPass: raw.FAIL_TO_PASS,
    passToPass: raw.PASS_TO_PASS,
    problemStatement: raw.problem_statement, // the editor's GOAL
    goldPatch: raw.patch, // HELD OUT — the gold solution; never passed to the editor (kept for optional gold-verification + provenance)
    meta: {
      startVersion: raw.start_version,
      endVersion: raw.end_version,
      endVersionCommit: raw.end_version_commit,
      bench: raw.bench,
      version: raw.version,
      instanceIdSwe: raw.instance_id_swe,
    },
  }
}

// The dataset-viewer caps response size and TRUNCATES large cells. Losing a single test_patch byte breaks
// source isolation, so any truncated cell (or a `partial` response) is a hard error — lower --batch.
export function assertNoTruncation(viewerRows, partial = false) {
  if (partial) throw new Error('dataset-viewer returned a partial (size-capped) response — lower --batch')
  const bad = viewerRows.filter((r) => (r.truncated_cells || []).length > 0)
  if (bad.length) {
    throw new Error(`dataset-viewer truncated cells for row(s) ${bad.map((r) => r.row_idx).join(', ')} — lower --batch (cannot lose test_patch)`)
  }
}

// --- NETWORK (one-time acquisition) --------------------------------------------------------------

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'whetstone-bench/0' } })
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`)
  return res.json()
}

export async function fetchDatasetSha(datasetId = DATASET_ID) {
  const j = await getJson(`https://huggingface.co/api/datasets/${datasetId}`)
  return j.sha
}

// Paginate /rows in small batches, guarding truncation; return raw rows in dataset order.
export async function fetchViewerRows({ datasetId = DATASET_ID, config = CONFIG, split = SPLIT, batch = 2 } = {}) {
  const base = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(datasetId)}&config=${config}&split=${split}`
  const first = await getJson(`${base}&offset=0&length=1`)
  const total = first.num_rows_total
  const rows = []
  for (let off = 0; off < total; off += batch) {
    const j = await getJson(`${base}&offset=${off}&length=${Math.min(batch, total - off)}`)
    assertNoTruncation(j.rows, j.partial)
    for (const r of j.rows) rows.push(r.row)
  }
  if (rows.length !== total) throw new Error(`fetched ${rows.length} rows, expected ${total}`)
  return rows
}

// Fetch + normalize + write the cache and the committed PINNED.json manifest. Returns { sha, count, cacheFile }.
export async function fetchAndCache({ cacheDir = DATA_DIR, datasetId = DATASET_ID, config = CONFIG, split = SPLIT, batch = 2, expectedCount = EXPECTED_COUNT } = {}) {
  const sha = await fetchDatasetSha(datasetId)
  const raw = await fetchViewerRows({ datasetId, config, split, batch })
  const instances = raw.map(normalizeRow)
  if (instances.length !== expectedCount) {
    throw new Error(`SWE-EVO expected ${expectedCount} instances, got ${instances.length} — schema/size drift; reconcile before scoring`)
  }
  mkdirSync(cacheDir, { recursive: true })
  const fetchedAt = new Date().toISOString() // provenance stamp on the pin
  const cacheFile = join(cacheDir, `instances-${sha}.json`)
  writeFileSync(cacheFile, JSON.stringify({ datasetId, config, split, sha, fetchedAt, count: instances.length, instances }))
  writeFileSync(join(cacheDir, 'PINNED.json'), JSON.stringify({ datasetId, config, split, sha, count: instances.length, fetchedAt }, null, 2) + '\n')
  return { sha, count: instances.length, cacheFile }
}

// --- SYNC READ (used by the driver/tests; no network) --------------------------------------------

// Read the cached instances for the pinned SHA. Throws (with the fix) if the cache is absent — the driver
// must never silently run on a missing/partial dataset.
export function loadInstances({ cacheDir = DATA_DIR } = {}) {
  const pinPath = join(cacheDir, 'PINNED.json')
  if (!existsSync(pinPath)) throw new Error(`no PINNED.json in ${cacheDir} — run: node bench/swe-evo/dataset.mjs --fetch`)
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const cacheFile = join(cacheDir, `instances-${pin.sha}.json`)
  if (!existsSync(cacheFile)) throw new Error(`pinned cache ${cacheFile} missing — run: node bench/swe-evo/dataset.mjs --fetch`)
  const cache = JSON.parse(readFileSync(cacheFile, 'utf8'))
  if (cache.count !== cache.instances.length) throw new Error(`cache ${cacheFile} is corrupt (count ${cache.count} != ${cache.instances.length})`)
  return cache.instances
}

// --- CLI -----------------------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
  const run = async () => {
    if (process.argv.includes('--fetch')) {
      const batch = arg('--batch') ? Number(arg('--batch')) : 2
      process.stderr.write(`fetching ${DATASET_ID} (${SPLIT}) via dataset-viewer, batch=${batch}...\n`)
      const { sha, count, cacheFile } = await fetchAndCache({ batch })
      process.stdout.write(`cached ${count} instances at sha ${sha}\n${cacheFile}\n`)
      return
    }
    if (process.argv.includes('--list')) {
      const xs = loadInstances()
      for (const i of xs) process.stdout.write(`${i.instanceId}\tF2P=${i.failToPass.length}\tP2P=${i.passToPass.length}\timage=${i.image}\n`)
      process.stdout.write(`total ${xs.length}\n`)
      return
    }
    process.stderr.write('usage: dataset.mjs --fetch [--batch N]   (one-time cache build)\n       dataset.mjs --list           (print cached instances)\n')
    process.exit(2)
  }
  run().catch((e) => { process.stderr.write(`dataset: ${e.message}\n`); process.exit(1) })
}
