// Best-effort secret scrubbing for text that lands in the run dir — reviews/*.json AND state.json
// (via saveState). NOT a guarantee: regex redaction covers recognizable token shapes and
// `name = value` assignments, but a bare high-entropy secret with no known prefix can still slip
// through. Treat the run dir as sensitive regardless — it is gitignored by ensureLoopDir.

// Whole-match -> [REDACTED]. Order matters: the hyphenated Anthropic key must precede the
// generic sk- pattern, which would otherwise stop at the first hyphen and leak the suffix.
const TOKEN_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, // PEM blocks
  /sk-ant-[A-Za-z0-9_-]+/g, // Anthropic (hyphenated)
  /sk-[A-Za-z0-9]{16,}/g, // OpenAI and similar sk- keys
  /\bgh[opsur]_[A-Za-z0-9]{20,}/g, // GitHub PAT / OAuth / server / refresh tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bAIza[0-9A-Za-z_-]{35}/g, // Google API keys
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
]

export function redactSecrets(text) {
  let out = String(text)
  for (const p of TOKEN_PATTERNS) out = out.replace(p, '[REDACTED]')
  // Prefix-preserving: keep the scheme/name, redact the value.
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, '$1[REDACTED]')
  out = out.replace(/\b((?:api[_-]?key|secret|token|password|passwd|pwd)["']?\s*[:=]\s*["']?)([^\s"']+)/gi, '$1[REDACTED]')
  return out
}
