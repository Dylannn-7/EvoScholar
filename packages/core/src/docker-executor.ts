import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { uptime } from 'node:os'
import { join } from 'node:path'
import type { Workspace } from './config'
import type { ExecutionBackend, ExecutionJob, ExecutionStatus, IsolatedService, ProcessResult } from './execution'
import { checkProjectRoot, copySkillResources, stageDirectory, StagedProject } from './staged-project'
import type { ToolEnv } from './tools/types'

export const DEFAULT_SANDBOX_IMAGE = 'evoscholar-sandbox:1'
const LABEL = 'io.evoscholar'
// Docker Desktop's resource saver pauses its VM when idle; the first CLI call wakes it and can
// take several seconds. A stopped daemon still fails fast, so a generous timeout costs nothing.
const PROBE_S = 15
/** Host boot time in minutes. A container from an earlier boot cannot belong to a live process. */
export const bootMinute = () => Math.round((Date.now() / 1000 - uptime()) / 60)
type Engine = (command: string, args: string[], timeout: number, signal: AbortSignal) => Promise<ProcessResult>
type Stage = ReturnType<typeof stageDirectory>
type SessionStage = { stage: Stage; project: StagedProject; running: boolean }

export function dockerCreateArgs(box: {
  name: string; image: string; owner: string; session: string; work: string; control: string; argv: string[]
}): string[] {
  if ([box.work, box.control].some((path) => /[,\r\n]/.test(path))) throw new Error('容器临时目录名不能包含逗号或换行')
  return [
    'create', '--name', box.name, '--pull=never', '--network', 'none', '--read-only', '--user', '65532:65532',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '1g', '--cpus', '2',
    '--init', '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m',
    '--log-driver', 'json-file', '--log-opt', 'max-size=1m',
    '--label', `${LABEL}.workspace=${box.owner}`, '--label', `${LABEL}.session=${box.session}`, '--label', `${LABEL}.pid=${process.pid}`,
    '--label', `${LABEL}.boot=${bootMinute()}`,
    '--mount', `type=bind,source=${box.work},target=/work`,
    '--mount', `type=bind,source=${box.control},target=/control,readonly`,
    '--workdir', '/work', '--env', 'HOME=/tmp', '--env', 'MPLBACKEND=Agg', '--env', 'MPLCONFIGDIR=/tmp/matplotlib',
    '--env', 'PYTHONPATH=/opt/evoscholar/python', '--env', 'PYTHONDONTWRITEBYTECODE=1',
    '--env', 'PYTHONIOENCODING=utf-8', '--env', 'PYTHONUNBUFFERED=1', '--env', 'EVOSCHOLAR_CWD=/work',
    box.image, ...box.argv
  ]
}

function processIsAlive(pid: string) {
  if (!/^\d{1,10}$/.test(pid) || Number(pid) < 1) return false
  try { process.kill(Number(pid), 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

export class DockerExecutor implements ExecutionBackend {
  private readonly stages = new Map<string, SessionStage>()
  private readonly owner: string
  private cached?: { key: string; expires: number; result: Promise<ExecutionStatus> }
  constructor(private ws: Workspace, private engine: Engine) {
    const root = process.platform === 'win32' ? ws.root.toLowerCase() : ws.root
    this.owner = createHash('sha256').update(root).digest('hex').slice(0, 24)
  }

  private get binary() { return this.ws.settings.execution?.engine ?? 'docker' }
  private get image() { return this.ws.settings.execution?.image ?? DEFAULT_SANDBOX_IMAGE }

  private async linuxEngine(binary: string): Promise<boolean> {
    const info = await this.engine(binary, ['info', '--format', '{{.OSType}}'], PROBE_S, AbortSignal.timeout(PROBE_S * 1000 + 500))
    if (info.code === 0 && info.stdout.trim() === 'linux') return true
    if (!/^podman(?:\.exe)?$/i.test(binary)) return false
    const compat = await this.engine(binary, ['info', '--format', 'json'], PROBE_S, AbortSignal.timeout(PROBE_S * 1000 + 500))
    if (compat.code !== 0) return false
    try { return JSON.parse(compat.stdout).host?.os === 'linux' } catch { return false }
  }

  async available(): Promise<boolean> {
    return await this.status() === 'ready'
  }

  status(): Promise<ExecutionStatus> {
    const binary = this.binary, image = this.image
    const key = binary + '\0' + image
    if (this.cached?.key === key && this.cached.expires > Date.now()) return this.cached.result
    const result = (async (): Promise<ExecutionStatus> => {
      if (!await this.linuxEngine(binary)) return 'engine'
      const found = await this.engine(binary, ['image', 'inspect', '--format', '{{.Os}}', image], PROBE_S, AbortSignal.timeout(PROBE_S * 1000 + 500))
      return found.code === 0 && found.stdout.trim() === 'linux' ? 'ready' : 'image'
    })().catch((): ExecutionStatus => 'engine')
    this.cached = { key, result, expires: Date.now() + 2500 }
    return result
  }

  async recover(): Promise<void> {
    const binary = this.binary
    try {
      if (!await this.linuxEngine(binary)) return
      const list = await this.engine(binary, [
        'ps', '-a', '--filter', `label=${LABEL}.workspace=${this.owner}`,
        '--format', `{{.ID}} {{.Label "${LABEL}.pid"}} {{.Label "${LABEL}.boot"}}`
      ], 5, AbortSignal.timeout(5500))
      if (list.code !== 0) return
      for (const line of list.stdout.split(/\r?\n/)) {
        const [id, pid, boot] = line.trim().split(/\s+/)
        if (!/^[a-f0-9]{12,64}$/.test(id) || !pid) continue
        // After a reboot the recorded PID may belong to an unrelated process, so check the boot too.
        const earlierBoot = !boot || Math.abs(Number(boot) - bootMinute()) > 2
        if (earlierBoot || !processIsAlive(pid)) await this.remove(binary, id)
      }
    } catch { /* Runtime is optional. Later job requests check availability again. */ }
  }

  private remove(binary: string, name: string) {
    return this.engine(binary, ['rm', '-f', name], 8, AbortSignal.timeout(8500))
  }

  private session(env: ToolEnv) {
    const id = env.sessionId
    if (!id || !/^[\w-]{1,120}$/.test(id)) throw new Error('容器执行需要有效的会话 ID')
    return id
  }

  private stage(env: ToolEnv, isolated: boolean): SessionStage {
    const root = checkProjectRoot(env.cwd, this.ws.root, this.ws.dataDir)
    const id = this.session(env)
    const previous = isolated ? undefined : this.stages.get(id)
    if (previous) {
      if (previous.project.root !== root || previous.running) throw new Error('容器工作副本正在使用')
      return previous
    }
    const stage = stageDirectory()
    const next = { stage, project: new StagedProject(root, stage.work), running: false }
    if (!isolated) this.stages.set(id, next)
    return next
  }

  private async create(binary: string, name: string, env: ToolEnv, job: ExecutionJob, stage: Stage, signal: AbortSignal) {
    rmSync(stage.controls, { recursive: true, force: true })
    mkdirSync(stage.controls, { mode: 0o755 })
    if (job.code !== undefined) writeFileSync(join(stage.controls, 'cell.py'), job.code, { mode: 0o644, flag: 'w' })
    if (job.skillDir) copySkillResources(job.skillDir, join(stage.controls, 'skill'))
    const result = await this.engine(binary, dockerCreateArgs({
      name, owner: this.owner, session: this.session(env), image: this.image, work: stage.work, control: stage.controls, argv: job.sandbox
    }), 15, signal)
    if (result.code !== 0) throw new Error('无法创建 Linux 执行容器，请检查本地镜像和文件共享设置')
  }

  private publish(project: StagedProject, env: ToolEnv) {
    const paths = project.publish(this.session(env))
    if (paths.length) env.onFiles?.(paths)
  }

  async run(env: ToolEnv, job: ExecutionJob, timeout: number, signal: AbortSignal) {
    signal.throwIfAborted()
    const binary = this.binary, name = 'evo-' + randomUUID()
    const run = job.emptyWorkspace ? undefined : this.stage(env, false)
    const stage = run?.stage ?? stageDirectory()
    if (run) run.running = true
    let launched = false
    let keep = !!run
    try {
      const delivery = run?.project.planDelivery(job.deliverables)
      run?.project.sync()
      launched = true
      await this.create(binary, name, env, job, stage, signal)
      const result = await this.engine(binary, ['start', '--attach', name], timeout, signal)
      const removed = await this.remove(binary, name)
      if (removed.code !== 0) throw new Error('无法确认容器已停止，交付文件未回写')
      launched = false
      signal.throwIfAborted()
      if (result.timedOut) keep = false
      else if (run) result.files = run.project.publish(this.session(env), result.code === 0 ? delivery : undefined)
      return result
    } catch (error) {
      if (launched || signal.aborted) keep = false
      throw error
    } finally {
      if (launched) await this.remove(binary, name).catch(() => {})
      if (run) {
        run.running = false
        if (!keep) this.stages.delete(this.session(env))
      }
      if (!keep) stage.dispose()
    }
  }

  async start(env: ToolEnv, job: ExecutionJob, signal: AbortSignal): Promise<IsolatedService> {
    signal.throwIfAborted()
    const binary = this.binary, name = 'evo-' + randomUUID()
    const run = this.stage(env, true)
    let timer: NodeJS.Timeout | undefined
    let stopping: Promise<void> | undefined
    const stop = (publish: boolean) => stopping ??= (async () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      try {
        const result = await this.remove(binary, name)
        if (publish && result.code === 0) this.publish(run.project, env)
      } finally { run.stage.dispose() }
    })()
    const cancel = () => { void stop(false).catch(() => {}) }
    try {
      run.project.sync()
      await this.create(binary, name, env, job, run.stage, signal)
      const result = await this.engine(binary, ['start', name], 15, signal)
      if (result.code !== 0) throw new Error('无法启动后台容器')
      signal.throwIfAborted()
      signal.addEventListener('abort', cancel, { once: true })
      timer = setTimeout(cancel, 15 * 60_000)
      timer.unref()
    } catch (error) {
      await stop(false).catch(() => {})
      throw error
    }
    return {
      read: async (signal) => {
        if (stopping) return { running: false, text: '已停止', output: '' }
        const state = await this.engine(binary, ['inspect', '--format', '{{.State.Running}} {{.State.ExitCode}}', name], 5, signal)
        const [running, exit] = state.stdout.trim().split(/\s+/)
        const logs = await this.engine(binary, ['logs', '--tail', '300', name], 5, signal)
        return { running: running === 'true', text: running === 'true' ? '运行中' : `已退出（退出码 ${exit ?? '未知'}）`, output: logs.out }
      },
      get: async (port, path, timeout, signal) => {
        if (stopping) throw new Error('后台容器已停止')
        const result = await this.engine(binary, ['exec', name, 'python', '/opt/evoscholar/probe.py', String(port), path, String(timeout)], timeout + 1, signal)
        if (result.code !== 0) throw new Error('后台服务请求失败，或服务尚未就绪')
        const value: unknown = JSON.parse(result.stdout)
        if (!value || typeof value !== 'object' || !('status' in value) || typeof value.status !== 'number' ||
          !('body' in value) || typeof value.body !== 'string') throw new Error('后台服务探针返回无效结果')
        return { status: value.status, body: value.body }
      },
      stop: () => stop(true)
    }
  }

  async disposeSession(sessionId: string) {
    const run = this.stages.get(sessionId)
    if (run && !run.running) {
      this.stages.delete(sessionId)
      run.stage.dispose()
    }
  }
}
