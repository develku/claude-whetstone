import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveObjective } from '../src/plan-resolve.mjs'

// io-assert is a DATA-only scorer (in the data-only allowlist, inc 2). The fence only sees a Map<id, absPath>.
const allowlist = new Map([['io-assert', '/abs/scorers/io-assert.mjs']])
const ctx = { scopeDir: '/repo', allowlist }
const base = { id: 'o1', goal: 'cover auth', scorerId: 'io-assert', args: ['--case', '1=>1'], editScope: 'src/auth', target: 80 }

test('resolveObjective: happy path builds node <shq path> <shq args> and canonicalizes scope', () => {
  const o = resolveObjective(base, ctx)
  assert.equal(o.scorer, "node '/abs/scorers/io-assert.mjs' '--case' '1=>1'")
  assert.equal(o.editScope, 'src/auth')
  assert.equal(o.id, 'o1')
  assert.equal(o.goal, 'cover auth')
  assert.equal(o.target, 80)
})

test('resolveObjective: shell-metachar args are shq-quoted (never reach a shell unquoted)', () => {
  const o = resolveObjective({ ...base, args: ['--case', "x'; rm -rf / #", '$(whoami)'] }, ctx)
  assert.equal(o.scorer, "node '/abs/scorers/io-assert.mjs' '--case' 'x'\\''; rm -rf / #' '$(whoami)'")
})

test('resolveObjective: a scorer path with spaces is shq-quoted (operator paths can contain spaces)', () => {
  const o = resolveObjective(base, { scopeDir: '/repo', allowlist: new Map([['io-assert', '/My Repo/scorers/io-assert.mjs']]) })
  assert.equal(o.scorer, "node '/My Repo/scorers/io-assert.mjs' '--case' '1=>1'")
})

test('resolveObjective: unknown / off-allowlist / non-string scorerId -> null', () => {
  assert.equal(resolveObjective({ ...base, scorerId: 'test-pass-rate' }, ctx), null) // a SHELL scorer never in this allowlist
  assert.equal(resolveObjective({ ...base, scorerId: 'rm -rf /' }, ctx), null)
  assert.equal(resolveObjective({ ...base, scorerId: 123 }, ctx), null)
  assert.equal(resolveObjective({ ...base, scorerId: { evil: 1 } }, ctx), null)
})

test('resolveObjective: non-array / non-string-element args -> null', () => {
  assert.equal(resolveObjective({ ...base, args: 'not-an-array' }, ctx), null)
  assert.equal(resolveObjective({ ...base, args: ['ok', 5] }, ctx), null)
  assert.equal(resolveObjective({ ...base, args: ['ok', null] }, ctx), null)
  assert.equal(resolveObjective({ ...base, args: undefined }, ctx), null)
})

test('resolveObjective: traversal / absolute editScope -> null (convergeRefusal does NOT check containment)', () => {
  assert.equal(resolveObjective({ ...base, editScope: '../etc' }, ctx), null)
  assert.equal(resolveObjective({ ...base, editScope: '../../etc/passwd' }, ctx), null)
  assert.equal(resolveObjective({ ...base, editScope: '/etc/passwd' }, ctx), null)
  assert.equal(resolveObjective({ ...base, editScope: 'src/../../../etc' }, ctx), null)
})

test('resolveObjective: repo-root editScope (".", "", "./") -> null (refuter BREAK#3)', () => {
  assert.equal(resolveObjective({ ...base, editScope: '.' }, ctx), null)
  assert.equal(resolveObjective({ ...base, editScope: '' }, ctx), null)
  assert.equal(resolveObjective({ ...base, editScope: './' }, ctx), null)
})

test('resolveObjective: sibling-prefix trap (/repo vs /repo-evil) -> null', () => {
  // a sibling that shares the base string prefix must fail the `base + sep` containment check
  assert.equal(resolveObjective({ ...base, editScope: '../repo-evil/src' }, ctx), null)
})

test('resolveObjective: a legitimately nested scope is accepted and canonicalized', () => {
  assert.equal(resolveObjective({ ...base, editScope: './src//app/' }, ctx).editScope, 'src/app')
  assert.equal(resolveObjective({ ...base, editScope: 'src/app' }, ctx).editScope, 'src/app')
})

test('resolveObjective: an absolute-but-in-scope editScope is accepted, canonicalized to relative (L3)', () => {
  // path.resolve ignores base for an absolute arg; /repo/src is inside /repo -> accepted, canon 'src'
  assert.equal(resolveObjective({ ...base, editScope: '/repo/src' }, ctx).editScope, 'src')
})

test('resolveObjective: a non-string allowlist VALUE is rejected, not turned into a garbage command (M1)', () => {
  // self-defense vs an upstream loadPlanAllowlist bug: a non-string mapped value must drop, not run node 'null'
  const bad = new Map([['io-assert', 42]])
  assert.equal(resolveObjective(base, { scopeDir: '/repo', allowlist: bad }), null)
})

test('resolveObjective: non-string / null editScope -> null (must never throw on adversarial input)', () => {
  assert.equal(resolveObjective({ ...base, editScope: 123 }, ctx), null)
  assert.equal(resolveObjective({ ...base, editScope: undefined }, ctx), null)
  assert.equal(resolveObjective({ ...base, editScope: null }, ctx), null)
  assert.equal(resolveObjective(null, ctx), null) // a null proposal never throws
})
