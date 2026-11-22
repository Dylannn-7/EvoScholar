#!/usr/bin/env node
// Launch the desktop app once in smoke mode and fail unless the workbench renders without a
// pairing step while unauthenticated API calls are still refused.
//   node scripts/app-smoke.mjs            development build (electron .)
//   node scripts/app-smoke.mjs <app-exe>  packaged executable
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packaged = process.argv[2]
const userData = mkdtempSync(join(tmpdir(), 'evoscholar-smoke-'))
const [cmd, args] = packaged ? [packaged, [`--user-data-dir=${userData}`]]
  : [createRequire(import.meta.url)('electron'), ['.', `--user-data-dir=${userData}`]]
const env = { ...process.env, EVOSCHOLAR_SMOKE: '1' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(cmd, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let out = ''
child.stdout.on('data', (b) => { out += b })
child.stderr.on('data', (b) => { out += b })
const timer = setTimeout(() => { child.kill(); console.error('桌面应用冒烟测试超时'); process.exitCode = 1 }, 90_000)
child.on('close', (code) => {
  clearTimeout(timer)
  const line = out.split(/\r?\n/).find((l) => l.startsWith('EVOSCHOLAR_SMOKE '))
  console.log(line ?? out.slice(-2000))
  if (code !== 0 || !line || !JSON.parse(line.slice('EVOSCHOLAR_SMOKE '.length)).ok) process.exitCode = 1
  // Windows can still hold the workspace open briefly after Electron exits.
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
})
