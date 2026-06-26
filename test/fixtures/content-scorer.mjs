#!/usr/bin/env node
// Test fixture scorer: scores by ARTIFACT CONTENT — 100 if the --output file contains --needle, else 0.
// Lets scorerRunCheck's score>=target -> pass mapping be exercised deterministically against real files.
import { readFileSync } from 'node:fs'
const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined }
const body = (() => { try { return readFileSync(arg('--output'), 'utf8') } catch { return '' } })()
const score = body.includes(arg('--needle') ?? ' ') ? 100 : 0
process.stdout.write(JSON.stringify({ score, critique: score ? 'needle present' : 'needle absent', findings: [] }))
