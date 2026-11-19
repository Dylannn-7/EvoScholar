// EvoScholar desktop app: runs the workbench server in-process and shows it in a window.
// The HTTP API keeps its bearer-token protection (other local programs still cannot call it);
// this shell attaches the token to every request from its own window, so there is no pairing step.
'use strict'
const { app, BrowserWindow, dialog, session, shell } = require('electron')
const { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { createServer } = require('node:http')
const { join } = require('node:path')

const APP = app.getAppPath() // repository root in development, resources/app when packaged
// App-owned files follow the installed version; genomes and skills evolve with the user.
const OWNED = ['evoscholar.config.json', 'prompts', 'python', 'sandbox', '.dockerignore', 'rulepacks/figures', 'rulepacks/writing',
  'scripts/setup-python.mjs', 'scripts/build-sandbox.mjs', 'scripts/requirements.txt']
const USER_SEEDED = ['genomes', 'skills']

let window
let stopServer = async () => {}

/** Writable workspace in the user data folder; the install folder is read-only. */
function workspaceRoot () {
  if (!app.isPackaged) return APP
  const root = join(app.getPath('userData'), 'workspace')
  const marker = join(root, '.app-version')
  const previous = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : ''
  mkdirSync(root, { recursive: true })
  const copy = (rel, overwrite) => {
    const from = join(APP, rel)
    if (existsSync(from)) cpSync(from, join(root, rel), { recursive: true, force: overwrite, errorOnExist: false })
  }
  if (previous !== app.getVersion()) for (const rel of OWNED) copy(rel, true)
  for (const rel of USER_SEEDED) copy(rel, false)
  if (!existsSync(join(root, '.env'))) writeFileSync(join(root, '.env'), '')
  writeFileSync(marker, app.getVersion())
  return root
}

async function startServer () {
  const core = require(join(APP, 'packages/core/dist/index.js'))
  const { createServerApp } = require(join(APP, 'apps/server/dist/server.js'))
  const { createLocalAuth } = require(join(APP, 'apps/server/dist/local-auth.js'))
  const ws = core.openWorkspace(workspaceRoot())
  let workbench
  const rt = core.openRuntime(ws, (message) => workbench?.broadcastAll({ type: 'warning', message }))
  await rt.executor.recover?.()
  const auth = createLocalAuth()
  const { token } = auth.exchange(auth.pairing.auto)
  workbench = createServerApp(rt, { webDir: join(APP, 'apps/web/public'), auth })
  const server = createServer(workbench.handler)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
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
    const headers = details.requestHeaders
    for (const key of Object.keys(headers)) if (key.toLowerCase() === 'authorization') delete headers[key]
    headers.Authorization = `Bearer ${token}`
    callback({ requestHeaders: headers })
  })
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
