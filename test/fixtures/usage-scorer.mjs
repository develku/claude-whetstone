#!/usr/bin/env node
// Test-only scorer: reports its own model spend via the OPTIONAL usage field of the scorer
// contract (v1.6.0) — the shape llm-judge emits, so accounting tests can prove the driver
// charges scorer spend to the budget dials without spawning a model. Reads --output but ignores it.
process.stdout.write(JSON.stringify({ score: 50, critique: 'needs work', findings: [], usage: { tokens: 600000, costUsd: 0.5 } }))
