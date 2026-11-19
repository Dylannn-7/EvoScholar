import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, lstatSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { join, relative, sep } from 'node:path'
import type { Json } from '@evoscholar/harness'
import { chooseExecution, type ExecutionJob, type IsolatedService, type ProcessResult } from '../execution'
import { checkCommand, inside } from './sandbox'
import { objectArgs, shellFor, textResult, type ToolEnv, type ToolFactory } from './types'

const OUT_LIMIT = 20_000
const MAX_STDOUT = 8 * 1024 * 1024
const clip = (s: string, n = OUT_LIMIT) => (s.length > n ? s.slice(0, n / 2) + `\n…（省略 ${s.length - n} 字符）…\n` + s.slice(-n / 2) : s)

/** Per-platform venv dir, so a folder shared between macOS and a Linux VM never mixes binaries. */
export const pyenvDir = (dataDir: string) => join(dataDir, `pyenv-${process.platform}-${process.arch}`)

/** Python from the project venv (npm run setup:python) if present, else python3 on PATH. */
export function pythonBin(env: ToolEnv): string {
  const dir = pyenvDir(env.ws.dataDir)
  for (const p of [join(dir, 'bin', 'python'), join(dir, 'Scripts', 'python.exe')]) if (existsSync(p)) return p
  return process.platform === 'win32' ? 'python' : 'python3'
}

export function childEnv(env: ToolEnv): NodeJS.ProcessEnv {
  const pyPath = [join(env.ws.root, 'python'), process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':')
  // Model-facing code never sees provider keys.
  const scrubbed = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$/i.test(k)))
  return { ...scrubbed, MPLBACKEND: 'Agg', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONPATH: pyPath, EVOSCHOLAR_CWD: env.cwd, EVOSCHOLAR_DATA: env.ws.dataDir }
}

/** Run the bundled literature helper (python/evoscholar_lit.py) and parse its JSON/stdout. */
export function runLitHelper(env: ToolEnv, args: string[], signal: AbortSignal): Promise<string> {
  return runPyHelper(env, 'evoscholar_lit.py', args, signal)
}

/** Run a bundled helper script from python/ and return the JSON part of its stdout. */
export async function runPyHelper(env: ToolEnv, script: string, args: string[], signal: AbortSignal, timeoutS = 120): Promise<string> {
  const r = await run(pythonBin(env), [join(env.ws.root, 'python', script), ...args], env, timeoutS, signal)
  if (r.code !== 0) throw new Error(r.out.trim().split('\n').slice(-3).join(' ') || `helper exit ${r.code}`)
  // JSON goes to stdout; library warnings (stderr or stray stdout lines) are dropped.
  const i = r.stdout.search(/^[[{]/m)
  return i >= 0 ? r.stdout.slice(i) : r.stdout
}

async function approve(env: ToolEnv, tool: string, summary: string, signal?: AbortSignal): Promise<boolean> {
  return env.approve ? env.approve(tool, summary, 'exec', signal) : true
}

function snapshot(dir: string, depth = 3): Map<string, number> {
  const m = new Map<string, number>()
  const walk = (d: string, n: number) => {
    let names: string[] = []
    try { names = readdirSync(d) } catch { return }
    for (const name of names) {
      if (name === 'node_modules' || name === '.git' || name === '.evoscholar') continue
      const f = join(d, name)
      const st = lstatSync(f, { throwIfNoEntry: false })
      if (!st || st.isSymbolicLink()) continue
      if (st.isDirectory()) { if (n > 1) walk(f, n - 1) } else m.set(f, st.mtimeMs)
      if (m.size > 2000) return
    }
  }
  walk(dir, depth)
  return m
}

function changedFiles(before: Map<string, number>, after: Map<string, number>, cwd: string): string[] {
  return [...after].filter(([f, t]) => before.get(f) !== t).map(([f]) => relative(cwd, f)).slice(0, 50)
}

/** Spawn a process in env.cwd with the scrubbed child environment (no provider keys). */
export function runProcess(cmd: string, args: string[], env: ToolEnv, timeoutS: number, signal: AbortSignal) {
  return run(cmd, args, env, timeoutS, signal)
}

export async function runModelProcess(env: ToolEnv, job: ExecutionJob, timeout: number, signal?: AbortSignal) {
  const active = signal ?? AbortSignal.timeout((timeout + 1) * 1000)
  if (await chooseExecution(env) === 'isolated') {
    const result = await env.executor!.run(env, job, timeout, active)
    if (result.files?.length) env.onFiles?.(result.files)
    return result
  }
  return run(...job.host, env, timeout, active)
}

async function run(cmd: string, args: string[], env: ToolEnv, timeoutS: number, signal: AbortSignal) {
  signal.throwIfAborted()
  return new Promise<ProcessResult>((resolveP, reject) => {
    const child = spawn(cmd, args, { cwd: env.cwd, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let bytes = 0
    const stdout: Buffer[] = []
    let timedOut = false
    let overflow = false
    let forceTimer: NodeJS.Timeout | undefined
    const kill = () => {
      if (forceTimer) return
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        child.stdout.destroy()
        child.stderr.destroy()
      }, 2000)
    }
    const add = (b: Buffer) => {
      out += b.toString('utf8')
      if (out.length > 4 * OUT_LIMIT) out = out.slice(-2 * OUT_LIMIT)
    }
    child.stdout.on('data', (b: Buffer) => {
      add(b)
      if (overflow) return
      bytes += b.length
      if (bytes > MAX_STDOUT) { overflow = true; kill() }
      else stdout.push(b)
    })
    child.stderr.on('data', add)
    const timer = setTimeout(() => { timedOut = true; kill() }, timeoutS * 1000)
    signal.addEventListener('abort', kill, { once: true })
    child.on('error', (e) => { out += `\n[spawn error] ${e.message}` })
    child.once('close', (code, sig) => {
      clearTimeout(timer)
      clearTimeout(forceTimer)
      signal.removeEventListener('abort', kill)
      if (signal.aborted) return reject(signal.reason)
      if (overflow) out += '\n输出超过 8 MB，已停止进程'
      resolveP({ code: overflow ? null : code, signal: sig, out, stdout: Buffer.concat(stdout).toString('utf8'), timedOut })
    })
  })
}

function report(r: { code: number | null; signal: string | null; out: string; timedOut: boolean }, changed: string[], env?: ToolEnv) {
  if (changed.length) env?.onFiles?.(changed)
  const status = r.timedOut ? '超时被终止' : r.code === 0 ? '退出码 0' : `退出码 ${r.code ?? r.signal}`
  const files = changed.length ? `\n新建或修改的文件：${changed.join(', ')}` : ''
  return textResult(`[${status}]${files}\n${clip(r.out.trim()) || '（无输出）'}`, !r.timedOut && r.code !== 0 ? true : r.timedOut)
}

function validateTimeout(value: unknown, limit: number) {
  if (value !== undefined && (!Number.isInteger(value) || Number(value) < 1 || Number(value) > limit))
    throw new Error(`超时必须为 1–${limit} 秒`)
}

export const runPython: ToolFactory = (env) => ({
  name: 'run_python',
  version: '1',
  description:
    '在工作目录中运行 Python（已装 numpy、pandas、scipy、matplotlib、SciencePlots 时可直接用；图用 savefig 保存为文件，不要 plt.show()）。' +
    '传 code 运行一段代码，或传 file 运行已有脚本（可带 args）。每次调用是独立进程，变量不保留，中间结果请写到文件。',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Python 源码' },
      file: { type: 'string', description: '工作目录内的 .py 脚本路径' },
      args: { type: 'array', items: { type: 'string' } },
      timeout_s: { type: 'integer', minimum: 1, maximum: 900, description: '默认 120' }
    },
    additionalProperties: false
  },
  scheduling: 'exclusive',
  validate(i) {
    const a = objectArgs(i, ['code', 'file', 'args', 'timeout_s'])
    if ((a.code === undefined) === (a.file === undefined) ||
      (a.code !== undefined && typeof a.code !== 'string') || (a.file !== undefined && typeof a.file !== 'string'))
      throw new Error('请提供 code 或 file，且只能提供一个')
    validateTimeout(a.timeout_s, 900)
    if (a.args !== undefined && (!Array.isArray(a.args) || !a.args.every((x) => typeof x === 'string'))) throw new Error('args must be strings')
    return a as Json
  },
  authorize: async (args, ctx) => {
    const a = args as { code?: string; file?: string }
    return approve(env, 'run_python', a.file ? `运行脚本 ${a.file}` : `运行 Python 代码：\n${String(a.code).slice(0, 600)}`, ctx.signal)
  },
  async execute(args, ctx) {
    const a = args as { code?: string; file?: string; args?: string[]; timeout_s?: number }
    const mode = await chooseExecution(env)
    const args0 = a.args ?? []
    const script = a.file === undefined ? undefined : inside(env.cwd, a.file)
    const before = mode === 'host' ? snapshot(env.cwd) : new Map<string, number>()
    let r
    if (mode === 'isolated') {
      const path = script ? relative(inside(env.cwd, '.'), script).split(sep).join('/') : '/control/cell.py'
      const job: ExecutionJob = { host: [pythonBin(env), []], sandbox: ['python', path, ...args0], code: a.code }
      r = await env.executor!.run(env, job, a.timeout_s ?? 120, ctx.signal)
    } else {
      let file = script
      if (!file) {
        const dir = inside(env.cwd, join('.evoscholar', 'cells'))
        mkdirSync(dir, { recursive: true })
        file = inside(env.cwd, join(dir, `cell-${randomUUID()}.py`))
        writeFileSync(file, a.code!, { encoding: 'utf8', flag: 'wx' })
      }
      r = await run(pythonBin(env), [file, ...args0], env, a.timeout_s ?? 120, ctx.signal)
    }
    env.trace?.({ kind: 'exec', tool: 'run_python', mode, ...(a.file ? { file: a.file } : {}) })
    env.trace?.({ kind: 'exec.exit', tool: 'run_python', code: r.code, timedOut: r.timedOut })
    return report(r, mode === 'host' ? changedFiles(before, snapshot(env.cwd), env.cwd) : r.files ?? [], env)
  }
})

export const runCommand: ToolFactory = (env) => ({
  name: 'run_command',
  version: '1',
  description: `在工作目录中运行一条短命令并等待结束（${process.platform === 'win32' ? 'Windows PowerShell 语法，如 Get-ChildItem、python x.py' : 'POSIX shell 语法，如 ls、python3 x.py'}、xelatex main.tex）。需要长时间运行的服务请用 start_process。`,
  parameters: {
    type: 'object',
    properties: { command: { type: 'string' }, timeout_s: { type: 'integer', minimum: 1, maximum: 900, description: '默认 120' } },
    required: ['command'],
    additionalProperties: false
  },
  scheduling: 'exclusive',
  validate(i) {
    const a = objectArgs(i, ['command', 'timeout_s'], ['command'])
    if (typeof a.command !== 'string' || !a.command.trim()) throw new Error('command required')
    validateTimeout(a.timeout_s, 900)
    checkCommand(a.command)
    return a as Json
  },
  authorize: async (args, ctx) => approve(env, 'run_command', `运行命令：${(args as { command: string }).command}`, ctx.signal),
  async execute(args, ctx) {
    const a = args as { command: string; timeout_s?: number }
    const mode = await chooseExecution(env)
    const before = mode === 'host' ? snapshot(env.cwd) : new Map<string, number>()
    env.trace?.({ kind: 'exec', tool: 'run_command', command: a.command, mode })
    const r = mode === 'isolated'
      ? await env.executor!.run(env, { host: shellFor(a.command), sandbox: ['/bin/sh', '-c', a.command] }, a.timeout_s ?? 120, ctx.signal)
      : await run(...shellFor(a.command), env, a.timeout_s ?? 120, ctx.signal)
    env.trace?.({ kind: 'exec.exit', tool: 'run_command', code: r.code, timedOut: r.timedOut })
    return report(r, mode === 'host' ? changedFiles(before, snapshot(env.cwd), env.cwd) : r.files ?? [], env)
  }
})

type Proc = { child: ChildProcess; out: string; read: number; closed: Promise<void>; error?: string; port?: number }
const PROCS = new Map<string, Map<string, Proc>>()
type ContainerProc = { service: IsolatedService; port?: number; previous: string }
const containers = new Map<string, Map<string, ContainerProc>>()
const sessionKey = (env: ToolEnv) => env.sessionId ?? env.cwd
const containersFor = (env: ToolEnv) => {
  const key = sessionKey(env)
  if (!containers.has(key)) containers.set(key, new Map())
  return containers.get(key)!
}
async function readContainer(id: string, job: ContainerProc, signal: AbortSignal) {
  const { text, output } = await job.service.read(signal)
  const change = output.startsWith(job.previous) ? output.slice(job.previous.length) : output
  job.previous = output
  return textResult(`进程 ${id}：${text}\n${clip(change.trim()) || '（没有新输出）'}`)
}
const procsFor = (env: ToolEnv) => {
  const key = env.sessionId ?? env.cwd
  if (!PROCS.has(key)) PROCS.set(key, new Map())
  return PROCS.get(key)!
}

/** Stop every background process a session started (called when the session closes). */
export async function stopAllProcesses(sessionKey: string): Promise<void> {
  const processes = PROCS.get(sessionKey)
  const services = containers.get(sessionKey)
  PROCS.delete(sessionKey)
  containers.delete(sessionKey)
  await Promise.allSettled([
    ...[...(processes?.values() ?? [])].map(stopProc),
    ...[...(services?.values() ?? [])].map((job) => job.service.stop())
  ])
}

async function stopProc(p: Proc): Promise<void> {
  const running = () => !p.error && p.child.exitCode === null && p.child.signalCode === null
  if (running()) p.child.kill('SIGTERM')
  const timer = setTimeout(() => {
    if (running()) p.child.kill('SIGKILL')
    p.child.stdout?.destroy()
    p.child.stderr?.destroy()
  }, 3000)
  try { await p.closed } finally { clearTimeout(timer) }
}

function procStatus(p: Proc): string {
  if (p.error) return '启动失败'
  if (p.child.exitCode !== null) return `已退出（退出码 ${p.child.exitCode}）`
  if (p.child.signalCode) return `已终止（${p.child.signalCode}）`
  return '运行中'
}

async function unusedServicePort(port: number): Promise<void> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', () => reject(new Error('后台服务端口已被占用')))
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => probe.close(() => resolve()))
  })
}

export const startProcess: ToolFactory = (env) => ({
  name: 'start_process',
  version: '1',
  description: '在工作目录中后台启动一个长时间运行的命令（如本地模拟服务），等待 wait_s 秒后返回进程 ID。需要 http_get 时，填写 port 并让服务监听同一个回环端口。用完必须调用 stop_process。',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string' }, port: { type: 'integer', minimum: 1024, maximum: 65535 }, wait_s: { type: 'number', minimum: 0, maximum: 30, description: '默认 2 秒' } },
    required: ['command'],
    additionalProperties: false
  },
  scheduling: 'exclusive',
  validate(i) {
    const a = objectArgs(i, ['command', 'wait_s', 'port'], ['command'])
    if (typeof a.command !== 'string' || !a.command.trim()) throw new Error('command required')
    if (a.port !== undefined && (!Number.isInteger(a.port) || Number(a.port) < 1024 || Number(a.port) > 65535))
      throw new Error('后台服务端口必须为 1024–65535')
    checkCommand(a.command)
    return a as Json
  },
  authorize: async (args, ctx) => approve(env, 'start_process', `后台启动：${(args as { command: string }).command}`, ctx.signal),
  async execute(args, ctx) {
    const a = args as { command: string; wait_s?: number; port?: number }
    ctx.signal.throwIfAborted()
    const procs = procsFor(env)
    const services = containersFor(env)
    if (procs.size + services.size >= 4) return textResult('后台进程已有 4 个，请先 stop_process', true)
    if (a.port !== undefined && [...procs.values(), ...services.values()].some((job) => job.port === a.port))
      return textResult('本会话已登记这个端口', true)
    const mode = await chooseExecution(env)
    if (mode === 'isolated') {
      const id = `p-${randomUUID()}`
      const service = await env.executor!.start(env, { host: shellFor(a.command), sandbox: ['/bin/sh', '-c', a.command] }, ctx.signal)
      const job = { service, port: a.port, previous: '' }
      services.set(id, job)
      try {
        await delay((a.wait_s ?? 2) * 1000, undefined, { signal: ctx.signal })
        const result = await readContainer(id, job, ctx.signal)
        env.trace?.({ kind: 'process.start', id, mode })
        return result
      } catch (error) {
        services.delete(id)
        await service.stop()
        throw error
      }
    }
    if (a.port !== undefined) {
      if (a.port === (env.ws.config.localHttpPort ?? Number(process.env.EVOSCHOLAR_PORT ?? 4317)))
        return textResult('不能登记工作台端口', true)
      await unusedServicePort(a.port)
      ctx.signal.throwIfAborted()
    }
    const [cmd, cmdArgs] = shellFor(a.command)
    const child = spawn(cmd, cmdArgs, { cwd: env.cwd, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const id = `p-${randomUUID()}`
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    const p: Proc = { child, out: '', read: 0, closed, port: a.port }
    child.on('error', (error) => { p.error = error.message })
    const add = (b: Buffer) => { p.out += b.toString('utf8'); if (p.out.length > 200_000) { p.out = p.out.slice(-100_000); p.read = 0 } }
    child.stdout!.on('data', add)
    child.stderr!.on('data', add)
    procs.set(id, p)
    env.trace?.({ kind: 'process.start', id, command: a.command })
    try {
      await delay((a.wait_s ?? 2) * 1000, undefined, { signal: ctx.signal })
    } catch (error) {
      await stopProc(p)
      procs.delete(id)
      throw error
    }
    if (p.error) {
      procs.delete(id)
      return textResult(`进程启动失败：${p.error}`, true)
    }
    const out = p.out.slice(p.read)
    p.read = p.out.length
    return textResult(`进程 ${id}：${procStatus(p)}\n${clip(out.trim()) || '（暂无输出）'}`)
  }
})

export const readProcess: ToolFactory = (env) => ({
  name: 'read_process',
  version: '1',
  description: '读取后台进程自上次读取以来的新输出和运行状态；可先等待 wait_s 秒。',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string' }, wait_s: { type: 'number', minimum: 0, maximum: 60 } },
    required: ['id'],
    additionalProperties: false
  },
  scheduling: 'parallel',
  validate: (i) => objectArgs(i, ['id', 'wait_s'], ['id']) as Json,
  authorize: async () => true,
  async execute(args, ctx) {
    const a = args as { id: string; wait_s?: number }
    const service = containersFor(env).get(a.id)
    if (service) {
      if (a.wait_s) await delay(a.wait_s * 1000, undefined, { signal: ctx.signal })
      return readContainer(a.id, service, ctx.signal)
    }
    const p = procsFor(env).get(a.id)
    if (!p) return textResult(`没有进程 ${a.id}`, true)
    if (a.wait_s) await delay(a.wait_s * 1000, undefined, { signal: ctx.signal })
    const out = p.out.slice(p.read)
    p.read = p.out.length
    return textResult(`进程 ${a.id}：${procStatus(p)}\n${clip(out.trim()) || '（没有新输出）'}`)
  }
})

export const stopProcess: ToolFactory = (env) => ({
  name: 'stop_process',
  version: '1',
  description: '停止一个后台进程并返回它最后的输出。',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  scheduling: 'exclusive',
  validate: (i) => objectArgs(i, ['id'], ['id']) as Json,
  authorize: async (args, ctx) => approve(env, 'stop_process', `停止进程 ${(args as { id: string }).id}`, ctx.signal),
  async execute(args) {
    const id = (args as { id: string }).id
    const services = containersFor(env)
    const service = services.get(id)
    if (service) {
      try { await service.service.stop() } finally { services.delete(id) }
      env.trace?.({ kind: 'process.stop', id })
      return textResult(`进程 ${id} 已停止。`)
    }
    const procs = procsFor(env)
    const p = procs.get(id)
    if (!p) return textResult(`没有进程 ${id}`, true)
    await stopProc(p)
    procs.delete(id)
    env.trace?.({ kind: 'process.stop', id })
    return textResult(`进程 ${id} 已停止。\n${clip(p.out.slice(p.read).trim())}`)
  }
})

export const httpGet: ToolFactory = (env) => ({
  name: 'http_get',
  version: '1',
  description: '对本会话登记的后台服务发起 HTTP GET。URL 必须是 http://127.0.0.1:登记端口/路径。',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string' }, timeout_s: { type: 'integer', minimum: 1, maximum: 60 } },
    required: ['url'],
    additionalProperties: false
  },
  scheduling: 'parallel',
  validate(i) {
    const a = objectArgs(i, ['url', 'timeout_s'], ['url'])
    validateTimeout(a.timeout_s, 60)
    const u = new URL(String(a.url))
    if (u.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(u.hostname) || !u.port || u.username || u.password || u.hash)
      throw new Error('http_get 只接受本会话登记的回环 HTTP 端口')
    return a as Json
  },
  authorize: async () => true,
  async execute(args, ctx) {
    const a = args as { url: string; timeout_s?: number }
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout((a.timeout_s ?? 15) * 1000)])
    const url = new URL(a.url)
    const timeout = a.timeout_s ?? 15
    const service = [...containersFor(env).values()].find((p) => p.port === Number(url.port))
    if (service) {
      const result = await service.service.get(Number(url.port), url.pathname + url.search, timeout, signal)
      env.trace?.({ kind: 'http', url: a.url, status: result.status, mode: 'isolated' })
      return textResult(`HTTP ${result.status}\n${clip(result.body)}`)
    }
    const registered = [...procsFor(env).values()].some((p) =>
      p.port === Number(url.port) && !p.error && p.child.exitCode === null && p.child.signalCode === null)
    if (!registered) return textResult('这个端口未由本会话的后台服务登记', true)
    url.hostname = '127.0.0.1'
    try {
      const res = await fetch(url, { signal, redirect: 'error' })
      const reader = res.body?.getReader()
      const decoder = new TextDecoder()
      let body = ''
      try {
        while (reader && body.length < OUT_LIMIT) {
          const { done, value } = await reader.read()
          if (done) break
          body += decoder.decode(value, { stream: true })
        }
        body += decoder.decode()
      } finally {
        if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock() }
      }
      env.trace?.({ kind: 'http', url: a.url, status: res.status })
      return textResult(`HTTP ${res.status}\n${clip(body)}`)
    } catch (e) {
      env.trace?.({ kind: 'http', url: a.url, error: (e as Error).message })
      return textResult(`请求失败：${(e as Error).message}`, true)
    }
  }
})
