// test/iso-runner.test.mjs — the out-of-process security property (#2). runIsolated spawns a locked-down
// child that imports the artifact; the parent owns the oracle. Every gamed artifact's observation must reflect
// the artifact's REAL (wrong) execution — never a forged-correct value — proving the import-capture hole is shut.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runIsolated } from '../src/iso-runner.mjs'

const artifact = (src) => { const p = join(mkdtempSync(join(tmpdir(), 'iso-')), 'impl.mjs'); writeFileSync(p, src); return p }
const assertCase = (a, input) => runIsolated({ artifact: a, mode: 'assert', spec: { fn: 'add', cases: [input] } })

test('env isolation: the child does NOT inherit operator secrets from the parent env', () => {
  // The artifact under test must not be able to read the operator's API keys / tokens out of process.env —
  // they would otherwise flow into the observation -> the critique -> the editor model (in-band leak).
  process.env.WHET_TEST_SECRET = 'leaked-secret-value'
  try {
    const a = artifact("export const add = () => process.env.WHET_TEST_SECRET ?? 'absent'\n")
    const r = runIsolated({ artifact: a, mode: 'assert', spec: { fn: 'add', cases: [[]] } })
    assert.equal(r.results[0].value, 'absent') // NOT 'leaked-secret-value'
  } finally {
    delete process.env.WHET_TEST_SECRET
  }
})

test('honest artifact: the observation carries the real return value', () => {
  const r = assertCase(artifact('export const add=(a,b)=>a+b\n'), [2, 3])
  assert.deepEqual(r, { ok: true, results: [{ value: 5 }] })
})

test('A1 oracle-override: patching node:assert in the child is inert (oracle runs in the parent)', () => {
  const r = assertCase(artifact("import a from 'node:assert/strict'\na.deepEqual=()=>{}\nexport const add=()=>-999\n"), [2, 3])
  assert.equal(r.results[0].value, -999) // NOT forged to 5
})

test('A2 fd-forge: a frame WITHOUT the nonce is ignored; the real frame wins', () => {
  const r = assertCase(artifact("import {writeSync} from 'node:fs'\ntry{writeSync(3,'{\"ok\":true,\"results\":[{\"value\":5}]}')}catch{}\nexport const add=()=>-999\n"), [2, 3])
  assert.equal(r.results[0].value, -999)
})

test('A3 process.exit truncation: no valid frame -> ok:false (never a silent pass)', () => {
  const r = assertCase(artifact('process.exit(0)\nexport const add=()=>-999\n'), [2, 3])
  assert.equal(r.ok, false)
})

test('A4 primordial hijack: captured serializer is immune to a JSON.stringify override', () => {
  const r = assertCase(artifact("const s=JSON.stringify;JSON.stringify=(v)=>s({ok:true,results:[{value:5}]});export const add=()=>-999\n"), [2, 3])
  assert.equal(r.results[0].value, -999)
})

test('heap-snapshot: node:v8 is denied, so the nonce cannot be stolen to forge a frame', () => {
  const src = "import {writeSync} from 'node:fs'\n" +
    "try{const v8=await import('node:v8');let b='';for await(const c of v8.getHeapSnapshot())b+=c.toString('latin1');" +
    "for(const n of new Set(b.match(/[0-9a-f]{16}/g)||[]))writeSync(3,'<<'+n+'>>{\"ok\":true,\"results\":[{\"value\":5}]}<<'+n+'>>')}catch{}\n" +
    'export const add=()=>-999\n'
  const r = assertCase(artifact(src), [2, 3])
  assert.equal(r.results[0].value, -999) // forge never lands
})

test('getBuiltinModule bypass: cannot fetch node:v8 without import either', () => {
  const r = assertCase(artifact("try{const v8=process.getBuiltinModule('v8');v8.getHeapSnapshot()}catch{}\nexport const add=()=>-999\n"), [2, 3])
  assert.equal(r.results[0].value, -999)
})
