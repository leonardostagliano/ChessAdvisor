/**
 * Build-bound origin of this application. Downloads are only ever taken from this
 * repository: nothing the user can configure at runtime may redirect an executable.
 */
export const UPDATE_REPOSITORY = 'leonardostagliano/ChessAdvisor'
export const UPDATE_REPOSITORY_URL = `https://github.com/${UPDATE_REPOSITORY}`
export const UPDATE_API_ROOT = `https://api.github.com/repos/${UPDATE_REPOSITORY}`
/** Matches `artifactName` in electron-builder.yml: `ChessAdvisor-<version>-x64.exe`. */
export const UPDATE_PACKAGE_NAME = 'ChessAdvisor'
export const MAX_INSTALLER_BYTES = 512 * 1024 * 1024

export function stableVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(value)
  return match && match[1].split('.').every((part) => Number.isSafeInteger(Number(part))) ? match[1] : undefined
}

export function compareVersions(left: string, right: string): number {
  const a = stableVersion(left)
  const b = stableVersion(right)
  if (!a || !b) throw new Error('Invalid stable SemVer version.')
  const ap = a.split('.').map(Number)
  const bp = b.split('.').map(Number)
  return ap[0] - bp[0] || ap[1] - bp[1] || ap[2] - bp[2]
}

/** True only for a remote that unambiguously points at this application's own repository. */
export function isApplicationOrigin(value: string): boolean {
  const remote = value
    .trim()
    .replace(/^git@github\.com:/i, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//i, 'https://github.com/')
  try {
    const url = new URL(remote)
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      !url.port &&
      !url.search &&
      !url.hash &&
      url.pathname.replace(/^\/|\.git\/?$|\/$/g, '').toLowerCase() === UPDATE_REPOSITORY.toLowerCase()
    )
  } catch {
    return false
  }
}
