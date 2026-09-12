import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('project scaffold', () => {
  it('declares the tested Codex CLI version', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(pkg.codexCli.testedVersion).toBe('0.154.0')
    expect(pkg.license).toBe('GPL-3.0-only')
  })
})
