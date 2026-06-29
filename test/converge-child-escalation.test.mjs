import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConvergeCli } from '../src/converge-cli.mjs'
import { buildObjectiveCfg } from '../src/converge.mjs'

// A converge child is its own objective unit; like a decompose child (decompose.mjs hardcodes
// noEscalate:true) it must NOT do a second opus escalation inside. converge.mjs expresses this as the
// overridable default `cfg.noEscalate ?? true`. parseConvergeCli used to force noEscalate:false when
// --no-escalate was absent, defeating that default so every converge child DID escalate on plateau —
// the opposite of intent, doubling per-objective opus spend, and diverging from the outer-cli path
// (which omits the key and so gets the intended no-escalate default).
const obj = { id: 'o1', goal: 'g', scorer: 'node s.mjs', editScope: 'src/x', target: 90 }
const childOf = (parentCfg) => buildObjectiveCfg(obj, { cycle: 0 }, parentCfg, '/tmp/wt', [], { usd: null, tokens: 1000 })

test('a converge child does NOT escalate by default (no --no-escalate) — matches decompose', () => {
  const parsed = parseConvergeCli(['--scope', '/r', '--objectives', '/m.json'])
  assert.equal(childOf(parsed).noEscalate, true)
})

test('--no-escalate on a converge run also yields a non-escalating child', () => {
  const parsed = parseConvergeCli(['--scope', '/r', '--objectives', '/m.json', '--no-escalate'])
  assert.equal(childOf(parsed).noEscalate, true)
})

test('an explicit programmatic noEscalate:false still overrides the default (the knob stays live)', () => {
  // converge.mjs deliberately uses `?? true` (an overridable default), not a hardcode — a non-CLI caller
  // can still opt a child into escalation. Only the CLI no longer forces false.
  const cfg = { model: 'sonnet', effort: 'medium', escalateModel: 'opus', convergeDir: '/tmp/c', mcpConfig: null, noEscalate: false }
  assert.equal(childOf(cfg).noEscalate, false)
})
