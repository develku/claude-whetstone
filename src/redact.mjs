export function redactSecrets(text) {
  return text
    .replace(/sk-[A-Za-z0-9]+/g, '[REDACTED]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, '$1[REDACTED]');
}
