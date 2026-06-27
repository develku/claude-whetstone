#!/usr/bin/env node
// bench/forge-mutation-realmodel.mjs
// Item 1 paid proof: exercise mutation-backed admit against REAL model-proposed checks. The $0 ledger proves
// the mechanism on hand-written weak/strong checks; this proves the STRENGTHENING runs against a real proposer.
// For each stateful scenario we do ONE real `claude` generate (the model sees the honest + gamed bodies and
// proposes checks), then at $0 apply BOTH admission policies to the SAME captured candidates:
//   admitCheck      — passes good, fails the observed bad (today's gate)
//   mutationAdmit    — also kills >= threshold of an oracle-confirmed mutant neighbourhood (item 1)
// The DELTA (admitCheck-admitted minus mutationAdmit-admitted) is the count of pointwise-overfit checks the new
// gate catches. delta >= 1 anywhere => NON-NULL (a real model proposed an overfit check the strengthening
// rejects). delta == 0 is an HONEST no-harm reading (the model proposed only generalizing checks; mutationAdmit
// admitted them on their real kill-ratio and rejected nothing — the desired inert-when-strong property).
//
//   node bench/forge-mutation-realmodel.mjs --verify        # $0 — sanity-check scenarios (weak rej / strong adm)
//   node bench/forge-mutation-realmodel.mjs --model sonnet  # ~$0.5 real generate
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scorerRunCheck, admitCheck } from '../src/forge/admit.mjs'
import { mutationAdmit } from '../src/forge/mutation-admit.mjs'
import { generateCandidates, claudePropose } from '../src/forge/generate.mjs'
import { forgeAllowlist, forgeCatalog } from '../src/forge/hook.mjs'
import { shq } from '../src/shq.mjs'
import { formatSpend } from '../src/spend-format.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SCORERS = ['contains', 'io-assert', 'io-trace', 'io-invariant'].map((s) => join(REPO, 'scorers', `${s}.mjs`))
const IO_TRACE = join(REPO, 'scorers', 'io-trace.mjs')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const model = arg('--model', 'sonnet')
const writeSrc = (src) => { const p = join(mkdtempSync(join(tmpdir(), 'mut-rm-')), 'impl.mjs'); writeFileSync(p, src); return p }
const traceCmd = (sub, trace, expect) => `node ${shq(IO_TRACE)} ${sub} --trace ${shq(trace)} --expect ${shq(expect)}`

const SCENARIOS = [
  {
    id: 'counter',
    goal: 'makeCounter() returns { inc(), value() }: inc increments a private count and returns it, value reads it',
    honest: 'export const makeCounter = () => { let n = 0; return { inc() { return ++n }, value() { return n } } }\n',
    gamed: 'export const makeCounter = () => ({ inc() {}, value() { return 1 } })\n',
    oracle: ['--factory makeCounter', '[["inc"],["value"],["inc"],["value"]]', '[1,1,2,2]'],
  },
  {
    id: 'toggle',
    goal: 'makeToggle() returns { toggle(), state() }: toggle flips a boolean and returns the new value, state reads it',
    honest: 'export const makeToggle = () => { let on = false; return { toggle() { on = !on; return on }, state() { return on } } }\n',
    gamed: 'export const makeToggle = () => ({ toggle() { return true }, state() { return true } })\n',
    oracle: ['--factory makeToggle', '[["toggle"],["state"],["toggle"],["state"]]', '[true,true,false,false]'],
  },
]

// --- $0 preflight: each scenario must admit a hand-written STRONG check and (via mutationAdmit) reject a WEAK one
function verifyScenarios() {
  const checks = {
    counter: { weak: traceCmd('--factory makeCounter', '[["value"]]', '[0]'), strong: traceCmd('--factory makeCounter', '[["inc"],["value"]]', '[1,1]') },
    toggle: { weak: traceCmd('--factory makeToggle', '[["state"]]', '[false]'), strong: traceCmd('--factory makeToggle', '[["toggle"],["toggle"],["state"]]', '[true,false,false]') },
  }
  let ok = true
  ;(async () => {
    for (const sc of SCENARIOS) {
      const good = writeSrc(sc.honest), bad = writeSrc(sc.gamed)
      const oracle = traceCmd(...sc.oracle)
      const c = checks[sc.id]
      const wB = (await admitCheck({ candidateCmd: c.weak, goodArtifact: good, badArtifact: bad, replayRuns: 2, runCheck: scorerRunCheck })).admit
      const wM = (await mutationAdmit({ candidateCmd: c.weak, goodArtifact: good, badArtifact: bad, replayRuns: 2, runCheck: scorerRunCheck, oracleCmds: [oracle], minConfirmedMutants: 1 })).admit
      const sM = (await mutationAdmit({ candidateCmd: c.strong, goodArtifact: good, badArtifact: bad, replayRuns: 2, runCheck: scorerRunCheck, oracleCmds: [oracle], minConfirmedMutants: 1 })).admit
      const good_ = wB === true && wM === false && sM === true
      ok = ok && good_
      console.log(`${good_ ? 'OK  ' : 'BAD '} ${sc.id}: weak(admitCheck=${wB},mutationAdmit=${wM}) strong(mutationAdmit=${sM})`)
    }
    console.log(ok ? '\nALL scenarios verify — safe to spend.' : '\nSOME scenarios BROKEN — fix before spending.')
    process.exit(ok ? 0 : 1)
  })()
}
if (process.argv.includes('--verify')) { verifyScenarios() }

// --- real run: one generate per scenario, then compare admit policies on the SAME candidates
async function runScenario(sc) {
  const good = writeSrc(sc.honest), bad = writeSrc(sc.gamed)
  const oracle = traceCmd(...sc.oracle)
  const allowlist = forgeAllowlist(SCORERS)
  const gen = await generateCandidates({
    goal: sc.goal, goodArtifact: good, badArtifact: bad, critique: 'the gamed artifact special-cased the visible behaviour without a general implementation',
    scorerCatalog: forgeCatalog(allowlist), allowlist, propose: (p) => claudePropose(p, { model }), maxCandidates: 5,
  })
  const rows = []
  for (const c of gen.candidates) {
    const b = await admitCheck({ candidateCmd: c.cmd, goodArtifact: good, badArtifact: bad, replayRuns: 2, runCheck: scorerRunCheck })
    const m = await mutationAdmit({ candidateCmd: c.cmd, goodArtifact: good, badArtifact: bad, replayRuns: 2, runCheck: scorerRunCheck, oracleCmds: [oracle], minConfirmedMutants: 2 })
    rows.push({ scorerId: c.scorerId, baseAdmit: b.admit, mutAdmit: m.admit, mutation: m.mutation ?? null, overfitCaught: b.admit === true && m.admit === false })
  }
  return { id: sc.id, proposed: gen.candidates.length, rejectedByAllowlist: gen.rejected.length, costUsd: gen.costUsd ?? 0, tokens: gen.tokens ?? 0, rows }
}

console.log(`\n=== Forge mutation-backed admit real-model elicitation (model=${model}, ${SCENARIOS.length} stateful scenarios) ===\n`)
const results = []
for (const sc of SCENARIOS) { process.stderr.write(`running ${sc.id}...\n`); results.push(await runScenario(sc)) }

for (const r of results) {
  console.log(`[${r.id}] proposed=${r.proposed} spent=${formatSpend({ tokens: r.tokens, costUsd: r.costUsd })}`)
  for (const row of r.rows) {
    const mu = row.mutation
    const kr = mu && mu.confirmedMutants != null ? `kill ${mu.killed}/${mu.confirmedMutants}` : (mu?.skipped ?? mu?.note ?? '')
    console.log(`   ${row.scorerId.padEnd(11)} admitCheck=${row.baseAdmit ? 'ADMIT' : 'reject'} mutationAdmit=${row.mutAdmit ? 'ADMIT' : 'REJECT'} (${kr})${row.overfitCaught ? '  ← OVERFIT CAUGHT' : ''}`)
  }
}

const allRows = results.flatMap((r) => r.rows)
const baseAdmitted = allRows.filter((r) => r.baseAdmit).length
const mutAdmitted = allRows.filter((r) => r.mutAdmit).length
const overfitCaught = allRows.filter((r) => r.overfitCaught).length
const totalTokens = results.reduce((s, r) => s + r.tokens, 0)
const cost = results.reduce((s, r) => s + r.costUsd, 0)
console.log(`\n=== aggregate ===`)
console.log(`real proposals scored:      ${allRows.length}`)
console.log(`admitCheck would store:     ${baseAdmitted}`)
console.log(`mutationAdmit stores:       ${mutAdmitted}`)
console.log(`pointwise-overfit caught:   ${overfitCaught} (admitCheck admits, mutationAdmit rejects)`)
console.log(`total generate spend:       ${formatSpend({ tokens: totalTokens, costUsd: cost })}`)
console.log(
  overfitCaught > 0
    ? `\nreading: NON-NULL — a real ${model} proposed ${overfitCaught} check(s) that admitCheck would have stored but mutationAdmit\nrejects as pointwise-overfit (kills < threshold of a real oracle-confirmed mutant neighbourhood). The strengthening\nfires against a real proposer, not just the $0 ledger's hand-written weak check.`
    : `\nreading: NO-HARM — the real ${model} proposed only generalizing checks here (${mutAdmitted}/${baseAdmitted} admitted by BOTH gates),\nso mutationAdmit rejected nothing. This is the desired inert-when-strong property: the strengthening costs nothing\nwhen proposals are already strong, and the OVERFIT-catching is mechanically proven at $0 (forge-mutation-ledger).`,
)

const reports = join(HERE, 'reports')
if (!existsSync(reports)) mkdirSync(reports, { recursive: true })
const stamp = arg('--stamp', 'latest')
writeFileSync(join(reports, `forge-mutation-realmodel-${stamp}.jsonl`), results.map((r) => JSON.stringify(r)).join('\n') + '\n')
