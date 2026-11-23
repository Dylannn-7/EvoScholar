import {
  RELEASES_URL, checkLatestRelease, compareVersions, normalizeUpdateVersion, saveSettings,
  type UpdateStatus, type Workspace
} from '@evoscholar/core'

export type AppUpdate = { version: string; platform: string; arch: string }
const INTERVAL_MS = 12 * 60 * 60 * 1000

export function createAppUpdate(ws: Workspace, currentVersion: string, app?: AppUpdate, fetchImpl?: typeof fetch) {
  let release: Pick<UpdateStatus, 'latestVersion' | 'publishedAt' | 'releaseNotes' | 'releasePageUrl' | 'asset'> = {
    latestVersion: null, publishedAt: null, releaseNotes: null, releasePageUrl: RELEASES_URL, asset: null
  }
  let phase: UpdateStatus['phase'] = 'idle'
  let error: string | null = null
  let pending: Promise<UpdateStatus> | undefined

  const status = (): UpdateStatus => {
    const settings = ws.settings.update
    const dismissedVersion = settings?.dismissedVersion ?? null
    return {
      ...release, supported: !!app, mode: 'manual', progress: null, autoCheck: settings?.autoCheck !== false,
      phase, currentVersion, dismissedVersion, lastCheckedAt: settings?.lastCheckedAt ?? null, error,
      hasUnreadUpdate: !!release.latestVersion && compareVersions(release.latestVersion, currentVersion) > 0 &&
        release.latestVersion !== dismissedVersion
    }
  }

  function save(patch: NonNullable<Workspace['settings']['update']>) {
    const previous = ws.settings.update
    ws.settings.update = { ...previous, ...patch }
    try { saveSettings(ws) } catch (err) { ws.settings.update = previous; throw err }
    return status()
  }

  function checkForUpdates({ automatic = false } = {}): Promise<UpdateStatus> {
    if (!app || process.env.EVOSCHOLAR_SMOKE === '1') return Promise.resolve(status())
    if (pending) return pending
    const now = Date.now()
    const settings = ws.settings.update
    if (automatic && (settings?.autoCheck === false || now - Date.parse(settings?.lastCheckedAt ?? '') < INTERVAL_MS))
      return Promise.resolve(status())
    save({ lastCheckedAt: new Date(now).toISOString() })
    phase = 'checking'
    error = null
    pending = checkLatestRelease({ current: currentVersion, platform: app.platform, arch: app.arch, fetchImpl }).then((result) => {
      if ('error' in result) {
        error = result.error
        phase = 'error'
      } else {
        const { available, ...details } = result
        release = details
        phase = available ? 'available' : 'up-to-date'
      }
      return status()
    }).finally(() => { pending = undefined })
    return pending
  }

  return {
    status, checkForUpdates,
    setAutoCheck: (autoCheck: boolean) => save({ autoCheck }),
    dismiss: (version: unknown) => {
      const dismissedVersion = normalizeUpdateVersion(version)
      return dismissedVersion ? save({ dismissedVersion }) : null
    }
  }
}
