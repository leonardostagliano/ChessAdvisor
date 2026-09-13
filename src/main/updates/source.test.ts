import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  isApplicationOrigin,
  stableVersion,
  UPDATE_PACKAGE_NAME,
  UPDATE_REPOSITORY
} from './source'

describe('stableVersion', () => {
  it('accepts a stable SemVer with or without the v prefix', () => {
    expect(stableVersion('1.2.3')).toBe('1.2.3')
    expect(stableVersion('v1.2.3')).toBe('1.2.3')
    expect(stableVersion('0.0.0')).toBe('0.0.0')
  })

  it('rejects pre-releases, build metadata, padded numbers and non-strings', () => {
    for (const value of [
      '1.2.3-rc.1',
      '1.2.3+build',
      '01.2.3',
      '1.2',
      '1.2.3.4',
      'v',
      '',
      'latest'
    ]) {
      expect(stableVersion(value), value).toBeUndefined()
    }
    expect(stableVersion(undefined)).toBeUndefined()
    expect(stableVersion(123)).toBeUndefined()
    expect(stableVersion({ tag: '1.2.3' })).toBeUndefined()
  })
})

describe('compareVersions', () => {
  it('orders major, then minor, then patch', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0)
    expect(compareVersions('2.1.0', '2.0.9')).toBeGreaterThan(0)
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0)
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
  })

  it('throws when either side is not a stable version', () => {
    expect(() => compareVersions('1.2.3-rc.1', '1.2.3')).toThrow()
    expect(() => compareVersions('1.2.3', 'nightly')).toThrow()
  })
})

describe('isApplicationOrigin', () => {
  it('accepts the https, .git, ssh and scp forms of this repository', () => {
    expect(isApplicationOrigin(`https://github.com/${UPDATE_REPOSITORY}`)).toBe(true)
    expect(isApplicationOrigin(`https://github.com/${UPDATE_REPOSITORY}.git`)).toBe(true)
    expect(isApplicationOrigin(`  https://github.com/${UPDATE_REPOSITORY}/  `)).toBe(true)
    expect(isApplicationOrigin(`git@github.com:${UPDATE_REPOSITORY}.git`)).toBe(true)
    expect(isApplicationOrigin(`ssh://git@github.com/${UPDATE_REPOSITORY}.git`)).toBe(true)
    expect(isApplicationOrigin(`https://github.com/${UPDATE_REPOSITORY.toUpperCase()}`)).toBe(true)
  })

  it('rejects other hosts, other repositories and decorated URLs', () => {
    for (const value of [
      'https://github.com/someone/ChessAdvisor',
      'https://gitlab.com/leonardostagliano/ChessAdvisor',
      'http://github.com/leonardostagliano/ChessAdvisor',
      'https://github.com:8443/leonardostagliano/ChessAdvisor',
      'https://github.com/leonardostagliano/ChessAdvisor?a=1',
      'https://github.com/leonardostagliano/ChessAdvisor#fragment',
      'not a url',
      ''
    ]) {
      expect(isApplicationOrigin(value), value).toBe(false)
    }
  })
})

describe('package identity', () => {
  it('matches the artifactName produced by electron-builder', () => {
    expect(`${UPDATE_PACKAGE_NAME}-1.4.0-x64.exe`).toBe('ChessAdvisor-1.4.0-x64.exe')
  })
})
