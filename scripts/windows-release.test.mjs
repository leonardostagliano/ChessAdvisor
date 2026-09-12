import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compareVersions, getBump, incrementVersion, planRelease } from './windows-release.mjs'

describe('getBump', () => {
  it('maps a feat commit to a minor bump', () => {
    expect(getBump(['feat: add the eval bar'])).toBe('minor')
    expect(getBump(['feat(board): animate arrows'])).toBe('minor')
  })

  it('maps a breaking marker to a major bump, whichever commit carries it', () => {
    expect(getBump(['fix: typo', 'feat!: drop the legacy store'])).toBe('major')
    expect(getBump(['refactor(main)!: rename the IPC channels'])).toBe('major')
    expect(getBump(['chore: bump deps\n\nBREAKING CHANGE: settings move'])).toBe('major')
  })

  it('falls back to a patch bump', () => {
    expect(getBump(['fix: illegal move retry'])).toBe('patch')
    expect(getBump(['chore: tidy up', 'docs: readme'])).toBe('patch')
    expect(getBump([])).toBe('patch')
  })

  it('reads a header hidden in a squash commit body', () => {
    expect(getBump(['chore: squash\n\nfeat: add training screen\nfix: guard'])).toBe('minor')
  })
})

describe('incrementVersion', () => {
  it('increments and resets the lower fields', () => {
    expect(incrementVersion('1.4.7', 'major')).toBe('2.0.0')
    expect(incrementVersion('1.4.7', 'minor')).toBe('1.5.0')
    expect(incrementVersion('1.4.7', 'patch')).toBe('1.4.8')
  })

  it('rejects an unstable version or an unknown bump', () => {
    expect(() => incrementVersion('1.4.7-rc.1', 'patch')).toThrow()
    expect(() => incrementVersion('1.4.7', 'huge')).toThrow()
  })
})

describe('compareVersions', () => {
  it('orders versions numerically', () => {
    expect(compareVersions('0.2.0', '0.10.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  })
})

// One throwaway repository serves every scenario: git is slow enough on Windows that
// rebuilding a fixture per test dominates the suite. `planRelease` is read-only, so the
// scenarios differ only by the `sha` they plan from and the release records they are given.
describe('planRelease', () => {
  const PUBLISHED_V011 = { tag_name: 'v0.1.1', draft: false, prerelease: false }
  let repo = ''
  let sha = {}

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'chessadvisor-release-'))
    const git = (...args) =>
      execFileSync('git', ['-C', repo, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'ChessAdvisor Test',
          GIT_AUTHOR_EMAIL: 'test@example.invalid',
          GIT_COMMITTER_NAME: 'ChessAdvisor Test',
          GIT_COMMITTER_EMAIL: 'test@example.invalid'
        }
      }).trim()
    writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ name: 'chessadvisor', version: '0.1.0' }, null, 2)}\n`)
    execFileSync('git', ['init', '-q', '--initial-branch=main', repo], { encoding: 'utf8' })
    // Empty commits keep the fixture fast: only history and the manifest are read.
    const commit = (message) => git('-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', message)
    commit('chore: initial import')
    commit('fix: first fix')
    git('tag', 'v0.1.1')
    commit('feat: second feature')
    commit('fix: third fix')
    git('checkout', '-q', '-b', 'divergent', 'v0.1.1~1')
    commit('fix: parallel work')
    const history = git('log', '--format=%H %s', '--all').split('\n')
    const find = (subject) => history.find((line) => line.endsWith(subject)).split(' ')[0]
    sha = {
      initial: find('chore: initial import'),
      firstFix: find('fix: first fix'),
      secondFeature: find('feat: second feature'),
      thirdFix: find('fix: third fix'),
      divergent: find('fix: parallel work')
    }
  }, 60_000)

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('plans the first release from the manifest version', () => {
    const plan = planRelease({ cwd: repo, releases: [], sha: sha.secondFeature })
    expect(plan.skip).toBe(false)
    expect(plan.baseVersion).toBe('0.1.0')
    expect(plan.bump).toBe('minor')
    expect(plan.version).toBe('0.2.0')
    expect(plan.tag).toBe('v0.2.0')
    expect(plan.previousTag).toBeNull()
    expect(plan.commits.map((entry) => entry.sha)).toEqual([sha.initial, sha.firstFix, sha.secondFeature])
  })

  it('skips when HEAD is already contained in a published release', () => {
    const plan = planRelease({ cwd: repo, releases: [PUBLISHED_V011], sha: sha.firstFix })
    expect(plan).toEqual({ skip: true, tag: 'v0.1.1', sha: sha.firstFix })
  })

  it('counts only the commits after the last published tag', () => {
    const plan = planRelease({ cwd: repo, releases: [PUBLISHED_V011], sha: sha.thirdFix })
    expect(plan.skip).toBe(false)
    expect(plan.baseVersion).toBe('0.1.1')
    expect(plan.bump).toBe('minor')
    expect(plan.version).toBe('0.2.0')
    expect(plan.previousTag).toBe('v0.1.1')
    expect(plan.commits.map((entry) => entry.message)).toEqual(['feat: second feature', 'fix: third fix'])
  })

  it('throws when HEAD does not descend from the last published release', () => {
    expect(() => planRelease({ cwd: repo, releases: [PUBLISHED_V011], sha: sha.divergent })).toThrow(/non discende/)
  })

  it('skips a version already reserved by another release', () => {
    const plan = planRelease({
      cwd: repo,
      releases: [PUBLISHED_V011, { tag_name: 'v0.2.0', draft: true, prerelease: false, target_commitish: 'another-commit' }],
      sha: sha.thirdFix
    })
    expect(plan.version).toBe('0.2.1')
    expect(plan.tag).toBe('v0.2.1')
  })
})
