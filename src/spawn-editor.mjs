// Async twin of spawnSync for the editor step. child_process.spawn wrapped in a Promise so the ACT step
// YIELDS the event loop while `claude -p` runs — this is what makes converge-parallel's already-async
// fan-out (Promise.allSettled + raceChild) actually overlap in wall clock instead of serializing on a
// blocking spawnSync. Returns a spawnSync-SHAPED result { status, signal, stdout, stderr, error, pid } so
// every downstream pure helper (extractCost / extractTokens / editorExitDisposition / editorFailureReason)
// reads it byte-for-byte the same as before.
//
// detached:true makes the child a process-group leader (pgid === pid), so a timeout/overflow kill via
// process.kill(-pid) reaps `claude -p` AND any tool subprocess it forked — a bare child.kill() would
// orphan the grandchildren. This self-enforced timeout is the REAL per-child wall-clock cap: no editor
// can outlive timeoutMs regardless of the orchestrator's raceChild bookkeeping.
import { spawn } from 'node:child_process'

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024

// error.code mirrors what spawnSync sets so the callers' `if (res.error) throw ...(res.error.code)` branch
// is preserved verbatim: ETIMEDOUT (timeout kill), ENOBUFS (maxBuffer overflow), or the spawn errno.
export function spawnEditorAsync(bin, args, {
  cwd,
  maxBuffer = DEFAULT_MAX_BUFFER,
  timeoutMs = null,
  killSignal = 'SIGKILL',
  detached = false,
  onSpawn = null,
  onExit = null,
} = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, args, { cwd, detached, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      // Synchronous spawn failure (rare — most surface via the async 'error' event below).
      resolve({ status: null, signal: null, stdout: '', stderr: '', error: e, pid: null })
      return
    }
    const pid = child.pid
    try { onSpawn?.(pid) } catch { /* caller bookkeeping is best-effort */ }

    const outChunks = []
    const errChunks = []
    let outLen = 0
    let settled = false
    let timedOut = false
    let overflow = false
    let spawnErr = null

    const kill = () => {
      try { detached && pid ? process.kill(-pid, killSignal) : child.kill(killSignal) } catch { /* already gone (ESRCH) */ }
    }

    const timer = timeoutMs ? setTimeout(() => { timedOut = true; kill() }, timeoutMs) : null

    child.stdout.on('data', (c) => {
      outChunks.push(c)
      outLen += c.length
      if (outLen > maxBuffer && !overflow) { overflow = true; kill() } // spawnSync-parity: overflow -> kill + error
    })
    child.stderr.on('data', (c) => errChunks.push(c))

    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      // onExit fires the instant this process settles so the orchestrator can drop its pid from any kill-map
      // BEFORE the next pass spawns — the map then only ever holds a LIVE pid, never a stale/recycled one.
      try { onExit?.(pid) } catch { /* caller bookkeeping is best-effort */ }
      resolve(result)
    }

    // 'error' (e.g. ENOENT) fires when the process could not be spawned; 'close' typically does not follow it.
    child.on('error', (e) => {
      spawnErr = e
      finish({ status: null, signal: null, stdout: Buffer.concat(outChunks).toString('utf8'), stderr: Buffer.concat(errChunks).toString('utf8'), error: e, pid })
    })
    child.on('close', (status, signal) => {
      const error = spawnErr
        ?? (timedOut ? Object.assign(new Error(`editor timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' })
          : overflow ? Object.assign(new Error('editor stdout exceeded maxBuffer'), { code: 'ENOBUFS' })
            : null)
      finish({ status, signal, stdout: Buffer.concat(outChunks).toString('utf8'), stderr: Buffer.concat(errChunks).toString('utf8'), error, pid })
    })
  })
}
