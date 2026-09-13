import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import https from 'node:https'
import { m } from './messages'
import { MAX_INSTALLER_BYTES, UPDATE_API_ROOT, UPDATE_REPOSITORY } from './source'

export class UpdateError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'UpdateError'
  }
}

export type UpdateAccessReason =
  'credentials' | 'sso' | 'oauth-policy' | 'permissions' | 'not-found' | 'forbidden'

export class UpdateAccessError extends UpdateError {
  constructor(
    readonly status: number,
    readonly reason: UpdateAccessReason,
    detail: string
  ) {
    super('UPDATES_ACCESS', m().accessPrefix(status, detail))
  }
}

const CDN_HOSTS = new Set([
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com'
])

/** Official release endpoints only. Query strings on CDNs are signed by GitHub and stay in main memory. */
function permittedUrl(url: URL, asset: boolean): boolean {
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    url.hash
  )
    return false
  if (url.hostname === 'api.github.com') {
    return (
      url.pathname === `/repos/${UPDATE_REPOSITORY}/releases` ||
      url.pathname.startsWith(`/repos/${UPDATE_REPOSITORY}/releases/`)
    )
  }
  if (!asset) return false
  if (url.hostname === 'github.com')
    return url.pathname.startsWith(`/${UPDATE_REPOSITORY}/releases/download/`)
  return CDN_HOSTS.has(url.hostname)
}

/** Classify a bounded error body; never forward GitHub payloads or authorization URLs to IPC. */
async function errorMessage(response: IncomingMessage): Promise<string> {
  const limit = 16 * 1024
  if (Number(response.headers['content-length']) > limit) return ''
  const chunks: Buffer[] = []
  let size = 0
  const timer = setTimeout(() => response.destroy(), 2000)
  try {
    for await (const chunk of response) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
      size += bytes.length
      if (size > limit) return ''
      chunks.push(bytes)
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return data && typeof data === 'object' && 'message' in data && typeof data.message === 'string'
      ? data.message.toLowerCase()
      : ''
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
    response.destroy()
  }
}

async function responseError(response: IncomingMessage, githubApi: boolean): Promise<UpdateError> {
  const status = response.statusCode ?? 0
  const rateLimit = (): UpdateError => new UpdateError('UPDATES_RATE_LIMIT', m().rateLimit(status))
  if (status === 429 || (status === 403 && response.headers['x-ratelimit-remaining'] === '0'))
    return rateLimit()
  if (githubApi && status === 401)
    return new UpdateAccessError(status, 'credentials', m().accessCredentials)
  if (githubApi && status === 404)
    return new UpdateAccessError(status, 'not-found', m().accessNotFound)
  if (githubApi && status === 403) {
    const sso = response.headers['x-github-sso']
    if (typeof sso === 'string' && /^required(?:;|$)/i.test(sso))
      return new UpdateAccessError(status, 'sso', m().accessSso)
    const message = await errorMessage(response)
    if (/secondary rate limit|api rate limit exceeded|abuse detection/.test(message))
      return rateLimit()
    if (
      /oauth app access restrictions|oauth application access restrictions|third.party application restrictions/.test(
        message
      )
    ) {
      return new UpdateAccessError(status, 'oauth-policy', m().accessOauthPolicy)
    }
    if (/resource not accessible by (?:personal access token|integration)/.test(message)) {
      return new UpdateAccessError(status, 'permissions', m().accessPermissions)
    }
    return new UpdateAccessError(status, 'forbidden', m().accessForbidden)
  }
  return new UpdateError('UPDATES_HTTP', m().httpFailed(status))
}

async function responseFor(
  url: URL,
  token: string | undefined,
  asset: boolean,
  signal: AbortSignal,
  redirects = 0
): Promise<IncomingMessage> {
  if (!permittedUrl(url, asset) || redirects > 5)
    throw new UpdateError('UPDATES_URL', m().urlNotAllowed)
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: 'GET',
        signal,
        headers: {
          'User-Agent': 'ChessAdvisor-Updater',
          Accept: asset ? 'application/octet-stream' : 'application/vnd.github+json',
          'Accept-Encoding': 'identity',
          ...(url.hostname === 'api.github.com'
            ? {
                'X-GitHub-Api-Version': '2026-03-10',
                ...(token ? { Authorization: `Bearer ${token}` } : {})
              }
            : {})
        }
      },
      (incoming) => {
        incoming.on('error', () => {})
        resolve(incoming)
      }
    )
    request.on('error', () =>
      reject(
        new UpdateError(
          signal.aborted ? 'UPDATES_TIMEOUT' : 'UPDATES_NETWORK',
          signal.aborted ? m().requestTimeout : m().networkUnreachable
        )
      )
    )
    request.setTimeout(30_000, () => request.destroy())
    request.end()
  })
  const status = response.statusCode ?? 0
  if ([301, 302, 303, 307, 308].includes(status)) {
    const location = response.headers.location
    response.destroy()
    if (!location) throw new UpdateError('UPDATES_URL', m().redirectWithoutTarget)
    let redirected: URL
    try {
      redirected = new URL(location, url)
    } catch {
      throw new UpdateError('UPDATES_URL', m().redirectInvalid)
    }
    return responseFor(redirected, token, asset, signal, redirects + 1)
  }
  if (status !== 200) {
    try {
      throw await responseError(response, url.hostname === 'api.github.com')
    } finally {
      response.destroy()
    }
  }
  return response
}

async function boundedRequest<T>(
  url: string,
  options: { token?: string; asset?: boolean; timeoutMs: number; signal?: AbortSignal },
  read: (response: IncomingMessage) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  const timer = setTimeout(abort, options.timeoutMs)
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  let response: IncomingMessage | undefined
  try {
    response = await responseFor(
      new URL(url),
      options.token,
      options.asset ?? false,
      controller.signal
    )
    return await read(response)
  } catch (error) {
    if (error instanceof UpdateError) throw error
    throw new UpdateError(
      controller.signal.aborted ? 'UPDATES_TIMEOUT' : 'UPDATES_DOWNLOAD',
      controller.signal.aborted ? m().requestTimeout : m().transferIncomplete
    )
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    response?.destroy()
  }
}

export function readReleaseBytes(
  url: string,
  options: { token?: string; maxBytes: number; asset?: boolean; signal?: AbortSignal }
): Promise<Buffer> {
  return boundedRequest(url, { ...options, timeoutMs: 30_000 }, async (response) => {
    const length = Number(response.headers['content-length'])
    if (Number.isFinite(length) && length > options.maxBytes)
      throw new UpdateError('UPDATES_SIZE', m().responseTooLarge)
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of response) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
      size += bytes.length
      if (size > options.maxBytes) throw new UpdateError('UPDATES_SIZE', m().responseTooLarge)
      chunks.push(bytes)
    }
    return Buffer.concat(chunks)
  })
}

export async function readReleaseJson(
  path: string,
  token?: string,
  signal?: AbortSignal
): Promise<unknown> {
  const bytes = await readReleaseBytes(`${UPDATE_API_ROOT}${path}`, {
    token,
    maxBytes: 8 * 1024 * 1024,
    signal
  })
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new UpdateError('UPDATES_RESPONSE', m().metadataInvalid)
  }
}

/** Streaming download: an exclusive new file, bounded memory, size and wall-clock duration. */
export async function downloadReleaseAsset(
  assetId: number,
  path: string,
  expectedSize: number,
  options: { token?: string; signal?: AbortSignal; progress(received: number): void }
): Promise<{ sha256: string; size: number }> {
  return boundedRequest(
    `${UPDATE_API_ROOT}/releases/assets/${assetId}`,
    { ...options, asset: true, timeoutMs: 10 * 60_000 },
    async (response) => {
      const length = Number(response.headers['content-length'])
      if (Number.isFinite(length) && (length > MAX_INSTALLER_BYTES || length !== expectedSize)) {
        throw new UpdateError('UPDATES_SIZE', m().installerSizeMismatch)
      }
      const file = await open(path, 'wx', 0o600)
      const hash = createHash('sha256')
      let size = 0
      let lastProgress = 0
      try {
        for await (const chunk of response) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
          size += bytes.length
          if (size > expectedSize || size > MAX_INSTALLER_BYTES)
            throw new UpdateError('UPDATES_SIZE', m().installerTooLarge)
          hash.update(bytes)
          let offset = 0
          while (offset < bytes.length) {
            const written = await file.write(bytes, offset, bytes.length - offset)
            if (written.bytesWritten === 0)
              throw new UpdateError('UPDATES_WRITE', m().installerWriteFailed)
            offset += written.bytesWritten
          }
          if (Date.now() - lastProgress >= 200) {
            lastProgress = Date.now()
            options.progress(size)
          }
        }
        if (size !== expectedSize || size === 0)
          throw new UpdateError('UPDATES_SIZE', m().installerIncomplete)
        await file.sync()
        options.progress(size)
        return { sha256: hash.digest('hex'), size }
      } finally {
        await file.close()
      }
    }
  )
}
