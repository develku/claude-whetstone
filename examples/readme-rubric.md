# claude-whetstone README scoring rubric

You score ONE artifact: the current `README.md` text passed to you. You have **no file tools**, one turn. Return JSON `{score: 0-100, critique: string, findings: []}`. The loop's CODE gate stops at `score >= 90`, so be calibrated and skeptical: 90+ means every one of the six required topics is genuinely satisfied **and** zero measured facts were lost or altered.

## How to score

Score each criterion against its checks, multiply by its weight, sum to a 0–100 integer. Then apply the HARD CAPS below — a cap **overrides** the arithmetic sum (if a cap is lower than the sum, the cap wins; strong criteria can never lift the total past a cap).

| # | Criterion | Weight |
|---|---|---|
| 1 | Anti-regression — measured facts survive verbatim | 30 |
| 2 | Installation — present, correct, copy-pasteable | 11 |
| 3 | Usage / Quickstart — a real runnable example | 11 |
| 4 | How it works — code/model/scorer ownership, with the causal *why* | 12 |
| 5 | Visual diagram — inline Mermaid, accurate to the loop | 14 |
| 6 | Well-organized — order, scannable, no filler/redundancy | 11 |
| 7 | Easy to read — plain language, no assumed context | 11 |
| | **Total** | **100** |

### HARD CAPS (apply after the weighted sum; lowest cap wins)
- **Six-pillar cap.** Criteria 2–7 each map to one required topic (Install, Usage, How-it-works, Diagram, Organization, Readability). If **any one** of criteria 2–7 scores below 50% of its weight, **cap the total at 84** and say which pillar failed. No single missing/hollow pillar may be averaged away.
- **Single-fact cap.** If **any one** atomic fact in *Measured facts that must survive* is dropped, altered, mis-attributed, or softened, **zero criterion 1 and cap the total at 80**. **Two or more lost/altered facts → cap the total at 60.** Losing hard-won measured data is the worst failure here; the README already contains every fact, so losing one is a regression, never an improvement.
- **Anti-bloat cap.** If **two or more** sections contain no concrete fact, command, number, or mechanism beyond their heading (pure filler / self-description), **cap the total at 80** and name them. A longer README is not a better one.
- **Broken-diagram cap.** If the Mermaid block would not parse (see criterion 5), criterion 5 scores **0** and the six-pillar cap fires.

---

## Criterion 1 — Anti-regression (weight 30)

Treat every atomic fact in *Measured facts that must survive* as a tripwire. **Substance, not decoration:** a number quoted in isolation with no surrounding mechanism/qualifier scores at most half. Each number must keep its provenance ("directly measured 2026-06-22, not hand-waved") and its consequence (e.g. the ~44K tax leads to "use `--model haiku`").

**Number oracle — string-match exactly.** You cannot read the repo, so the canonical values below ARE the source of truth. Any deviation, even a plausible one, is an altered fact → single-fact cap:
- Opus per-call = **$0.22** · Haiku per-call = **~$0.05** · context tax = **~44K tokens** · Opus@`--cap 10` = **~$2.2+** · validation = **$0.05**.

Deduct (and fire the single-fact cap) for any of: a dollar/token figure dropped, changed, or mis-attributed (e.g. $0.22 labelled Haiku); the **"even with no CLAUDE.md and no MCP"** qualifier removed; the **"directly measured … not hand-waved"** provenance removed; the `--bare` "Not logged in" finding OR the `--mcp-config empty-mcp.json` workaround dropped (both halves required); either prior-art credit dropped or genericized; the cap-reuse / promise-gate-→-score-threshold distinction erased; the `acceptEdits`-unattended-in-the-artifact's-own-directory safety reality, the own-directory specificity, OR the "do not point at a broad write/exec repo / scope the blast radius" warning weakened to generic "be careful"; the untrusted-critique soft-fence fact dropped; the confirm-scorer veto fact dropped; the `TODO → DONE @ pass 1 on Haiku for $0.05` validation dropped.

---

## Criterion 2 — Installation (weight 11)

Pass only if BOTH commands appear **verbatim**, in order, inside a fenced code block, copy-pasteable with no placeholder:
```
claude plugin marketplace add develku/claude-whetstone
claude plugin install whetstone@whetstone
```
Fail signals: either command missing/paraphrased/prose-only; wrong handle (`install whetstone`, `add whetstone`, wrong owner/repo, missing `@whetstone`); order inverted; `npm install`/`git clone` presented as the primary install path.

## Criterion 3 — Usage / Quickstart (weight 11)

Pass only if a fenced block shows a real `node src/driver.mjs "<goal>"` invocation with `--artifact`, `--scorer`, and at least one bound (`--target`/`--cap`/`--budget`). The `--scorer` argument must name one of the **real** scorers verbatim: `scorers/test-pass-rate.mjs`, `scorers/composite.mjs`, or `scorers/llm-judge.mjs` (an invented scorer path fails on accuracy). The section must also state where run state lands (`.loop/<run>/`: `state.json`, `snapshots/`, `reviews/`) **or** show the `--resume` form, so the example is followable. Fail: hand-wave prose with no command; invented flags; an untouched command block with the output-location sentence missing.

## Criterion 4 — How it works (weight 12)

Must split the three owners concretely — **code** owns the gate (`score >= target`, passes, continue/stop) in `gate.mjs`; **model** owns only diagnose + one edit (`act-claude.mjs`); **scorer** owns the 0–100 number + critique (`scorers/`) — AND carry the **causal** insight. **Reproduction test:** find the single sentence that states *why* the stop-branch living in code (not a prompt) removes the model's self-completion vote — it must carry a because/so/therefore link (the README's is "The model literally cannot vote itself done, because the `score >= target` branch lives in `gate.mjs`, not in a prompt"). If only the tagline/noun-list is present with no causal sentence, score this **≤ 40%**. Fail/zero a check for any role inversion (model decides done, scorer stops the loop, gate emits the score) or for text that merely *describes* the README ("this section explains the model") instead of conveying the mechanism.

## Criterion 5 — Visual diagram (weight 14)

Must be an **inline** ```` ```mermaid ```` fenced flowchart (GitHub-renderable) — not ASCII art, not an image link, not the existing plain-text Loop block.

**Parser trace (you have no renderer — simulate one line by line).** Score 0 (broken-diagram cap) if any holds: first non-blank line inside the fence is not `flowchart TD`/`flowchart LR`/`graph TD`/`graph LR`; any node id is a Mermaid reserved word (`end`, `graph`, `subgraph`, `class`, `click`) or contains a space; any node **label** contains unescaped `()[]{}<>|` not wrapped in quotes; unbalanced `[` `]` `{` `}` `(` `)`; an edge references an undeclared node id.

**Structural accuracy** (enumerate every edge; classify each as forward / back / terminal):
- Stages appear in order: a once-only **baseline** entry → **ACT → OBSERVE → SCORE → PERSIST → GATE**.
- GATE is a decision node fanning to **exactly** the five real verdicts: `done`, `capped`, `plateau`, `error`, `running` — no invented states (`success`/`fail`/`pass`), none omitted.
- `running` is the **only** edge re-entering the cycle, and it must target **ACT** specifically (not baseline, not OBSERVE). baseline has **no** inbound edge from the cycle.
- `done`, `capped`, `plateau`, `error` are **terminal** — no outgoing edge back into the loop. Any terminal verdict with a back-edge, more than one back-edge, or `running` not reaching ACT → fail the criterion regardless of correct node labels.
- The diagram must **not contradict** the README's own Loop section on stage order or which verdict loops back; if it does, cap criterion 5 at 40% of weight.

**Scope note (do not over-penalize):** this is the deliberately simplified happy-path view. It must be *correct for what it shows*, but is **not required** to depict the no-op guard, plateau→escalation/rescue, confirm-scorer veto, or budget-as-`capped`. Do not demand those nodes.

## Criterion 6 — Well-organized (weight 11)

Coherent newcomer-first flow (what-it-is → how-it-works → diagram → quickstart → cost/auth/safety → install → prior art; order may vary if it reads coherently). Headings scannable; each required topic findable by skim; the cost/auth/safety warning reachable **before** the reader is told to do a live run. Fail signals: same fact restated verbatim across 3+ sections; a required topic with no heading; jarring order (prior-art or Layout above the plain-English intro). **Filler fail signal:** any section whose body could be deleted without losing a concrete fact/command/number/mechanism is filler — each filler section caps this criterion at 50% and must be named in findings (two+ → anti-bloat cap). Self-describing text ("this guide is well-organized") counts as filler, scores zero for the check it appears to satisfy.

## Criterion 7 — Easy to read (weight 11)

Opens with a 1–2 sentence plain-language statement of what whetstone is **before** any flag/filename/jargon. Short paragraphs (≤ ~4 sentences); facts in tables/lists over walls of text. Jargon (loop engineering, gate, scorer, plateau, rescue mode, no-op guard, composite, context tax) defined or self-evident on first use — **read the opening as if you have never heard of loop engineering**; if you hit an undefined insider term or a flag/filename before the plain idea, dock this criterion. Fail signals: dense multi-clause sentences; empty marketing adjectives (powerful, seamless, robust, comprehensive, cutting-edge, simply) with no measured claim attached; reads like internal notes assuming you've seen the code or the talk.

---

## Measured facts that must survive (atomic checklist — each item is one tripwire)

1. Opus per-call cost = **$0.22**.
2. Haiku per-call cost = **~$0.05**.
3. Context tax = **~44K tokens**, with the qualifier **"even with no CLAUDE.md and no MCP loaded"** (the qualifier is load-bearing).
4. Provenance: numbers are **directly measured 2026-06-22, not hand-waved**.
5. Budget realism: **Opus at `--cap 10` ≈ $2.2+ per loop in overhead alone** → use `--model haiku`/sonnet for the act step.
6. `--budget` is checked **after each pass**, so it can overshoot by one pass — pair it with `--cap`.
7. `--bare` **fails** on OAuth/subscription (Max/Pro) auth — returns **"Not logged in"**, needs `ANTHROPIC_API_KEY`.
8. `--mcp-config empty-mcp.json --strict-mcp-config` **works** (`mcp_servers → []`); empty config bundled at `empty-mcp.json` — the real cost lever.
9. Prior art: the "external evaluator owns the gate" thesis is from the **Loop Engineering** talk (코드팩토리).
10. Prior art: the code-owned hard-cap-with-re-injection pattern is the **Ralph Wiggum** technique / official **ralph-loop** plugin — whetstone **reuses its code-owned cap but replaces the model-emitted "promise" completion gate with a real score threshold** (this distinction is its own atomic fact).
11. Safety: the act step runs nested `claude -p` with **`acceptEdits`, unattended (no human in the loop), in the artifact's OWN directory** (inheriting that project's permissions).
12. Safety: **scope the artifact's project so the blast radius is just that artifact; do NOT point the loop at a repo with broad write/exec grants.**
13. Safety: the scorer critique fed to the editor is **untrusted data**; the prompt fences it (a *soft* mitigation) — the real control is the project's allow/deny permission scope.
14. Confirm-scorer: `--confirm-scorer` re-checks **only when the gate says done** and **vetoes a gamed `done`** (anti-reward-hacking layer).
15. Validation: **`TODO → DONE` converged at pass 1 on Haiku for $0.05** (2026-06-22) — gate owned the stop, model owned the edit, scorer owned the number.
16. Install: `claude plugin marketplace add develku/claude-whetstone` then `claude plugin install whetstone@whetstone`.
17. Gate verdicts: **done, capped, plateau, error, running**; precedence **error > done > capped > plateau > running**.

---

## Judge instructions

Be skeptical and deduct for inaccuracy — reward substance, never surface. A criterion does NOT pass because a heading or keyword exists: install commands must be the exact real handles; the Mermaid must trace clean AND match the real control flow; how-it-works must carry the causal *why* sentence, not just the tagline; the quickstart must use a real scorer path. Treat every "must survive" fact as a tripwire and apply the single-fact / two-fact caps strictly via the number oracle — you cannot read the repo, so the canonical values in this rubric are your only source of truth; a plausible-but-different number is an altered fact. Do not reward verbosity or added empty sections — bloat is a regression, fire the anti-bloat cap.

**`critique` (load-bearing — fed verbatim into the next edit):** exactly ONE sentence naming the SINGLE highest-impact concrete next fix, with the exact target string/section and the exact change. Priority order for which fix to name: (1) any lost or altered measured fact — name the exact fact and where to restore it; else (2) a broken/missing/inaccurate Mermaid — say e.g. "add a fenced ```mermaid flowchart: baseline→ACT→OBSERVE→SCORE→PERSIST→GATE, GATE branching to done/capped/plateau/error/running, only running looping back to ACT, the four terminal verdicts as dead-ends"; else (3) a wrong install/quickstart command — give the exact correct command; else (4) the lowest-scoring remaining criterion with the specific rewrite. Never vague ("improve clarity"), never a list — one fix. If `score >= 90`, still name the single most valuable remaining polish so the loop has a gradient. Populate `findings` with one short string per criterion that lost points, each citing the specific missing/wrong/altered element. Never invent praise to inflate the score — a premature `done` wastes real spend.