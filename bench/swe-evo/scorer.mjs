#!/usr/bin/env node
// bench/swe-evo/scorer.mjs
// The V/C/T scorer CLI for the SWE-EVO adapter (H1). It bridges the Docker test runner's
// {node -> 'pass'|'fail'|'missing'} results map to whetstone's loop: it grades ONE arm's node-set
// (failNodes + passToPass, from --nodes) with computeFixRate and emits the {score,critique,findings}
// contract every whetstone scorer honours (read --output/--loop-dir/--pass; print JSON; exit 0, or 2 on
// scorer error). The SAME file scores V (in-loop), C (confirm), and T (truth, offline) — only the node-set
// and the --reveal-nodes flag differ, so the metric driving the gradient, the finish-line, and the grade
// is provably one function (computeFixRate).
//
// Two result sources (exactly one required):
//   --runner "<cmd>"  spawns the runner (cwd inherited = the tree being scored) and grades its stdout
//                     results map. Used for in-loop V/C where each pass needs FRESH results.
//   --results <file>  reads a results map from a JSON file. Used for offline T grading / the veto audit
//                     where the runner already produced the map.
//
// Source isolation (spec §4): WITHOUT --reveal-nodes the critique is counts-only — a confirm (C) veto
// must not leak held-out node NAMES, since a name like ::test_refund_partial leaks the very behaviour we
// measure generalization on. V passes --reveal-nodes so the editor gets the per-node gradient.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { computeFixRate } from './fixrate.mjs'

const statusOf = (results, node) => results[node] ?? 'missing' // absent == not run
const pct = (n) => Math.round(n * 100) / 100 // display only — the returned score stays exact

// Pure grading core. Returns the whetstone scorer payload for one arm's node-set.
export function gradeResults({ results = {}, failNodes = [], passToPass = [], reveal = false } = {}) {
  const score = computeFixRate({ results, failNodes, passToPass })
  const regressed = passToPass.filter((n) => statusOf(results, n) !== 'pass')
  const failing = failNodes.filter((n) => statusOf(results, n) !== 'pass').map((n) => ({ node: n, status: statusOf(results, n) }))

  let critique
  if (reveal) {
    const reg = regressed.length ? ` REGRESSION — PASS_TO_PASS failing: ${regressed.join(', ')}.` : ''
    const list = failing.length ? ` Still-failing FAIL_TO_PASS: ${failing.map((f) => `${f.node} (${f.status})`).join('; ')}.` : ''
    critique = `Fix Rate ${pct(score)}%.${reg}${list}`.slice(0, 3000)
  } else {
    // counts-only: scalar gradient + regression bit, but NO node ids (held-out behaviours stay hidden)
    critique = `Fix Rate ${pct(score)}%. regression=${regressed.length > 0}. ${failing.length}/${failNodes.length} held-out behaviour(s) still failing.`
  }

  const findings = reveal
    ? failing.map((f) => ({ area: f.node, severity: 'high', suggestion: 'make this behaviour pass', status: f.status }))
    : []
  return { score, critique, findings }
}

const arg = (name, def = undefined) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : def
}
const die = (msg) => {
  process.stderr.write(`swe-evo-scorer: ${msg}\n`)
  process.exit(2)
}

// A results map must be a plain { node: status } object. An array/null/scalar is a broken runner —
// reject it (exit 2) rather than letting `results[node]` silently read undefined -> 'missing' -> a
// misleadingly low score. (Only the LOW direction is reachable here, but a clean error beats a wrong 0.)
function asResultsMap(obj, src) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    die(`${src} did not yield a JSON object {node: status}, got ${Array.isArray(obj) ? 'array' : obj === null ? 'null' : typeof obj}`)
  }
  return obj
}

// Obtain the results map from exactly one source. A runner is spawned with cwd inherited (= the tree
// whetstone is scoring); a non-zero runner exit is a SCORER error (the run broke), never a score of 0 —
// real test outcomes live IN the map, not the exit code (the runner contract, item #3).
function loadResults({ resultsPath, runnerCmd }) {
  if (!!resultsPath === !!runnerCmd) die('provide exactly one of --results <file> or --runner "<cmd>"')
  if (resultsPath) {
    try {
      return asResultsMap(JSON.parse(readFileSync(resultsPath, 'utf8')), `--results ${resultsPath}`)
    } catch (e) {
      die(`could not read/parse --results ${resultsPath}: ${e.message}`)
    }
  }
  const res = spawnSync(runnerCmd, { shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (res.error) die(`runner failed to spawn: ${res.error.message}`)
  if (res.status !== 0) die(`runner exited ${res.status}: ${(res.stderr || '').slice(0, 500)}`)
  try {
    return asResultsMap(JSON.parse(res.stdout), 'runner stdout')
  } catch (e) {
    die(`runner stdout is not valid JSON: ${e.message}: ${String(res.stdout).slice(0, 200)}`)
  }
}

// Validate an arm node-set at the boundary. failNodes MUST be a non-empty array: every V/C/T arm (and
// the capability arm) carries >= 1 FAIL_TO_PASS by the split builder's contract, so an empty/absent
// failNodes is a serialization bug — and computeFixRate would score it a vacuous 100 (a false DONE).
// passToPass may be empty (a task can have 0 PASS_TO_PASS) but, if present, must be an array.
function validateNodeSet(nodeSet) {
  if (!Array.isArray(nodeSet?.failNodes) || nodeSet.failNodes.length === 0) {
    die(`--nodes must contain a non-empty failNodes array (every arm has >= 1 FAIL_TO_PASS; got ${JSON.stringify(nodeSet?.failNodes)})`)
  }
  const passToPass = nodeSet.passToPass ?? []
  if (!Array.isArray(passToPass)) die(`--nodes passToPass must be an array (got ${typeof passToPass})`)
  return { failNodes: nodeSet.failNodes, passToPass }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const nodesPath = arg('--nodes')
  if (!nodesPath) die('--nodes <file> is required (an arm node-set: { failNodes, passToPass })')
  let parsed
  try {
    parsed = JSON.parse(readFileSync(nodesPath, 'utf8'))
  } catch (e) {
    die(`could not read/parse --nodes ${nodesPath}: ${e.message}`)
  }
  const { failNodes, passToPass } = validateNodeSet(parsed)
  const results = loadResults({ resultsPath: arg('--results'), runnerCmd: arg('--runner') })
  const reveal = process.argv.includes('--reveal-nodes')
  const out = gradeResults({ results, failNodes, passToPass, reveal })
  process.stdout.write(JSON.stringify(out))
}
