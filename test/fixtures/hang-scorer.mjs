#!/usr/bin/env node
// Test-only: a sub-scorer that never scores — it sleeps far longer than composite's per-sub
// wall-clock cap so the timeout path (res.error ETIMEDOUT -> die(2)) can be exercised. Ignores argv.
setTimeout(() => {}, 4000)
