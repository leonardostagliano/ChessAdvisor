import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TESTED_CODEX_VERSION } from './protocolVersion'

describe('protocol bindings', () => {
  it('exposes the Codex CLI version declared in package.json', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(TESTED_CODEX_VERSION).toBe(pkg.codexCli.testedVersion)
    expect(TESTED_CODEX_VERSION).toBe('0.154.0')
  })

  it('documents how the committed bindings were generated', () => {
    const readme = readFileSync('src/main/codex/protocol/README.md', 'utf8')
    expect(readme).toContain('npm run codex:types')
    expect(readme).toContain(TESTED_CODEX_VERSION)
  })

  it('committed the generated barrel file', () => {
    const index = readFileSync('src/main/codex/protocol/index.ts', 'utf8')
    expect(index).toContain('export type { InitializeResponse }')
  })
})
