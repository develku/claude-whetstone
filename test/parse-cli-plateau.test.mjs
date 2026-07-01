// parseCli must thread the two plateau knobs — plateauWindow / minDelta — from the config-file
// `defaults` and let a CLI flag override them. These were previously unreadable on the CLI/config
// path (initState always fell back to the hardcoded 3 / 1), so an operator could not lengthen the
// plateau window for a long overnight run toward a hard target. Precedence must match every other
// knob: CLI flag > config default > (undefined -> initState's 3/1 fallback).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCli } from '../src/driver.mjs'

const base = ['node', 'driver.mjs', 'goal', '--artifact', 'a.txt', '--scorer', 'echo 90']

test('config defaults supply plateauWindow/minDelta when no flag is given', () => {
  const cfg = parseCli(base, { plateauWindow: 8, minDelta: 0.5 })
  assert.equal(cfg.plateauWindow, 8)
  assert.equal(cfg.minDelta, 0.5)
})

test('--plateau-window / --min-delta flags override the config default', () => {
  const cfg = parseCli([...base, '--plateau-window', '12', '--min-delta', '0.25'], { plateauWindow: 8, minDelta: 0.5 })
  assert.equal(cfg.plateauWindow, 12)
  assert.equal(cfg.minDelta, 0.25)
})

test('absent from both flag and config -> undefined (initState then falls back to 3/1)', () => {
  const cfg = parseCli(base, {})
  assert.equal(cfg.plateauWindow, undefined)
  assert.equal(cfg.minDelta, undefined)
})
