export type UpdateAsset = { name: string; size: number; url: string }
export type UpdateStatus = {
  supported: boolean; mode: 'manual' | 'auto'; autoCheck: boolean
  phase: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error'
  currentVersion: string; latestVersion: string | null; publishedAt: string | null
  releaseNotes: string | null; releasePageUrl: string; asset: UpdateAsset | null
  dismissedVersion: string | null; hasUnreadUpdate: boolean
  progress: { percent: number; transferred: number; total: number } | null
  lastCheckedAt: string | null; error: string | null
}

const REPOSITORY = 'Dylannn-7/EvoScholar'
export const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const CHECK_ERROR = '暂时无法连接 GitHub'

function parseVersion(value: string) {
  const version = value.replace(/^v/, '')
  const match = VERSION.exec(version)
  if (!match || match[0] !== version) return null
  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some((part) => /^0\d+$/.test(part))) return null
  return { version, core: match.slice(1, 4), prerelease }
}

export function normalizeUpdateVersion(value: unknown): string | null {
  return typeof value === 'string' ? parseVersion(value)?.version ?? null : null
}

function compareParts(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric && a.length !== b.length) return Math.sign(a.length - b.length)
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return 0
  for (let i = 0; i < 3; i++) {
    const comparison = compareParts(left.core[i], right.core[i])
    if (comparison) return comparison
  }
  const preA = left.prerelease
  const preB = right.prerelease
  if (!preA.length || !preB.length) return Math.sign(preB.length - preA.length)
  for (let i = 0; i < Math.min(preA.length, preB.length); i++) {
    const comparison = compareParts(preA[i], preB[i])
    if (comparison) return comparison
  }
  return Math.sign(preA.length - preB.length)
}

function hasReleasePrefix(value: unknown, prefix: string): value is string {
  if (typeof value !== 'string' || !value.startsWith(prefix) || /[\\\s]/.test(value)) return false
  try {
    const url = new URL(value)
    return url.href.startsWith(prefix) && url.pathname.length > new URL(prefix).pathname.length
  } catch { return false }
}

export const isReleaseAssetUrl = (url: unknown): url is string => hasReleasePrefix(url, RELEASES_URL + '/download/')
export const isReleasePageUrl = (url: unknown): url is string => url === RELEASES_URL || hasReleasePrefix(url, RELEASES_URL + '/tag/')

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function selectReleaseAsset(assets: unknown[], platform: string, arch: string): UpdateAsset | null {
  const mac = platform === 'darwin' && (arch === 'arm64' || arch === 'x64')
  const win = platform === 'win32' && arch === 'x64'
  if (!mac && !win) return null
  const prefix = mac ? 'EvoScholar-' : 'EvoScholar-Setup-'
  const suffix = mac ? `-${arch}.dmg` : '.exe'
  for (const asset of assets) {
    if (!isRecord(asset)) continue
    const { name, size, browser_download_url: url } = asset
    if (typeof name !== 'string' || !name.startsWith(prefix) || !name.endsWith(suffix) ||
        !normalizeUpdateVersion(name.slice(prefix.length, -suffix.length))) continue
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || !isReleaseAssetUrl(url)) continue
    return { name, size, url }
  }
  return null
}

type Release = Pick<UpdateStatus, 'latestVersion' | 'publishedAt' | 'releaseNotes' | 'releasePageUrl' | 'asset'>
export type LatestReleaseResult = { available: boolean } & Release | { error: string }

export async function checkLatestRelease({
  current, platform, arch, fetchImpl = globalThis.fetch, timeoutMs = 8000
}: { current: string; platform: string; arch: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<LatestReleaseResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(LATEST_RELEASE_URL, {
      method: 'GET', redirect: 'error', signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `EvoScholar/${current}`,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
    if (!response.ok && response.status !== 404) return { error: CHECK_ERROR }
    const empty = { available: false, latestVersion: null, publishedAt: null, releaseNotes: null, releasePageUrl: RELEASES_URL, asset: null }
    if (response.status === 404) return empty // No published stable release yet.
    const data: unknown = await response.json()
    if (!isRecord(data)) return { error: CHECK_ERROR }
    if (data.draft === true || data.prerelease === true) return empty
    const version = typeof data.tag_name === 'string' ? parseVersion(data.tag_name) : null
    if (!version) return { error: CHECK_ERROR }
    if (version.prerelease.length) return empty
    const available = compareVersions(version.version, current) > 0
    return {
      available,
      latestVersion: version.version,
      publishedAt: typeof data.published_at === 'string' && Number.isFinite(Date.parse(data.published_at)) ? data.published_at : null,
      releaseNotes: available && typeof data.body === 'string' ? data.body : null,
      releasePageUrl: isReleasePageUrl(data.html_url) ? data.html_url : RELEASES_URL,
      asset: available && Array.isArray(data.assets) ? selectReleaseAsset(data.assets, platform, arch) : null
    }
  } catch {
    return { error: CHECK_ERROR }
  } finally {
    clearTimeout(timer)
  }
}
