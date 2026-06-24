#!/usr/bin/env node
// LLM-as-judge scorer (for SUBJECTIVE quality). Calls claude -p as an impartial
// evaluator -> { score 0-100, critique }. This is where you spend the reasoning
// budget: default --model opus for the JUDGE, while the editor stays cheap. The
// judge reads the artifact itself (no file tools), so it runs at --max-turns 1.
//
// NONDETERMINISTIC by nature — the same artifact may score slightly differently.
// Prefer a deterministic scorer (test-pass-rate, compile, type-check) when one
// exists; use this only when "good" can't be checked by code.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const arg = (n, d) => {
  const i = process.argv.indexOf(n)
  return i >= 0 ? process.argv[i + 1] : d
}
const die = (m) => {
  process.stderr.write(`llm-judge: ${m}\n`)
  process.exit(2)
}

// Pure + exported so it can be unit-tested without spawning a model.
export function parseJudgeResponse(text) {
  // Key off the JSON's outermost braces, NOT a ``` code fence. The critique can legitimately
  // contain a ```mermaid span (the rubric asks the judge to cite one), and a fence regex
  // mis-keys on those inner backticks and truncates the object before its closing brace.
  // First-`{` to last-`}` is fence-agnostic and tolerates backticks inside the JSON string;
  // it still strips a surrounding ```json fence or prose (their braces, if any, sit outside).
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('no JSON object in judge response')
  const obj = JSON.parse(text.slice(start, end + 1))
  const score = Number(obj.score)
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error(`score not in 0..100: ${obj.score}`)
  return {
    score,
    critique: String(obj.critique ?? ''),
    findings: Array.isArray(obj.findings) ? obj.findings : [],
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = arg('--output')
  const goal = arg('--goal', 'meet the rubric')
  const model = arg('--model', 'opus')
  const mcp = arg('--mcp-config')
  let rubric = arg('--rubric', '')
  if (!output) die('--output <path> is required')

  let content = ''
  try {
    content = readFileSync(output, 'utf8')
  } catch (e) {
    die(`cannot read output ${output}: ${e.message}`)
  }
  if (rubric.startsWith('@')) {
    try {
      rubric = readFileSync(rubric.slice(1), 'utf8')
    } catch (e) {
      die(`cannot read rubric file: ${e.message}`)
    }
  }

  const prompt = [
    'You are an impartial evaluator. Score the artifact below from 0 to 100 on how well it meets the goal and rubric, then name the SINGLE highest-impact change that would raise the score most.',
    `Goal: ${goal}`,
    rubric ? `Rubric: ${rubric}` : 'Rubric: overall quality and fitness for the goal.',
    '',
    'Artifact:',
    '"""',
    content,
    '"""',
    '',
    'Respond with ONLY a JSON object (no prose, no code fence): {"score": <0-100 number>, "critique": "<one specific change>", "findings": [{"area":"...","severity":"high|med|low","suggestion":"..."}]}',
  ].join('\n')

  const args = ['-p', prompt, '--output-format', 'json', '--max-turns', '1', '--model', model]
  if (mcp) args.push('--mcp-config', mcp, '--strict-mcp-config')

  const res = spawnSync('claude', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (res.error) die(`failed to spawn claude: ${res.error.message}`)

  let resultText
  try {
    const parsed = JSON.parse(res.stdout)
    const r = Array.isArray(parsed) ? parsed.find((e) => e?.type === 'result') : parsed
    resultText = r?.result ?? ''
  } catch {
    die(`could not parse claude output: ${(res.stdout || res.stderr || '').slice(0, 300)}`)
  }

  let review
  try {
    review = parseJudgeResponse(resultText)
  } catch (e) {
    die(`judge did not return a valid score: ${e.message} :: ${String(resultText).slice(0, 300)}`)
  }
  process.stdout.write(JSON.stringify(review))
}
