// bench/swe-evo/fixrate.mjs
// SWE-EVO grading (paper Eq. 1), pure. A results map is { nodeId -> 'pass' | 'fail' | 'missing' }
// produced by the Docker test runner; these functions grade it. Used by the V / C / T scorers so the
// same metric drives the in-loop V signal, the C confirm, and the T truth.
//
// Fix Rate: if ANY PASS_TO_PASS test is not passing -> 0 (a regression is fatal); otherwise the
// fraction of FAIL_TO_PASS tests passing. Resolved: every FAIL_TO_PASS and PASS_TO_PASS passes.

const passed = (results, node) => results[node] === 'pass'

export function computeFixRate({ results = {}, failNodes = [], passToPass = [] } = {}) {
  if (passToPass.some((n) => !passed(results, n))) return 0 // regression -> hard zero
  if (failNodes.length === 0) return 100 // no required tests; no regression -> vacuously 100
  const ok = failNodes.filter((n) => passed(results, n)).length
  return (ok / failNodes.length) * 100
}

export function isResolved({ results = {}, failNodes = [], passToPass = [] } = {}) {
  return failNodes.every((n) => passed(results, n)) && passToPass.every((n) => passed(results, n))
}
