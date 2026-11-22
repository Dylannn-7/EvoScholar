// EvoScholar desktop app: runs the workbench server in-process and shows it in a window.
// The HTTP API keeps its bearer-token protection (other local programs still cannot call it);
// this shell attaches the token to every request from its own window, so there is no pairing step.
'use strict'
const { app, BrowserWindow, dialog, session, shell } = require('electron')
const { execFileSync } = require('node:child_process')
const { createServer } = require('node:http')
const { join } = require('node:path')
const { prepareWorkspace } = require('./workspace.cjs')

const APP = app.getAppPath() // repository root in development, resources/app when packaged

let window
let stopServer = async () => {}

/**
 * Apps opened from Finder or the Dock get launchd's minimal PATH, which misses docker, uv and
 * Homebrew's python. Take the login shell's PATH plus the usual install locations.
 */
function extendPath () {
  if (process.platform === 'win32') return
  const home = app.getPath('home')
  const parts = (process.env.PATH || '').split(':')
  try {
    const shellPath = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'],
      { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] })
    const m = /__PATH__(.*)__PATH__/.exec(shellPath)
    if (m) parts.push(...m[1].split(':'))
  } catch { /* a broken shell profile must not stop the app */ }
  parts.push('/opt/homebrew/bin', '/usr/local/bin', join(home, '.local/bin'), join(home, '.docker/bin'),
    '/Applications/Docker.app/Contents/Resources/bin', join(home, '.cargo/bin'))
  process.env.PATH = [...new Set(parts.filter(Boolean))].join(':')
}

/** Writable workspace in the user data folder; the install folder is read-only. */
function workspaceRoot () {
  if (!app.isPackaged) return APP
  return prepareWorkspace({ appDir: APP, root: join(app.getPath('userData'), 'workspace'), version: app.getVersion() })
}

async function startServer () {
  const core = require(join(APP, 'packages/core/dist/index.js'))
  const { createServerApp } = require(join(APP, 'apps/server/dist/server.js'))
  const { createLocalAuth } = require(join(APP, 'apps/server/dist/local-auth.js'))
  const ws = core.openWorkspace(workspaceRoot())
  let workbench
  const rt = core.openRuntime(ws, (message) => workbench?.broadcastAll({ type: 'warning', message }))
  const auth = createLocalAuth()
  const { token } = auth.exchange(auth.pairing.auto)
  workbench = createServerApp(rt, { webDir: join(APP, 'apps/web/public'), auth })
  const server = createServer(workbench.handler)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  // Smoke tests use a fresh workspace, so there are no leftover containers to recover.
  if (process.env.EVOSCHOLAR_SMOKE !== '1') void Promise.resolve(rt.executor.recover?.()).catch(() => {})
  stopServer = async () => {
    await workbench.dispose().catch(() => {})
    server.close()
    try { rt.db.close() } catch {}
  }
  return { origin: `http://127.0.0.1:${server.address().port}`, token }
}

function openWindow ({ origin, token }) {
  const ses = session.defaultSession
  ses.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
    // Only the workbench's own fetch calls carry the token: not page loads, not sub-resources,
    // and not anything inside a file-preview frame.
    const own = window && details.webContentsId === window.webContents.id && details.resourceType === 'xhr' && !details.frame?.parent
    if (!own) return callback({})
    const headers = details.requestHeaders
    for (const key of Object.keys(headers)) if (key.toLowerCase() === 'authorization') delete headers[key]
    headers.Authorization = `Bearer ${token}`
    callback({ requestHeaders: headers })
  })
  // Copy buttons need clipboard writes; nothing in the workbench needs camera, location or the like.
  const allowed = new Set(['clipboard-sanitized-write'])
  ses.setPermissionRequestHandler((_contents, permission, callback) => callback(allowed.has(permission)))
  ses.setPermissionCheckHandler((_contents, permission) => allowed.has(permission))
  window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 640, title: 'EvoScholar', backgroundColor: '#000000', show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
  window.once('ready-to-show', () => window.show())
  // External links (vendor key pages, docs) open in the system browser; the window stays on the workbench.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(origin)) shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(origin)) return
    event.preventDefault()
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
  })
  window.on('closed', () => { window = undefined })
  window.loadURL(`${origin}/`)
  if (process.env.EVOSCHOLAR_SMOKE === '1') window.webContents.once('did-finish-load', () => smokeCheck(origin))
}

/** EVOSCHOLAR_SMOKE=1: confirm the page renders, no pairing dialog shows and API calls succeed, then quit. */
async function smokeCheck (origin) {
  let result
  try {
    await new Promise((resolve) => setTimeout(resolve, 2500))
    result = await window.webContents.executeJavaScript(`(async () => ({
      heading: document.querySelector('.greet h1')?.textContent || '',
      pairing: !!document.querySelector('#pairing'),
      state: (await fetch('/api/state')).status
    }))()`)
    result.ok = result.heading.includes('今天想研究什么') && !result.pairing && result.state === 200
    // Requests from other local programs still need the token.
    result.unauthenticated = (await fetch(`${origin}/api/state`)).status
    // Informational: tools a Finder launch must still find through the extended PATH.
    result.dockerCli = !require('node:child_process').spawnSync('docker', ['--version']).error
    result.uv = !require('node:child_process').spawnSync('uv', ['--version']).error
    result.ok = result.ok && result.unauthenticated === 401
  } catch (error) { result = { ok: false, error: String(error) } }
  console.log('EVOSCHOLAR_SMOKE ' + JSON.stringify(result))
  process.exitCode = result.ok ? 0 : 1
  app.quit()
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus() } })
  app.whenReady().then(async () => {
    extendPath()
    try { openWindow(await startServer()) } catch (error) {
      dialog.showErrorBox('EvoScholar 无法启动', error instanceof Error ? error.message : String(error))
      app.quit()
    }
  })
  app.on('window-all-closed', () => app.quit())
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    stopServer().finally(() => app.exit(process.exitCode ?? 0))
  })
}
