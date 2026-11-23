import {
  RELEASES_URL, checkLatestRelease, compareVersions, normalizeUpdateVersion, saveSettings,
  type UpdateStatus, type Workspace
} from '@evoscholar/core'

export type AppUpdate = { version: string; platform: string; arch: string }
// The desktop shell schedules automatic checks (shortly after launch, then every 12 hours). This only keeps an
// automatic check from repeating one that already ran in this process within the hour; release details live in
// memory, so every launch checks again instead of waiting on a timestamp saved by an earlier run.
const MIN_AUTOMATIC_GAP_MS = 60 * 60 * 1000

export function createAppUpdate(ws: Workspace, currentVersion: string, app?: AppUpdate, fetchImpl?: typeof fetch) {
  let release: Pick<UpdateStatus, 'latestVersion' | 'publishedAt' | 'releaseNotes' | 'releasePageUrl' | 'asset'> = {
    latestVersion: null, publishedAt: null, releaseNotes: null, releasePageUrl: RELEASES_URL, asset: null
  }
  let phase: UpdateStatus['phase'] = 'idle'
  let error: string | null = null
  let pending: Promise<UpdateStatus> | undefined
  let lastStarted = 0

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
    if (automatic && (ws.settings.update?.autoCheck === false || now - lastStarted < MIN_AUTOMATIC_GAP_MS))
      return Promise.resolve(status())
    lastStarted = now
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
        // Only a completed check counts as the last check shown in settings.
        try { save({ lastCheckedAt: new Date().toISOString() }) } catch { /* the result still shows in this session */ }
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
