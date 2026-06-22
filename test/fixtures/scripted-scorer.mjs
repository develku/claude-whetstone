#!/usr/bin/env node
// Test-only scorer: deterministic by pass index so the driver pipeline can be
// exercised end-to-end without a real model or a real scoring task.
// pass 0 -> 50, pass 1 -> 75, pass 2 -> 100 (caps at 100).
const i = process.argv.indexOf('--pass')
const pass = i >= 0 ? parseInt(process.argv[i + 1], 10) : 0
const score = Math.min(100, 50 + pass * 25)
process.stdout.write(JSON.stringify({ score, critique: `pass ${pass} critique`, findings: [] }))
