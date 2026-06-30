// src/iso-runner-child.mjs
// The spawned, locked-down child of the isolated behavioural runner (#2). It is the ONLY process that imports
// the untrusted artifact. It reads its job over stdin (nonce never touches disk), executes the artifact's
// contract via iso-execute (which snapshots every value through canonicalData), and writes the inert
// observation back to the parent on fd 3, wrapped in the per-run nonce frame. The parent owns the oracle.
//
// Invoked as: node --permission --allow-fs-read=<src dir> --allow-fs-read=<artifact dir> iso-runner-child.mjs
// --permission denies fs-write (no heap snapshot to disk), worker, child_process, inspector, native addons.
// The lockdown below additionally denies the IN-MEMORY heap/escape routes (node:v8 getHeapSnapshot survives
// --permission) so the artifact cannot recover the lexically-secret nonce and forge a passing frame.
//
// LOCKDOWN ORDER IS LOAD-BEARING — every capture/scrub happens BEFORE `await import(artifact)`, whose
// top-level evaluation is the attacker.
import { readFileSync, writeSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { registerHooks } from 'node:module'
import { serialize, frameOpen, frameClose } from './iso-frame.mjs'
import { executeAssert, executeTrace, executeEffect, executeInvariants } from './iso-execute.mjs'
const _writeSync = writeSync // captured: the artifact cannot rebind our emit primitive

// (1) read the job from stdin and consume it fully, so a later fd-0 read by the artifact yields EOF.
const job = JSON.parse(readFileSync(0, 'utf8'))
const { nonce, artifact, mode, spec } = job
process.argv.length = Math.min(process.argv.length, 1) // scrub argv (the nonce isn't here, but leak nothing)

// (2) deny the introspection/escape builtins at the module layer (covers `import` AND `require`). Normalize:
// strip node: (CASE-INSENSITIVELY), then everything from the first / ? # — so v8, node:v8, node:inspector/promises,
// node:v8?x, and NODE:V8 all match. The case-insensitive strip is belt-and-suspenders like the scrub below: Node's
// loader rejects a cased scheme (ERR_UNKNOWN_BUILTIN_MODULE) on every supported version today, so an uppercase
// dodge is already a score-0 import failure — but the deny set must not rely on that external loader behaviour.
// LIMITATION (by design): an honest artifact that imports one of these at module-eval time is reported
// reason:'import' -> the scorer exits 2 (it cannot score), not score 0. The io-* scorers check pure/stateful
// LOGIC, which never needs v8/inspector/vm/worker/child_process/module; a file that does is out of their scope.
const DENY = new Set(['v8', 'inspector', 'vm', 'worker_threads', 'child_process', 'module'])
const bare = (s) => String(s).replace(/^node:/i, '').split(/[/?#]/)[0].toLowerCase()
registerHooks({ resolve(specifier, ctx, next) { if (DENY.has(bare(specifier))) throw new Error(`iso-runner: "${specifier}" denied in sandbox`); return next(specifier, ctx) } })

// (3) remove the non-import routes to builtins/native bindings. process.getBuiltinModule fetches a builtin
// WITHOUT the resolve hook; binding/_linkedBinding/dlopen reach native code (binding is already off under
// --permission, scrubbed anyway as belt-and-suspenders).
for (const k of ['getBuiltinModule', 'binding', '_linkedBinding', 'dlopen']) { try { delete process[k] } catch {} }

const EXEC = { assert: executeAssert, trace: executeTrace, effect: executeEffect, invariant: executeInvariants }

// (4) import the artifact, then execute. An import failure (syntax error, top-level throw, denied builtin) is
// reported distinctly (reason:'import') so the parent can preserve the scorer contract (bad import -> exit 2);
// an execute-time throw / non-JSON return is reason:'artifact' (-> score 0). Never a child crash.
let observation
let mod
try {
  mod = await import(pathToFileURL(artifact).href)
} catch (e) {
  mod = null
  observation = { ok: false, reason: 'import', error: String((e && e.message) || e) }
}
if (mod) {
  try {
    const exec = EXEC[mode]
    if (!exec) throw new Error(`unknown mode "${mode}"`)
    observation = exec(mod, spec)
  } catch (e) {
    observation = { ok: false, reason: 'artifact', error: String((e && e.message) || e) }
  }
}
_writeSync(3, frameOpen(nonce) + serialize(observation) + frameClose(nonce))
