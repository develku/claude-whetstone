#!/usr/bin/env node
// scorers/floor.mjs
// The DETERMINISTIC FLOOR (H4). Doctrine: "never ship a judge-only top gate; always keep one deterministic
// floor (repo still builds)." This scorer runs a deterministic command (build / compile / test) and maps it
// to the gate vocabulary: exit 0 -> score 100, non-zero -> score 0 with the failure output as the critique.
//
// It is also a COMPOSING confirm: with --and "<scorer cmd>", the chained (held-out) scorer runs ONLY when the
// floor passes, and its review flows through — so "done" requires (deterministic floor passes) AND (the
// held-out check passes). scope-cli --floor wires this as confirm_scorer_cmd, which activates the done-edge
// confirm even behind a judge-only primary --scorer. The floor is NECESSARY, not sufficient: it can't prove
// the artifact is good, only that the repo isn't broken — the score gate + --and carry sufficiency.
//
// Trust: --cmd / --and are OPERATOR-provided (via --floor / --confirm-scorer), never model-chosen — same
// trust class as test-pass-rate's --cmd. floor.mjs is in scope-cli's SUBGATE_UNSAFE denylist so a decompose
// finding can't name it with a model-chosen --cmd (which would be shell injection).
import { spawnSync } from 'node:child_process'
import { isMainModule } from '../src/is-main.mjs'
import { shq } from '../src/shq.mjs'

// Pure grading core. floorExit !== 0 -> blocked (0). Else the chained scorer's review if present, else 100.
export function gradeFloor({ floorExit, floorOutput = '', andReview = null }) {
  if (floorExit !== 0) {
    return { score: 0, critique: `deterministic floor failed (exit ${floorExit}): ${String(floorOutput).slice(-500)}`, findings: [] }
  }
  if (andReview) return andReview
  return { score: 100, critique: 'deterministic floor passed', findings: [] }
}

// Build the confirm_scorer_cmd that wires the floor (and composes the existing confirm scorer above it).
export function floorConfirmCmd({ floorPath, floorCmd, confirmCmd = null }) {
  let s = `node ${shq(floorPath)} --cmd ${shq(floorCmd)}`
  if (confirmCmd) s += ` --and ${shq(confirmCmd)}`
  return s
}

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const die = (m) => { process.stderr.write(`floor: ${m}\n`); process.exit(2) }

if (isMainModule(import.meta.url)) {
  const cmd = arg('--cmd')
  if (!cmd) die('--cmd "<deterministic command>" is required')
  const res = spawnSync(cmd, { shell: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const floorExit = res.error ? 1 : (res.status ?? 1) // couldn't spawn / killed -> the floor did not pass
  const floorOutput = `${res.stdout || ''}${res.stderr || ''}`

  let andReview = null
  const andCmd = arg('--and')
  if (floorExit === 0 && andCmd) {
    // forward the context the confirm path appended so the chained scorer scores the same checkout
    let full = andCmd
    for (const f of ['--output', '--loop-dir', '--pass']) { const v = arg(f); if (v != null) full += ` ${f} ${shq(v)}` }
    const ar = spawnSync(full, { shell: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    if (ar.error) die(`--and scorer failed to spawn: ${ar.error.message}`)
    if (ar.status !== 0) die(`--and scorer exited ${ar.status}: ${(ar.stderr || ar.stdout || '').slice(0, 300)}`)
    try { andReview = JSON.parse(ar.stdout) } catch (e) { die(`--and scorer output is not JSON: ${e.message}: ${String(ar.stdout).slice(0, 200)}`) }
  }

  process.stdout.write(JSON.stringify(gradeFloor({ floorExit, floorOutput, andReview })))
}
