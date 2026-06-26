#!/usr/bin/env node
// Composite scorer: run N sub-scorers and combine their scores by MIN, so the gate
// reaches `done` only when the WEAKEST dimension clears target. This hardens the gate
// — a green test suite no longer ships if a security/robustness dimension is still low.
//
// The sub-scorers are listed one raw command per line in a --scorers-file (the gate
// manifest); composite forwards --output/--loop-dir/--pass to each. DETERMINISTIC iff
// every sub-scorer is; it inherits the nondeterminism of any judge sub-scorer.
//
// Contract (every whetstone scorer honors this): read --output/--loop-dir/--pass,
// print {score, critique, findings} JSON to stdout, exit 0 on success, exit 2 on error.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const arg = (n, d) => {
  const i = process.argv.indexOf(n)
  return i >= 0 ? process.argv[i + 1] : d
}
const die = (m) => {
  process.stderr.write(`composite: ${m}\n`)
  process.exit(2)
}
// Per-sub wall-clock cap so a hung sub-scorer (flaky endpoint, a never-returning judge) can't wedge
// the composite — mirrors the driver's CHILD_TIMEOUT_MS. On a timeout spawnSync sets res.error
// (ETIMEDOUT) and the existing `if (res.error) die(...)` exits 2. Env-tunable (and test-tunable).
const SUB_TIMEOUT_MS = Number(process.env.WHET_SUB_TIMEOUT_MS) || 5 * 60 * 1000
// POSIX single-quote so a passthrough value with spaces (e.g. the run dir path) survives
// the shell that runs each sub-scorer command.
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

// Pure + exported so the manifest parsing can be unit-tested.
export function parseScorerList(fileText) {
  return String(fileText)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
}

// Validate one sub-scorer's result. Throws (named) on any failure — a non-zero exit,
// non-JSON output, or an out-of-range score — so the CLI can halt rather than fold a
// broken dimension's garbage into the combined score.
export function parseSubResult(name, res) {
  if (res.status !== 0) {
    throw new Error(`sub-scorer ${name} failed (exit ${res.status}): ${String(res.stderr || '').slice(0, 200)}`)
  }
  let obj
  try {
    obj = JSON.parse(res.stdout)
  } catch {
    throw new Error(`sub-scorer ${name} did not print JSON: ${String(res.stdout || '').slice(0, 200)}`)
  }
  const score = Number(obj.score)
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error(`sub-scorer ${name} score not in 0..100: ${obj.score}`)
  }
  return {
    score,
    critique: String(obj.critique ?? ''),
    findings: Array.isArray(obj.findings) ? obj.findings : [],
  }
}

// Combine sub-results by MIN. The critique carries the BINDING (weakest) dimension's
// own critique — that's what the next edit should fix — prefixed with a one-line score
// breakdown so the operator (and editor) see every dimension at a glance.
export function combine(results) {
  const scores = results.map((r) => r.score)
  const min = Math.min(...scores)
  const bindingIdx = scores.indexOf(min)
  const breakdown = scores.map((s, i) => `#${i}=${s}`).join(' ')
  return {
    score: min,
    critique: `[composite] ${breakdown} -> binding #${bindingIdx}\n${results[bindingIdx].critique}`,
    findings: results.flatMap((r) => r.findings),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = arg('--scorers-file')
  if (!file) die('--scorers-file <path> is required')

  let list
  try {
    list = parseScorerList(readFileSync(file, 'utf8'))
  } catch (e) {
    die(`cannot read --scorers-file ${file}: ${e.message}`)
  }
  if (!list.length) die(`no sub-scorers in ${file}`)

  // Forward the driver's per-pass flags to every sub-scorer verbatim.
  const tail = ['--output', '--loop-dir', '--pass']
    .flatMap((f) => {
      const v = arg(f)
      return v === undefined ? [] : [f, shq(v)]
    })
    .join(' ')

  const results = list.map((cmd) => {
    // shell:true is safe ONLY because every manifest line is fence-constructed by its writer —
    // `node <allowlisted-script> <shq-quoted-arg>…` (see src/forge/gate.mjs, src/scope-cli.mjs). A
    // sub-scorer that itself EXECUTES one of its args (e.g. test-pass-rate's --cmd) would re-open a
    // shell hole through this line — which is exactly why the Forge denylists such scorers
    // (FORGE_UNSAFE_SCORERS in src/forge/hook.mjs) and scope-cli excludes composite (SUBGATE_UNSAFE).
    const res = spawnSync(`${cmd} ${tail}`, { shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: SUB_TIMEOUT_MS, killSignal: 'SIGKILL' })
    if (res.error) die(`sub-scorer failed to spawn (${cmd}): ${res.error.message}`)
    try {
      return parseSubResult(cmd, res)
    } catch (e) {
      die(e.message)
    }
  })

  process.stdout.write(JSON.stringify(combine(results)))
}
