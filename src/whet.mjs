// whet.mjs — the INTAKE ROUTER (Inc 4 of the dynamic-control-plane plan). A thin layer ABOVE the three measured
// entry points: it inspects the input flags and dispatches to the right one. Picking a process never moves the
// goalposts (the chosen entry owns its own code-owned gate), so this layer is safe — and when the intent is
// ambiguous or under-specified it routes UP (prints guidance, exits non-zero) rather than guessing a target.
//
//   --objectives <manifest>  -> converge-cli.mjs  (multi-objective; reads --scope too)
//   --scope <dir>            -> scope-cli.mjs      (whole-directory loop)
//   --artifact <file>        -> driver.mjs         (single-file loop)
//
// Delegation is a subprocess re-exec of the chosen entry with the SAME args, so each entry's CLI logic (and its
// gate) runs verbatim — zero coupling, no duplicated dispatch. Not registered as a package bin: it would surface
// the still-alpha converge/scope modes onto the supported surface, which the v1 tiering deliberately withholds.
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main.mjs'

const ENTRY = { converge: 'converge-cli.mjs', scope: 'scope-cli.mjs', driver: 'driver.mjs' }

// PURE: flag-set -> { mode, reason }. mode is one of converge|scope|driver, or null to route UP. Precedence is
// most-structured-first (objectives > scope > artifact); two single-target flags together is genuine ambiguity.
export function routeIntake(argv) {
  const has = (f) => argv.includes(f)
  const objectives = has('--objectives')
  const scope = has('--scope')
  const artifact = has('--artifact')
  if (objectives) return { mode: 'converge', reason: '--objectives manifest -> multi-objective converge' }
  if (scope && artifact) return { mode: null, reason: 'both --scope and --artifact given — specify exactly one target (a single file via --artifact OR a whole dir via --scope)' }
  if (scope) return { mode: 'scope', reason: '--scope dir -> whole-directory scope loop' }
  if (artifact) return { mode: 'driver', reason: '--artifact file -> single-file driver loop' }
  return { mode: null, reason: 'no target specified — give --artifact <file> (single file), --scope <dir> (whole dir), or --objectives <manifest> (multi-objective)' }
}

const USAGE = `usage: whet <target> [entry-point flags...]
  --artifact <file>        single-file driver loop      (stable)
  --scope <dir>            whole-directory scope loop    (experimental)
  --objectives <manifest>  multi-objective converge      (alpha)
The selected entry point validates the rest of the flags. Under-specified or ambiguous intent is refused here
(route up) rather than guessed — name a target, or run a design phase first to produce a manifest.\n`

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2)
  const { mode, reason } = routeIntake(argv)
  if (!mode) {
    process.stderr.write(`whet: cannot route — ${reason}\n\n${USAGE}`)
    process.exit(2)
  }
  const script = resolve(dirname(fileURLToPath(import.meta.url)), ENTRY[mode])
  const res = spawnSync('node', [script, ...argv], { stdio: 'inherit' })
  process.exit(res.status ?? 1)
}
