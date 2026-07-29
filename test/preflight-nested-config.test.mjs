import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nestedClaudeConfigWarning } from '../src/preflight.mjs'

// The hazard: the editor spawns with cwd = the artifact's directory, and Claude Code merges every
// .claude config it finds walking UP. An artifact INSIDE a live .claude tree therefore inherits that
// tree's whole hook stack. Measured on the maintainer's machine: ~USD 2.08 / 1.04M tokens spent on
// hook ceremony for ZERO edits, ending in ERROR. Pure path check — no fs, so no false positives.

test('nestedClaudeConfigWarning: an ordinary project directory does not warn', () => {
  assert.equal(nestedClaudeConfigWarning({ targetDir: '/home/me/whetstone/src' }), null)
})

test('nestedClaudeConfigWarning: a scratch stage outside every config tree does not warn', () => {
  assert.equal(nestedClaudeConfigWarning({ targetDir: '/private/tmp/whet-stage-1' }), null)
})

test('nestedClaudeConfigWarning: an artifact inside the user config tree warns', () => {
  const w = nestedClaudeConfigWarning({ targetDir: '/home/me/.claude/skills/my-skill' })
  assert.match(w, /\.claude/)
  assert.match(w, /hook/i)          // names the actual failure mode, not a generic "be careful"
  assert.match(w, /\/home\/me\/\.claude/) // points at the offending ancestor, not just the target
})

test('nestedClaudeConfigWarning: a .claude tree nested inside a repo warns too', () => {
  const w = nestedClaudeConfigWarning({ targetDir: '/home/me/claude-config/payload/.claude/rules' })
  assert.match(w, /\/home\/me\/claude-config\/payload\/\.claude/)
})

test('nestedClaudeConfigWarning: the .claude directory ITSELF as the target warns', () => {
  assert.match(nestedClaudeConfigWarning({ targetDir: '/home/me/.claude' }), /\.claude/)
})

test('nestedClaudeConfigWarning: reports the OUTERMOST .claude ancestor when several nest', () => {
  const w = nestedClaudeConfigWarning({ targetDir: '/home/me/.claude/plugins/x/.claude/sub' })
  assert.match(w, /\/home\/me\/\.claude(?![/\w])/) // the outer one — that is what the walk-up reaches first
})

test('nestedClaudeConfigWarning: a directory merely NAMED like a config dir does not warn', () => {
  assert.equal(nestedClaudeConfigWarning({ targetDir: '/home/me/.claude-backup/skills' }), null)
  assert.equal(nestedClaudeConfigWarning({ targetDir: '/home/me/my.claude/skills' }), null)
})

test('nestedClaudeConfigWarning: an absent target is not this check concern', () => {
  assert.equal(nestedClaudeConfigWarning({}), null)
})

test('nestedClaudeConfigWarning: the remedy names staging outside the tree, not just the risk', () => {
  const w = nestedClaudeConfigWarning({ targetDir: '/home/me/.claude/skills/s' })
  assert.match(w, /copy|stage/i)
})
