import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isMainModule } from '../src/is-main.mjs'

// realpathSync the temp dir so paths are stable under macOS's /var -> /private/var symlink.
const mkTmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'ismain-')))

test('isMainModule: true on a direct (non-symlink) argv match', () => {
  const dir = mkTmp()
  try {
    const file = join(dir, 'mod.mjs')
    writeFileSync(file, '// x\n')
    assert.equal(isMainModule(pathToFileURL(file).href, file), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('isMainModule: true when argv is a SYMLINK whose realpath is the module (the bug)', () => {
  const dir = mkTmp()
  try {
    const real = join(dir, 'real.mjs')
    writeFileSync(real, '// x\n')
    const link = join(dir, 'link.mjs')
    symlinkSync(real, link)
    // Node sets import.meta.url to the realpath-resolved URL:
    const importMetaUrl = pathToFileURL(real).href
    // The bare idiom the bug used compares against the LAUNCH path (the symlink) -> mismatch:
    assert.equal(importMetaUrl === pathToFileURL(link).href, false)
    // The robust check must still recognize the module as main:
    assert.equal(isMainModule(importMetaUrl, link), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('isMainModule: false when argv is an unrelated file (imported, not run)', () => {
  const dir = mkTmp()
  try {
    const mod = join(dir, 'mod.mjs')
    writeFileSync(mod, '// x\n')
    const other = join(dir, 'other.mjs')
    writeFileSync(other, '// y\n')
    assert.equal(isMainModule(pathToFileURL(mod).href, other), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('isMainModule: false when argv is missing', () => {
  assert.equal(isMainModule('file:///whatever.mjs', undefined), false)
})

test('isMainModule: false (not a throw) when argv points at a nonexistent path', () => {
  assert.equal(isMainModule('file:///whatever.mjs', '/no/such/file.mjs'), false)
})
