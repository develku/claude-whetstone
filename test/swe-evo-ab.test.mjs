// test/swe-evo-ab.test.mjs
// The A/B driver's $0-testable surface: the 4-arm plan, the scope-cli command constructor (incl. the
// double-nested shell quoting scorer->runner), offline truth grading, and the stub-injected orchestration
// that proves the whole A/B records correctly at $0 (no editor, no Docker). The real setup/run/grade
// seams (docker checkout, spawn scope-cli, spawn runner) are exercised in the feasibility/pilot phase.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planArms, scorerCommand, buildArmCommand, gradeTruth, runAB } from '../bench/swe-evo/ab.mjs'
import { shq } from '../src/shq.mjs'

const PATHS = {
  scopeCliPath: '/w/src/scope-cli.mjs',
  scorerPath: '/w/bench/swe-evo/scorer.mjs',
  runnerPath: '/w/bench/swe-evo/runner.mjs',
  checkoutDir: '/tmp/co',
  instJson: '/tmp/inst.json',
  vNodes: '/tmp/v.json',
  cNodes: '/tmp/c.json',
  allNodes: '/tmp/all.json',
  storeDir: '/tmp/store',
}
const SPLIT = { vFiles: ['tests/v.py'], cFiles: ['tests/c.py'], allFiles: ['tests/v.py', 'tests/c.py', 'tests/t.py'], readOnly: ['tests/'] }
const COMMON = { paths: PATHS, split: SPLIT, goal: 'add the feature', model: 'sonnet', effort: 'medium', cap: 20, budgetTokens: 500000 }
const argvOf = (arm) => buildArmCommand({ arm, ...COMMON }).argv
const flag = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }

test('planArms returns the 4 ablation arms with the chaining flags', () => {
  const a = planArms()
  assert.deepEqual(a.map((x) => x.id), ['baseline', 'confirm', 'confirm-forge', 'capability'])
  assert.deepEqual(a.find((x) => x.id === 'baseline'), { id: 'baseline', confirm: false, forge: false, capability: false })
  assert.equal(a.find((x) => x.id === 'confirm-forge').forge, true)
  assert.equal(a.find((x) => x.id === 'capability').capability, true)
})

test('scorerCommand nests a shq-quoted runner inside the scorer string (V gets --reveal-nodes)', () => {
  const s = scorerCommand({ scorerPath: '/w/s.mjs', runnerPath: '/w/r.mjs', instJson: '/i.json', nodesPath: '/v.json', testFiles: ['tests/v.py'], reveal: true })
  assert.match(s, /--nodes '\/v\.json'/)
  assert.match(s, /--reveal-nodes/)
  // the runner is one shq-quoted argument — so its OWN quotes are escaped (the '\'' sequence). Assert the
  // exact nested form rather than a naive regex (which is the very trap this double-nesting test guards).
  const innerRunner = `node ${shq('/w/r.mjs')} --instance-json ${shq('/i.json')} --test-files ${shq('tests/v.py')}`
  assert.ok(s.includes(`--runner ${shq(innerRunner)}`), 'runner is nested as a single shq-quoted arg')
})

test('scorerCommand round-trips through BOTH shell levels to a real score (fake canned runner, $0)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-rt-'))
  // a fake runner that ignores its args and prints a canned results map — stands in for the Docker runner
  const fakeRunner = join(dir, 'r.mjs')
  writeFileSync(fakeRunner, "process.stdout.write(JSON.stringify({'f::a':'pass','f::b':'fail'}))\n")
  const nodes = join(dir, 'v.json')
  writeFileSync(nodes, JSON.stringify({ failNodes: ['f::a', 'f::b'], passToPass: [] }))
  const scorerPath = join(process.cwd(), 'bench', 'swe-evo', 'scorer.mjs')
  const s = scorerCommand({ scorerPath, runnerPath: fakeRunner, instJson: '/unused.json', nodesPath: nodes, testFiles: ['tests/v.py'], reveal: true })
  // exec the scorer string through a shell exactly as scope-cli's runScopeScorer would (shell:true)
  const r = spawnSync(`${s} --output ${dir} --pass 0001`, { shell: true, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).score, 50) // 1 of 2 F2P pass -> the whole nesting resolved
})

test('baseline arm: V scorer + read-only, NO confirm, NO forge', () => {
  const argv = argvOf({ id: 'baseline', confirm: false, forge: false, capability: false })
  assert.equal(argv[0], COMMON.paths.scopeCliPath)
  assert.equal(argv[1], 'add the feature') // goal positional
  assert.equal(flag(argv, '--scope'), '/tmp/co')
  assert.ok(flag(argv, '--scorer').includes('--reveal-nodes')) // V is the visible scorer
  assert.equal(flag(argv, '--read-only'), 'tests/')
  assert.equal(argv.includes('--confirm-scorer'), false)
  assert.equal(argv.includes('--forge'), false)
  assert.equal(flag(argv, '--budget-tokens'), '500000')
})

test('+confirm arm: adds a held-out C confirm scorer (no reveal), still no forge', () => {
  const argv = argvOf({ id: 'confirm', confirm: true, forge: false, capability: false })
  const conf = flag(argv, '--confirm-scorer')
  assert.ok(conf, 'has a confirm scorer')
  assert.ok(conf.includes("--nodes '/tmp/c.json'"), 'confirm grades the C node-set')
  assert.equal(conf.includes('--reveal-nodes'), false) // source isolation: C critique is counts-only
  assert.equal(argv.includes('--forge'), false)
})

test('+confirm+forge arm: confirm scorer + --forge --forge-store OUTSIDE the scope', () => {
  const argv = argvOf({ id: 'confirm-forge', confirm: true, forge: true, capability: false })
  assert.ok(flag(argv, '--confirm-scorer'))
  assert.equal(argv.includes('--forge'), true)
  assert.equal(flag(argv, '--forge-store'), '/tmp/store')
})

test('capability arm: V scorer points at the FULL node-set/test-files (oracle upper bound), no confirm/forge', () => {
  const argv = argvOf({ id: 'capability', confirm: false, forge: false, capability: true })
  const sc = flag(argv, '--scorer')
  assert.ok(sc.includes(`--nodes ${shq('/tmp/all.json')}`), 'capability grades against the full node-set')
  // the runner (carrying the FULL test-file set) is nested as a single shq-quoted --runner arg
  const innerRunner = `node ${shq(PATHS.runnerPath)} --instance-json ${shq(PATHS.instJson)} --test-files ${shq('tests/v.py,tests/c.py,tests/t.py')}`
  assert.ok(sc.includes(`--runner ${shq(innerRunner)}`), 'capability runs the full test-file set')
  assert.equal(argv.includes('--confirm-scorer'), false)
  assert.equal(argv.includes('--forge'), false)
})

test('gradeTruth runs the injected runner on T files and Fix-Rates the held-out T node-set', async () => {
  const runResults = async (files) => {
    assert.deepEqual(files, ['tests/t.py']) // grades against T's files only
    return { 'tests/t.py::t1': 'pass', 'tests/t.py::t2': 'fail', 'p::x': 'pass' }
  }
  const g = await gradeTruth({ tNodes: ['tests/t.py::t1', 'tests/t.py::t2'], tFiles: ['tests/t.py'], passToPass: ['p::x'], runResults })
  assert.equal(g.T, 50)
  assert.equal(g.resolved, false)
})

test('runAB orchestrates instances x arms and records one JSONL row per (instance, arm) — $0 stub', async () => {
  const instances = [{ instanceId: 'a__a_1_2' }, { instanceId: 'b__b_3_4' }]
  const lines = []
  const rows = await runAB({
    instances,
    setupInstance: async (inst) => ({ ok: true, inst }), // never null -> nothing excluded
    runArm: async ({ arm }) => ({ V: 80, C: arm.confirm ? 60 : null, veto: arm.confirm ? 1 : 0, tokens: 1000, usd: 0.01 }),
    gradeTruthFn: async ({ arm }) => ({ T: arm.capability ? 90 : 40, resolved: false }),
    write: (l) => lines.push(l),
  })
  assert.equal(rows.length, 8) // 2 instances x 4 arms
  assert.equal(lines.length, 8)
  const r0 = JSON.parse(lines[0])
  assert.deepEqual(Object.keys(r0).sort(), ['C', 'T', 'V', 'arm', 'error', 'instance_id', 'resolved', 'status', 'tokens', 'usd', 'veto'].sort())
  assert.equal(r0.arm, 'baseline')
  assert.equal(r0.C, null) // baseline has no confirm
  assert.equal(r0.status, null) // stub runArm reports no status -> null (only a terminal 'error' is acted on)
  assert.equal(JSON.parse(lines[1]).C, 60) // +confirm arm recorded its C
})

test('runAB skips an instance whose setup returns null (excluded: <3 V/C/T clusters)', async () => {
  const rows = await runAB({
    instances: [{ instanceId: 'x' }, { instanceId: 'y' }],
    setupInstance: async (inst) => (inst.instanceId === 'x' ? null : { ok: true }),
    runArm: async () => ({ V: 1, C: null, veto: 0, tokens: 0, usd: 0 }),
    gradeTruthFn: async () => ({ T: 1, resolved: false }),
    write: () => {},
  })
  assert.equal(rows.length, 4) // only 'y' x 4 arms
  assert.ok(rows.every((r) => r.instance_id === 'y'))
})
