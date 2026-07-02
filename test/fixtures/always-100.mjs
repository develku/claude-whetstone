#!/usr/bin/env node
// A trivial $0 scorer: always reports 100, ignores its --output/--loop-dir/--pass args. Used by the driver
// preflight entry test to make the baseline immediately `done` (no editor spawn, no spend).
process.stdout.write(JSON.stringify({ score: 100, critique: 'ok' }))
