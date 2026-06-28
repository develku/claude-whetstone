#!/usr/bin/env node
// bench/swe-evo/runner.mjs
// The per-instance task runner. It runs the held-out tests against the editor's CURRENT tree inside the
// instance's Docker image and prints a {node -> 'pass'|'fail'} results map to stdout — exactly the shape
// the V/C/T scorer (scorer.mjs --runner) consumes. The map is the FULL parsed result; each scorer grades
// its own node-set slice (absent node -> 'missing' downstream).
//
// Layers:
//   - parseLogPytest / toResultsMap : a FAITHFUL port of SWE-bench's parse_log_pytest (incl. its quirks)
//     so the in-loop grade matches the official evaluate_instance.py cross-check. $0-unit-tested.
//   - buildContainerScript          : the bash run inside the container (reset -> apply code -> apply test
//     -> run test_cmds). Pure string, $0-tested.
//   - dockerRun (real) / --stub      : the Docker realization; --stub injects a canned map for the $0 e2e.
//
// No-network (codex Q4): the container runs with `--network none`; images must be PRE-PULLED (feasibility).
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { selectPatchForFiles } from './test-patch.mjs'

// SWE-bench TestStatus keywords pytest -rA summary lines start with (constants/__init__.py).
const TEST_STATUS = ['FAILED', 'PASSED', 'SKIPPED', 'ERROR', 'XFAIL']

// Faithful port of swebench parse_log_pytest. A `-rA` summary line is "STATUS node[ - reason]"; the
// run-body lines are "node STATUS [ n%]" (path-first) and are correctly skipped. The Python original's
// quirks are preserved on purpose (str.replace removes ALL " - "; SKIPPED lines mis-key to "[n]") so the
// node→status map — and therefore the grade — agrees with the official harness.
export function parseLogPytest(log) {
  const map = {}
  for (let line of String(log).split('\n')) {
    if (!TEST_STATUS.some((s) => line.startsWith(s))) continue
    if (line.startsWith('FAILED')) line = line.split(' - ').join(' ') // Python str.replace replaces ALL
    const parts = line.split(/\s+/).filter(Boolean) // Python str.split() drops empty tokens
    if (parts.length <= 1) continue
    map[parts[1]] = parts[0]
  }
  return map
}

// SWE-bench resolution: a test counts only if its status is PASSED. Project to the scorer's pass/fail
// vocabulary (absent nodes become 'missing' in the scorer via computeFixRate).
export function toResultsMap(statusMap) {
  const out = {}
  for (const [node, status] of Object.entries(statusMap)) out[node] = status === 'PASSED' ? 'pass' : 'fail'
  return out
}

// The bash run inside the container (repo pre-installed at repoDir, conventionally /testbed). Reset to
// base_commit, apply the editor's CODE patch (skipped on the first pass when there's no diff yet), apply
// the arm's TEST files, then run test_cmds. `git apply` is whitespace-tolerant; collection errors are
// surfaced (test_cmds carries --continue-on-collection-errors) rather than aborting the run.
export function buildContainerScript({ repoDir = '/testbed', baseCommit, codePatch, testPatch, testCmds }) {
  const lines = [
    'set -o pipefail',
    `cd ${repoDir}`,
    'git config --global --add safe.directory "*" 2>/dev/null || true',
    `git reset --hard ${baseCommit} >/dev/null 2>&1 && git clean -fdxq >/dev/null 2>&1 || true`,
  ]
  if (codePatch) lines.push(`git apply --whitespace=nowarn ${codePatch} || patch -p1 < ${codePatch}`)
  if (testPatch) lines.push(`git apply --whitespace=nowarn ${testPatch} || patch -p1 < ${testPatch}`)
  lines.push(testCmds)
  return lines.join('\n')
}

// Capture the editor's full change vs base_commit — incl. new/deleted files — without disturbing the
// working tree: stage all, diff --cached, then unstage. Returns '' when there is no diff.
export function editorCodePatch(treeDir, baseCommit) {
  spawnSync('git', ['-C', treeDir, 'add', '-A'], { encoding: 'utf8' })
  const d = spawnSync('git', ['-C', treeDir, 'diff', '--cached', baseCommit], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  spawnSync('git', ['-C', treeDir, 'reset', '-q'], { encoding: 'utf8' }) // restore the index; working tree untouched
  return d.status === 0 ? d.stdout : ''
}

// Run one instance's tests in its Docker image against `treeDir`, applying only `testFiles` of the gold
// test_patch (source isolation: the held-out arms' test bodies never enter this container's grading set
// unless this arm asks for them). Returns the {node->'pass'|'fail'} map. Throws on a Docker/infra failure.
export function dockerRun({ instance, treeDir, testFiles }) {
  const work = mkdtempSync(join(tmpdir(), 'swe-run-'))
  const codePatch = editorCodePatch(treeDir, instance.baseCommit)
  const testPatch = selectPatchForFiles(instance.testPatch || '', testFiles || [])
  let codeArg = null
  let testArg = null
  if (codePatch) { writeFileSync(join(work, 'code.patch'), codePatch); codeArg = '/whetstone/code.patch' }
  if (testPatch) { writeFileSync(join(work, 'test.patch'), testPatch); testArg = '/whetstone/test.patch' }
  const script = buildContainerScript({ repoDir: instance.repoDir || '/testbed', baseCommit: instance.baseCommit, codePatch: codeArg, testPatch: testArg, testCmds: instance.testCmds })
  const res = spawnSync('docker', ['run', '--rm', '--network', 'none', '-v', `${work}:/whetstone:ro`, instance.image, 'bash', '-c', script], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (res.error) throw new Error(`docker run failed to start: ${res.error.message}`)
  const log = `${res.stdout || ''}${res.stderr || ''}`
  const map = toResultsMap(parseLogPytest(log))
  // A truly EMPTY map means the test command produced no parseable result at all (image missing, daemon
  // error, env broken) — an infra failure, NOT a legitimate all-fail. Surface it so the scorer errors
  // (exit 2) rather than scoring a misleading 0. A genuine collection collapse still yields file-level
  // ERROR entries, so the map is non-empty there.
  if (Object.keys(map).length === 0) throw new Error(`runner produced no parseable test results (infra/env failure); docker exit ${res.status}; log tail: ${log.slice(-400)}`)
  return map
}

// --- CLI -----------------------------------------------------------------------------------------

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const die = (m) => { process.stderr.write(`swe-evo-runner: ${m}\n`); process.exit(2) }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stub = arg('--stub')
  if (stub) { // the $0 injectable seam: print the canned results map, no Docker
    try { process.stdout.write(readFileSync(stub, 'utf8')) } catch (e) { die(`could not read --stub ${stub}: ${e.message}`) }
    process.exit(0)
  }
  const instPath = arg('--instance-json')
  if (!instPath) die('usage: runner.mjs --instance-json <file> [--tree <dir>] [--test-files a,b] [--stub <results.json>]')
  let instance
  try { instance = JSON.parse(readFileSync(instPath, 'utf8')) } catch (e) { die(`could not read --instance-json: ${e.message}`) }
  const treeDir = arg('--tree', process.cwd())
  const testFiles = (arg('--test-files', '') || '').split(',').map((s) => s.trim()).filter(Boolean)
  try {
    const map = dockerRun({ instance, treeDir, testFiles })
    process.stdout.write(JSON.stringify(map))
  } catch (e) {
    die(e.message) // exit 2 -> the scorer treats this as a scorer error, never a misleading score 0
  }
}
