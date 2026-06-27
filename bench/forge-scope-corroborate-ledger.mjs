#!/usr/bin/env node
// bench/forge-scope-corroborate-ledger.mjs
// $0 ledger for corroborate-on-scope (frontier 2a ported to repo mode). With a deterministic stub proposer and
// tiny REAL oracle scripts (no model spend), it proves an independent operator oracle gates SCOPE learning:
//   - no oracle           => inert passthrough, learning proceeds
//   - a RIGHT oracle      => accepts the honest good, rejects the gamed bad => agrees => learning proceeds
//   - a WRONG oracle      => rejects the honest good => disputes the veto framing => DECLINES the WHOLE fire
// The RIGHT oracle reads src/m.mjs RELATIVE TO CWD, so it only resolves correctly because scope oracles run with
// cwd = the materialized worktree (not the live tree) — an end-to-end guard of that contract.
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { runScopeForgeHook } from '../src/forge/scope-hook.mjs'
import { loadStore, checkStorePath } from '../src/forge/store.mjs'
import { formatSpend } from '../src/spend-format.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const IO_ASSERT = join(REPO, 'scorers', 'io-assert.mjs')
const tmp = (p) => mkdtempSync(join(tmpdir(), p))
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
const stubPropose = async () => ({ text: JSON.stringify({ candidates: [{ scorerId: 'io-assert', args: ['--fn', 'f', '--case', '2=>4'], rationale: '' }] }) })

const oracle = (body) => { const p = join(tmp('oracle-'), 'o.mjs'); writeFileSync(p, body); return `node ${p}` }
const WRONG = oracle("process.stdout.write(JSON.stringify({score:0,critique:'',findings:[]}))\n") // rejects everything, incl. the honest good
const RIGHT = oracle("import {readFileSync} from 'node:fs'\nlet s=-1\ntry{s=readFileSync('src/m.mjs','utf8').includes('* 2')?100:0}catch{}\nprocess.stdout.write(JSON.stringify({score:s,critique:'',findings:[]}))\n")

const setupRepo = () => {
  const dir = tmp('scope-corr-')
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'm.mjs'), 'export const f = (n) => n * 3\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'gamed')
  const gamedSha = git(dir, 'rev-parse', 'HEAD')
  writeFileSync(join(dir, 'src', 'm.mjs'), 'export const f = (n) => n * 2\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'honest')
  return { dir, gamedSha }
}

async function runOne(label, oracleCmds) {
  const { dir, gamedSha } = setupRepo()
  const storePath = checkStorePath(tmp('scope-corr-store-'))
  const cfg = { forge: true, forgeStorePath: storePath, scorerAllow: [IO_ASSERT], model: 'sonnet', forgeOracleCmds: oracleCmds }
  const state = { goal: 'f doubles n', artifact_path: dir, last_critique: '', confirm_vetoed_at_pass: 0, history: [{ snapshot: gamedSha }] }
  const r = await runScopeForgeHook({ cfg, state }, { propose: stubPropose, log: () => {} })
  const learned = loadStore(storePath).checks.filter((c) => c.kind === 'scope').length
  return { label, corroborated: r.corroborated, conflicts: (r.conflicts || []).length, learned, tokens: r.tokens ?? 0, costUsd: r.costUsd ?? 0 }
}

console.log('\n=== Forge scope corroboration ledger ($0, stub proposer + real oracles) ===\n')
const rows = [
  await runOne('no oracle (control)', []),
  await runOne('RIGHT oracle (agrees)', [RIGHT]),
  await runOne('WRONG oracle (rejects good)', [WRONG]),
]
for (const r of rows) console.log(`[${r.label.padEnd(27)}] corroborated=${r.corroborated} conflicts=${r.conflicts} learned=${r.learned} spent=${formatSpend({ tokens: r.tokens, costUsd: r.costUsd })}`)

const [control, right, wrong] = rows
const ok = control.learned === 1 && right.learned === 1 && right.corroborated && wrong.learned === 0 && !wrong.corroborated && wrong.conflicts === 1
console.log('\n' + (ok
  ? 'reading: corroborate-on-scope works — no-oracle and a RIGHT oracle both learn (1 check); a WRONG oracle that\nrejects the honest good DECLINES the whole fire (0 learned, conflict surfaced). Independent oracles gate scope learning.'
  : `reading: UNEXPECTED — control=${control.learned} right=${right.learned}/${right.corroborated} wrong=${wrong.learned}/${wrong.corroborated}/${wrong.conflicts}. Inspect.`))
process.exit(ok ? 0 : 1)
