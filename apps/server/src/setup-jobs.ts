// Background setup jobs started from Settings: the Python environment for the built-in tools and
// the offline sandbox image. They run the same scripts as `npm run setup:python` / `sandbox:build`,
// so the desktop app needs no terminal. Only these two fixed scripts can run.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pyenvDir, type Workspace } from '@evoscholar/core'

export type SetupKind = 'python' | 'sandbox'
type Job = { running: boolean; ok?: boolean; log: string; child?: ChildProcess }

const SCRIPTS: Record<SetupKind, string> = { python: 'setup-python.mjs', sandbox: 'build-sandbox.mjs' }
const LOG_LIMIT = 16_000

export function createSetupJobs(ws: Workspace) {
  const jobs = new Map<SetupKind, Job>()
  // Do not leave a pip install or docker build running after the app quits.
  process.once('exit', () => { for (const job of jobs.values()) job.child?.kill() })
  const pythonReady = () => ['bin/python', 'Scripts/python.exe'].some((p) => existsSync(join(pyenvDir(ws.dataDir), p)))
  return {
    status(kind: SetupKind) {
      const job = jobs.get(kind)
      return { running: !!job?.running, ok: job?.ok, log: job?.log ?? '', ...(kind === 'python' ? { ready: pythonReady() } : {}) }
    },
    start(kind: SetupKind) {
      if (jobs.get(kind)?.running) return
      const script = join(ws.root, 'scripts', SCRIPTS[kind])
      if (!existsSync(script)) throw new Error('安装脚本缺失')
      const job: Job = { running: true, log: '' }
      jobs.set(kind, job)
      // The Electron binary behaves as Node with this flag; plain Node ignores it.
      const child = spawn(process.execPath, [script], {
        cwd: ws.root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$/i.test(k))), ELECTRON_RUN_AS_NODE: '1', EVOSCHOLAR_ENGINE: ws.settings.execution?.engine ?? 'docker', ...(ws.settings.execution?.image ? { EVOSCHOLAR_IMAGE: ws.settings.execution.image } : {}) }
      })
      job.child = child
      const add = (b: Buffer) => { job.log = (job.log + b.toString('utf8')).slice(-LOG_LIMIT) }
      child.stdout!.on('data', add)
      child.stderr!.on('data', add)
      child.on('error', (e) => { job.log += `\n${e.message}`; job.running = false; job.ok = false })
      child.on('close', (code) => { job.running = false; job.ok = code === 0; job.child = undefined })
    }
  }
}
