import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkLatestRelease, compareVersions, RELEASES_URL, selectReleaseAsset } from './updater'

const releasePage = RELEASES_URL + '/tag/v0.5.0'
const asset = (name: string, base = RELEASES_URL + '/download/v0.5.0/') =>
  ({ name, size: 2048, browser_download_url: base + name })
const arm = asset('EvoScholar-0.5.0-arm64.dmg')
const intel = asset('EvoScholar-0.5.0-x64.dmg')
const win = asset('EvoScholar-Setup-0.5.0.exe')
const release = { draft: false, prerelease: false, tag_name: 'v0.5.0', html_url: releasePage,
  published_at: '2026-11-23T02:00:00.000Z', body: '## 更新说明', assets: [arm, intel, win] }
const defaults = { current: '0.4.0', platform: 'darwin', arch: 'arm64' }

test('compareVersions compares numeric versions and orders prerelease identifiers', () => {
  assert.equal(compareVersions('v0.10.0', '0.9.10'), 1)
  assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.2'), 1)
  assert.equal(compareVersions('1.0.0-rc.1', 'v1.0.0'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0-alpha'), 1)
  assert.equal(compareVersions('1.0.0-a', '1.0.0-a.1'), -1)
  assert.equal(compareVersions('1.0.0-9', '1.0.0-x'), -1)
  assert.equal(compareVersions('v0.4.0', '0.4.0+build'), 0)
  assert.equal(compareVersions('0.4', '0.4.0'), 0)
  assert.equal(compareVersions('0.4.0\n', '9.0.0'), 0)
})

test('selectReleaseAsset matches the three installers and only official download URLs', () => {
  const list = [
    asset(arm.name, 'https://github.com.evil.example/Dylannn-7/EvoScholar/releases/download/v0.5.0/'),
    asset(arm.name, 'https://github.com/Dylannn-7/EvoScholar/releases/download/../../other/'),
    asset(arm.name, RELEASES_URL + '/download/v0.5.0/\\'),
    asset('EvoScholar-0.5.0-arm64.zip'), { ...arm, size: '2048' }, arm, intel, win
  ]
  for (const [platform, arch, expected] of [['darwin', 'arm64', arm], ['darwin', 'x64', intel], ['win32', 'x64', win]] as const) {
    assert.deepEqual(selectReleaseAsset(list, platform, arch), { name: expected.name, size: expected.size, url: expected.browser_download_url })
  }
  assert.equal(selectReleaseAsset([intel, win], 'darwin', 'arm64'), null)
  assert.equal(selectReleaseAsset(list, 'linux', 'arm64'), null)
  assert.equal(selectReleaseAsset(list.slice(0, 3), 'darwin', 'arm64'), null)
})

test('checkLatestRelease requests only the GitHub version endpoint and maps release details', async () => {
  const fetchImpl: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://api.github.com/repos/Dylannn-7/EvoScholar/releases/latest')
    assert.equal(init?.method, 'GET')
    assert.equal(init?.body, undefined)
    assert.equal(init?.redirect, 'error')
    assert.deepEqual(init?.headers, {
      Accept: 'application/vnd.github+json', 'User-Agent': 'EvoScholar/0.4.0', 'X-GitHub-Api-Version': '2022-11-28'
    })
    return Response.json(release)
  }
  assert.deepEqual(await checkLatestRelease({ ...defaults, fetchImpl }), {
    available: true, latestVersion: '0.5.0', publishedAt: release.published_at, releaseNotes: release.body, releasePageUrl: releasePage,
    asset: { name: arm.name, size: arm.size, url: arm.browser_download_url }
  })
  const get = (value: unknown) => checkLatestRelease({ ...defaults, fetchImpl: async () => Response.json(value) })
  const same = await get({ ...release, tag_name: 'v0.4.0' })
  assert.ok('available' in same && !same.available && same.asset === null)
  for (const flags of [{ draft: true }, { prerelease: true }, { tag_name: 'v0.5.0-beta.1' }]) {
    const ignored = await get({ ...release, ...flags })
    assert.ok('available' in ignored && !ignored.available && ignored.latestVersion === null)
  }
  const offsite = await get({ ...release, html_url: 'https://example.org/releases/tag/v0.5.0' })
  assert.ok('available' in offsite && offsite.releasePageUrl === RELEASES_URL)
})

test('checkLatestRelease handles GitHub errors, absent releases, invalid JSON and timeout', async () => {
  for (const response of [new Response(null, { status: 403 }), new Response(null, { status: 500 }), new Response('not JSON'), Response.json([])]) {
    assert.deepEqual(await checkLatestRelease({ ...defaults, fetchImpl: async () => response }), { error: '暂时无法连接 GitHub' })
  }
  const missing = await checkLatestRelease({ ...defaults, fetchImpl: async () => new Response(null, { status: 404 }) })
  assert.ok('available' in missing && !missing.available)
  let aborted = false
  const fetchImpl: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => { aborted = true; reject(init!.signal!.reason) })
  })
  assert.deepEqual(await checkLatestRelease({ ...defaults, fetchImpl, timeoutMs: 5 }), { error: '暂时无法连接 GitHub' })
  assert.equal(aborted, true)
})
