import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Json } from '@evoscholar/harness'
import { checkCommand, inside } from './sandbox'
import { objectArgs, shellFor, textResult, type ToolEnv, type ToolFactory } from './types'

const OUT_LIMIT = 20_000
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
  const scrubbed = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$/.test(k)))
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

async function approve(env: ToolEnv, tool: string, summary: string): Promise<boolean> {
  return env.approve ? env.approve(tool, summary, 'exec') : true
}

function snapshot(dir: string, depth = 3): Map<string, number> {
  const m = new Map<string, number>()
  const walk = (d: string, n: number) => {
    let names: string[] = []
    try { names = readdirSync(d) } catch { return }
    for (const name of names) {
      if (name === 'node_modules' || name === '.git' || name === '.evoscholar') continue
      const f = join(d, name)
      const st = statSync(f)
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

/**
 * Kill a process and everything it started. On Windows `child.kill()` only ends the direct child
 * (e.g. PowerShell), leaving grandchildren that keep the output pipes open, so use taskkill /T.
 */
export function killTree(child: ChildProcess, force = false): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill()) } catch { child.kill() }
  } else child.kill(force ? 'SIGKILL' : 'SIGTERM')
}

/** Resolve once the process has exited; give its pipes a short grace period to drain, never wait forever. */
function settled(child: ChildProcess, onDone: (code: number | null, sig: string | null) => void): void {
  let done = false
  const finish = (code: number | null, sig: string | null) => {
    if (done) return
    done = true
    onDone(code, sig)
  }
  child.on('close', (code, sig) => finish(code, sig))
  child.on('exit', (code, sig) => setTimeout(() => {
    child.stdout?.destroy(); child.stderr?.destroy()
    finish(code, sig)
  }, 1500))
  child.on('error', () => setTimeout(() => finish(child.exitCode ?? -1, null), 50))
}

function run(cmd: string, args: string[], env: ToolEnv, timeoutS: number, signal: AbortSignal) {
  return new Promise<{ code: number | null; signal: string | null; out: string; stdout: string; timedOut: boolean }>((resolveP) => {
    const child = spawn(cmd, args, { cwd: env.cwd, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let stdout = ''
    let timedOut = false
    const add = (b: Buffer) => { out += b.toString('utf8'); if (out.length > 4 * OUT_LIMIT) out = out.slice(-2 * OUT_LIMIT) }
    child.stdout.on('data', (b: Buffer) => { add(b); stdout += b.toString('utf8') })
    child.stderr.on('data', add)
    const kill = () => { killTree(child); setTimeout(() => killTree(child, true), 2000) }
    const timer = setTimeout(() => { timedOut = true; kill() }, timeoutS * 1000)
    signal.addEventListener('abort', kill, { once: true })
    child.on('error', (e) => { out += `\n[spawn error] ${e.message}` })
    settled(child, (code, sig) => { clearTimeout(timer); signal.removeEventListener('abort', kill); resolveP({ code, signal: sig, out, stdout, timedOut }) })
  })
}

function report(r: { code: number | null; signal: string | null; out: string; timedOut: boolean }, changed: string[], env?: ToolEnv) {
  if (changed.length) env?.onFiles?.(changed)
  const status = r.timedOut ? '超时被终止' : r.code === 0 ? '退出码 0' : `退出码 ${r.code ?? r.signal}`
  const files = changed.length ? `\n新建或修改的文件：${changed.join(', ')}` : ''
  return textResult(`[${status}]${files}\n${clip(r.out.trim()) || '（无输出）'}`, !r.timedOut && r.code !== 0 ? true : r.timedOut)
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
    if ((a.code === undefined) === (a.file === undefined)) throw new Error('Provide exactly one of code or file')
    if (a.args !== undefined && (!Array.isArray(a.args) || !a.args.every((x) => typeof x === 'string'))) throw new Error('args must be strings')
    return a as Json
  },
  authorize: async (args) => {
    const a = args as { code?: string; file?: string }
    return approve(env, 'run_python', a.file ? `运行脚本 ${a.file}` : `运行 Python 代码：\n${String(a.code).slice(0, 600)}`)
  },
  async execute(args, ctx) {
    const a = args as { code?: string; file?: string; args?: string[]; timeout_s?: number }
    let script: string
    if (a.code !== undefined) {
      const dir = join(env.cwd, '.evoscholar', 'cells')
      mkdirSync(dir, { recursive: true })
      script = join(dir, `cell-${Date.now()}.py`)
      writeFileSync(script, a.code, 'utf8')
    } else script = inside(env.cwd, a.file!)
    const before = snapshot(env.cwd)
    env.trace?.({ kind: 'exec', tool: 'run_python', file: relative(env.cwd, script) })
    const r = await run(pythonBin(env), [script, ...(a.args ?? [])], env, a.timeout_s ?? 120, ctx.signal)
    env.trace?.({ kind: 'exec.exit', tool: 'run_python', code: r.code, timedOut: r.timedOut })
    return report(r, changedFiles(before, snapshot(env.cwd), env.cwd), env)
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
    checkCommand(a.command)
    return a as Json
  },
  authorize: async (args) => approve(env, 'run_command', `运行命令：${(args as { command: string }).command}`),
  async execute(args, ctx) {
    const a = args as { command: string; timeout_s?: number }
    const before = snapshot(env.cwd)
    env.trace?.({ kind: 'exec', tool: 'run_command', command: a.command })
    const [cmd, cmdArgs] = shellFor(a.command)
    const r = await run(cmd, cmdArgs, env, a.timeout_s ?? 120, ctx.signal)
    env.trace?.({ kind: 'exec.exit', tool: 'run_command', code: r.code, timedOut: r.timedOut })
    return report(r, changedFiles(before, snapshot(env.cwd), env.cwd), env)
  }
})

type Proc = { id: string; command: string; child: ChildProcess; out: string; read: number; startedAt: number }
const PROCS = new Map<string, Map<string, Proc>>()
const procsFor = (env: ToolEnv) => {
  const key = env.sessionId ?? env.cwd
  if (!PROCS.has(key)) PROCS.set(key, new Map())
  return PROCS.get(key)!
}

/** Stop every background process a session started (called when the session closes). */
export async function stopAllProcesses(sessionKey: string): Promise<void> {
  const m = PROCS.get(sessionKey)
  if (!m) return
  await Promise.all([...m.values()].map((p) => stopProc(p)))
  PROCS.delete(sessionKey)
}

function stopProc(p: Proc): Promise<void> {
  return new Promise((res) => {
    if (p.child.exitCode !== null || p.child.signalCode !== null) return res()
    const t = setTimeout(res, 5000)   // never block shutdown on a stubborn process
    settled(p.child, () => { clearTimeout(t); res() })
    killTree(p.child)
    setTimeout(() => killTree(p.child, true), 3000)
  })
}

const wait = (ms: number, signal: AbortSignal) => new Promise<void>((r) => { const t = setTimeout(r, ms); signal.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true }) })

function procStatus(p: Proc): string {
  if (p.child.exitCode !== null) return `已退出（退出码 ${p.child.exitCode}）`
  if (p.child.signalCode) return `已终止（${p.child.signalCode}）`
  return '运行中'
}

export const startProcess: ToolFactory = (env) => ({
  name: 'start_process',
  version: '1',
  description: '在工作目录中后台启动一个长时间运行的命令（如本地模拟服务），等待 wait_s 秒后返回进程 id 和到目前为止的输出。用完必须调用 stop_process。',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string' }, wait_s: { type: 'number', minimum: 0, maximum: 30, description: '默认 2 秒' } },
    required: ['command'],
    additionalProperties: false
  },
  scheduling: 'exclusive',
  validate(i) {
    const a = objectArgs(i, ['command', 'wait_s'], ['command'])
    if (typeof a.command !== 'string' || !a.command.trim()) throw new Error('command required')
    checkCommand(a.command)
    return a as Json
  },
  authorize: async (args) => approve(env, 'start_process', `后台启动：${(args as { command: string }).command}`),
  async execute(args, ctx) {
    const a = args as { command: string; wait_s?: number }
    const procs = procsFor(env)
    if (procs.size >= 4) return textResult('后台进程已有 4 个，请先 stop_process', true)
    const [cmd, cmdArgs] = shellFor(process.platform === 'win32' ? a.command : `exec ${a.command}`)
    const child = spawn(cmd, cmdArgs, { cwd: env.cwd, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const id = `p${Date.now().toString(36)}`
    const p: Proc = { id, command: a.command, child, out: '', read: 0, startedAt: Date.now() }
    const add = (b: Buffer) => { p.out += b.toString('utf8'); if (p.out.length > 200_000) { p.out = p.out.slice(-100_000); p.read = 0 } }
    child.stdout!.on('data', add)
    child.stderr!.on('data', add)
    procs.set(id, p)
    env.trace?.({ kind: 'process.start', id, command: a.command })
    await wait((a.wait_s ?? 2) * 1000, ctx.signal)
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
    const p = procsFor(env).get(a.id)
    if (!p) return textResult(`没有进程 ${a.id}`, true)
    if (a.wait_s) await wait(a.wait_s * 1000, ctx.signal)
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
  authorize: async () => true,
  async execute(args) {
    const id = (args as { id: string }).id
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
  description: '对本机服务（localhost / 127.0.0.1）发起 HTTP GET，返回状态码和正文。访问外网请用 web_fetch。',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string' }, timeout_s: { type: 'integer', minimum: 1, maximum: 60 } },
    required: ['url'],
    additionalProperties: false
  },
  scheduling: 'parallel',
  validate(i) {
    const a = objectArgs(i, ['url', 'timeout_s'], ['url'])
    const u = new URL(String(a.url))
    if (!/^https?:$/.test(u.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new Error('http_get 只能访问本机地址')
    return a as Json
  },
  authorize: async () => true,
  async execute(args, ctx) {
    const a = args as { url: string; timeout_s?: number }
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout((a.timeout_s ?? 15) * 1000)])
    try {
      const res = await fetch(a.url, { signal })
      const body = await res.text()
      env.trace?.({ kind: 'http', url: a.url, status: res.status })
      return textResult(`HTTP ${res.status}\n${clip(body)}`)
    } catch (e) {
      env.trace?.({ kind: 'http', url: a.url, error: (e as Error).message })
      return textResult(`请求失败：${(e as Error).message}`, true)
    }
  }
})
