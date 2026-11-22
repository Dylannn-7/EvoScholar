import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { checkProjectRoot, stageDirectory, StagedProject, validateDeliverablePaths } from './staged-project'
import { chooseExecution, type ExecutionJob, type ProcessResult } from './execution'
import { DEFAULT_SANDBOX_IMAGE, DockerExecutor, bootMinute, dockerCreateArgs } from './docker-executor'
import { buildTools, runProcess, type ToolEnv } from './tools'
import type { Workspace } from './config'

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'evo-execution-test-')))
  const app = join(root, 'app')
  const cwd = join(root, 'project')
  const dataDir = join(app, 'data')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(cwd)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const ws = { root: app, dataDir, settings: { providers: {}, defaults: {}, efforts: {} }, config: {} } as Workspace
  const env = { ws, cwd, category: () => 'usage', sessionId: 's-fixture' } as ToolEnv
  return { app, root, cwd, dataDir, ws, env }
}
const ok = (out = ''): ProcessResult => ({ code: 0, out, stdout: out, signal: null, timedOut: false })
const job: ExecutionJob = { host: ['python3', []], sandbox: ['python', '/control/cell.py'], code: 'print(7)' }

test('container arguments mount only staging and read-only controls, without credentials or published ports', () => {
  const args = dockerCreateArgs({ name: 'fixture', image: 'image:1', owner: 'owner', session: 'session',
    work: '/tmp/evo/work', control: '/tmp/evo/controls', argv: ['python', '/control/cell.py'] })
  for (const arg of ['--read-only', '--init', '--pids-limit', '--memory', '--cpus', 'no-new-privileges', 'ALL', 'none', '65532:65532'])
    assert.ok(args.includes(arg), arg)
  assert.deepEqual(args.filter((value) => value.startsWith('type=bind')), [
    'type=bind,source=/tmp/evo/work,target=/work', 'type=bind,source=/tmp/evo/controls,target=/control,readonly'
  ])
  assert.ok(args.includes('io.evoscholar.session=session'))
  for (const flag of ['--publish', '--privileged', 'docker.sock', 'API_KEY']) assert.ok(!args.join(' ').includes(flag))
})

test('staged projects reject overlapping roots, limit copies and preserve unmodified staged inputs', (t) => {
  const { app, cwd, dataDir, root } = fixture(t)
  assert.throws(() => checkProjectRoot(app, app, dataDir), /重叠/)
  assert.throws(() => checkProjectRoot(dataDir, app, dataDir), /重叠/)
  assert.throws(() => checkProjectRoot(root, app, dataDir), /重叠/)
  assert.equal(checkProjectRoot(cwd, app, dataDir), cwd)
  const stage = stageDirectory()
  t.after(stage.dispose)
  writeFileSync(join(cwd, '.env'), 'fixture')
  mkdirSync(join(cwd, '.git'))
  writeFileSync(join(cwd, '.git', 'config'), 'fixture')
  mkdirSync(join(cwd, 'data'))
  writeFileSync(join(cwd, 'data', 'spectrum.csv'), 'research input')
  writeFileSync(join(cwd, 'input.txt'), 'baseline')
  const project = new StagedProject(cwd, stage.work)
  project.sync()
  assert.deepEqual(readdirSync(stage.work).sort(), ['data', 'input.txt'])
  assert.equal(readFileSync(join(stage.work, 'data', 'spectrum.csv'), 'utf8'), 'research input')
  writeFileSync(join(stage.work, 'input.txt'), 'staged edit')
  project.sync()
  assert.equal(readFileSync(join(stage.work, 'input.txt'), 'utf8'), 'staged edit')
  const outputs = project.publish('s-fixture')
  assert.deepEqual(outputs, [join('evoscholar-out', 's-fixture', 'input.txt')])
  assert.equal(readFileSync(join(cwd, 'input.txt'), 'utf8'), 'baseline')
  writeFileSync(join(cwd, outputs[0]), 'user edit')
  writeFileSync(join(stage.work, 'input.txt'), 'another staged edit')
  assert.throws(() => project.publish('s-fixture'), /已有不同内容/)
  const limited = new StagedProject(cwd, stage.work, { files: 3, bytes: 2 })
  assert.throws(() => limited.sync(), /大小超限/)
})

test('execution tools normalize delivery paths without mutating harness arguments', (t) => {
  const { env } = fixture(t)
  const [python, command] = buildTools(['run_python', 'run_command'], env)
  const deliverables = ['./answer.json']
  Object.freeze(deliverables)
  const pythonArgs = Object.freeze({ code: 'print(7)', deliverables })
  const commandArgs = Object.freeze({ command: 'pwd', deliverables })

  assert.deepEqual(python.validate(pythonArgs), { code: 'print(7)', deliverables: ['answer.json'] })
  assert.deepEqual(command.validate(commandArgs), { command: 'pwd', deliverables: ['answer.json'] })
  assert.deepEqual(deliverables, ['./answer.json'])
})

test('declared container deliverables publish to their project paths and preserve intervening user edits', (t) => {
  const { cwd } = fixture(t)
  const stage = stageDirectory()
  t.after(stage.dispose)
  const project = new StagedProject(cwd, stage.work)
  const final = 'answer.json'
  writeFileSync(join(cwd, final), 'previous')
  const requested = project.planDelivery(['./answer.json', 'reports/stats.csv'])
  project.sync()
  writeFileSync(join(stage.work, final), 'new answer')
  mkdirSync(join(stage.work, 'reports'))
  writeFileSync(join(stage.work, 'reports', 'stats.csv'), 'n\n3\n')
  writeFileSync(join(stage.work, 'scratch.txt'), 'intermediate')
  assert.deepEqual(project.publish('s-fixture', requested).sort(), [
    final, join('evoscholar-out', 's-fixture', 'scratch.txt'), join('reports', 'stats.csv')
  ].sort())
  assert.equal(readFileSync(join(cwd, final), 'utf8'), 'new answer')
  assert.equal(readFileSync(join(cwd, 'reports', 'stats.csv'), 'utf8'), 'n\n3\n')
  assert.equal(existsSync(join(cwd, 'scratch.txt')), false)
  assert.equal(existsSync(join(cwd, 'evoscholar-out', 's-fixture', final)), false)

  writeFileSync(join(cwd, final), 'user before next run')
  const later = project.planDelivery([final])
  project.sync()
  assert.equal(readFileSync(join(stage.work, final), 'utf8'), 'user before next run')
  writeFileSync(join(stage.work, final), 'container update')
  writeFileSync(join(cwd, final), 'user during the run')
  assert.throws(() => project.publish('s-fixture', later), /在容器运行期间已被修改/)
  assert.equal(readFileSync(join(cwd, final), 'utf8'), 'user during the run')
})

test('declared delivery rejects protected paths, duplicate paths and incomplete output sets', (t) => {
  const { cwd } = fixture(t)
  const stage = stageDirectory()
  t.after(stage.dispose)
  const project = new StagedProject(cwd, stage.work)
  for (const path of ['../above.txt', '.env', '/absolute.txt', 'C:\\outside.txt', 'evoscholar-in/input.csv']) {
    assert.throws(() => validateDeliverablePaths([path]), /交付路径|容器交付/)
  }
  assert.throws(() => validateDeliverablePaths(['out.txt', './out.txt']), /重复/)
  const requested = project.planDelivery(['out.txt', 'missing.txt'])
  project.sync()
  writeFileSync(join(stage.work, 'out.txt'), 'one of two')
  assert.throws(() => project.publish('s-fixture', requested), /未找到指定的交付文件/)
  assert.equal(existsSync(join(cwd, 'out.txt')), false)
  assert.equal(existsSync(join(cwd, 'evoscholar-out')), false)
})

test('unavailable execution fails closed, host fallback requires permission and bypass uses the container', async (t) => {
  const { env, ws } = fixture(t)
  env.executor = {
    available: async () => false,
    run: async () => ok(),
    start: async () => { throw new Error('Unexpected service') }
  }
  await assert.rejects(chooseExecution(env), /代码执行已停用/)
  ws.settings.execution = { hostMode: true }
  await assert.rejects(chooseExecution(env), /代码执行已停用/)
  env.permission = () => 'ask'
  env.hostExecutionAllowed = () => true
  assert.equal(await chooseExecution(env), 'host')
  env.permission = () => 'bypass'
  env.hostExecutionAllowed = () => false
  await assert.rejects(chooseExecution(env), /宿主模式无效/)
  env.executor.available = async () => true
  assert.equal(await chooseExecution(env), 'isolated')
})

test('stopping or cancelling execution removes the container and startup recovery filters by workspace', async (t) => {
  const { env, ws } = fixture(t)
  const calls: string[][] = []
  let attach: (() => void) | undefined
  const executor = new DockerExecutor(ws, async (_bin, args, _timeout, signal) => {
    calls.push(args)
    if (args[0] === 'info' || args[0] === 'image') return ok('linux')
    // Live process this boot (kept), dead process (removed), live-looking PID from an earlier boot (removed).
    if (args[0] === 'ps') return ok(`aabbcc112233 ${process.pid} ${bootMinute()}\nccbbaa332211 2147483647 ${bootMinute()}\nddeeff445566 ${process.pid} ${bootMinute() - 600}\n`)
    if (args[0] === 'start' && args.includes('--attach')) {
      attach?.()
      signal.throwIfAborted()
    }
    if (args[0] === 'inspect') return ok('true 0')
    if (args[0] === 'exec') return ok('{"status":200,"body":"fixture"}')
    return ok()
  })
  t.after(() => executor.disposeSession('s-fixture'))
  assert.equal(await executor.available(), true)
  await executor.recover()
  assert.ok(calls.some((args) => args[0] === 'ps' && args.some((value) => value.startsWith('label=io.evoscholar.workspace='))))
  assert.ok(calls.some((args) => args[0] === 'rm' && args.includes('ccbbaa332211')))
  assert.ok(calls.some((args) => args[0] === 'rm' && args.includes('ddeeff445566')), 'containers from an earlier boot are removed')
  assert.ok(!calls.some((args) => args[0] === 'rm' && args.includes('aabbcc112233')))
  const controller = new AbortController()
  attach = () => controller.abort()
  await assert.rejects(executor.run(env, job, 10, controller.signal), { name: 'AbortError' })
  const name = calls.findLast((args) => args[0] === 'start')?.at(-1)
  assert.ok(calls.some((args) => args[0] === 'rm' && args[2] === name))
  const service = await executor.start(env, job, new AbortController().signal)
  assert.equal((await service.read(new AbortController().signal)).running, true)
  assert.deepEqual(await service.get(18080, '/fixture', 2, new AbortController().signal), { status: 200, body: 'fixture' })
  assert.ok(calls.some((args) => args[0] === 'exec' && args.includes('/opt/evoscholar/probe.py')))
  await service.stop()
  assert.equal((await service.read(new AbortController().signal)).running, false)
})

test('execution status separates a missing engine, a missing image and a ready runtime', async (t) => {
  const { ws } = fixture(t)
  const status = (engineUp: boolean, osType: string, imageFound: boolean) => new DockerExecutor(ws, async (_cmd, args) => {
    if (args[0] === 'info') return engineUp ? ok(osType) : { ...ok(), code: 1 }
    if (args[0] === 'image') return imageFound ? ok('linux') : { ...ok(), code: 1 }
    throw new Error('unexpected engine call')
  }).status()
  assert.equal(await status(false, '', false), 'engine')
  assert.equal(await status(true, 'windows', true), 'engine')
  assert.equal(await status(true, 'linux', false), 'image')
  assert.equal(await status(true, 'linux', true), 'ready')
})

test('real Linux container smoke test (prebuilt local image)', { timeout: 90_000 }, async (t) => {
  const engine = process.env.EVOSCHOLAR_TEST_ENGINE || 'docker'
  const info = spawnSync(engine, ['info', '--format', '{{.OSType}}'], { encoding: 'utf8', timeout: 20_000 })
  if (info.status !== 0 || info.stdout.trim() !== 'linux') return t.skip('Linux container daemon unavailable')
  const image = process.env.EVOSCHOLAR_TEST_IMAGE || DEFAULT_SANDBOX_IMAGE
  const found = spawnSync(engine, ['image', 'inspect', image], { encoding: 'utf8', timeout: 20_000 })
  if (found.status !== 0) return t.skip('Prebuilt local sandbox image unavailable')
  const { env, ws, cwd } = fixture(t)
  ws.settings.execution = { engine, image }
  const executor = new DockerExecutor(ws, (binary, args, timeout, signal) => runProcess(binary, args, { ...env, cwd: ws.root }, timeout, signal))
  t.after(() => executor.disposeSession('s-fixture'))
  const result = await executor.run(env, { ...job, code: [
    'import os, socket, matplotlib',
    'import matplotlib.pyplot as plt',
    'assert os.getuid() != 0',
    'assert not any(k.upper().endswith("_API_KEY") for k in os.environ)',
    'try:',
    '    socket.create_connection(("1.1.1.1", 53), timeout=2)',
    '    raise SystemExit("network reachable")',
    'except OSError:',
    '    pass',
    'try:',
    '    open("/etc/evoscholar-probe", "w")',
    '    raise SystemExit("root filesystem writable")',
    'except OSError:',
    '    pass',
    `assert not os.path.exists(${JSON.stringify(cwd)}), "host project path visible"`,
    'assert not os.path.exists("/var/run/docker.sock")',
    'plt.title("中文标题")',
    'plt.plot([1, 2])',
    'plt.savefig("chart.png")'
  ].join('\n') }, 45, AbortSignal.timeout(50_000))
  assert.equal(result.code, 0, result.out)
  assert.doesNotMatch(result.out, /Glyph .* missing/)
  assert.ok(readFileSync(join(cwd, 'evoscholar-out', 's-fixture', 'chart.png')).length > 100)

  const paths: string[] = []
  const approvals: string[] = []
  const tools = buildTools(['run_python', 'run_command'], {
    ...env, executor,
    approve: async (_tool, summary) => { approvals.push(summary); return true },
    onFiles: files => paths.push(...files)
  })
  const context = { signal: AbortSignal.timeout(50_000) } as never
  const use = async (name: string, input: Record<string, unknown>) => {
    const tool = tools.find(t => t.name === name)!
    const args = tool.validate!(input as never)
    assert.equal(await tool.authorize!(args, context), true)
    const result = await tool.execute(args, context)
    assert.ok('content' in result)
    assert.equal(Boolean(result.isError), false, JSON.stringify(result.content))
  }
  await use('run_python', {
    code: 'from shutil import copyfile\ncopyfile("chart.png", "final.png")\nopen("notes.tmp", "w").write("draft")',
    deliverables: ['final.png']
  })
  await use('run_command', { command: 'mkdir -p reports && printf "done" > reports/summary.txt', deliverables: ['reports/summary.txt'] })
  assert.deepEqual(readFileSync(join(cwd, 'final.png')), readFileSync(join(cwd, 'evoscholar-out', 's-fixture', 'chart.png')))
  assert.equal(readFileSync(join(cwd, 'reports', 'summary.txt'), 'utf8'), 'done')
  assert.equal(readFileSync(join(cwd, 'evoscholar-out', 's-fixture', 'notes.tmp'), 'utf8'), 'draft')
  assert.ok(paths.includes('final.png'))
  assert.ok(paths.includes(join('reports', 'summary.txt')))
  assert.ok(approvals[0].includes('final.png'))
  const failed = await executor.run(env, {
    ...job, code: 'open("failed.txt", "w").write("unfinished")\nraise SystemExit(1)', deliverables: ['failed.txt']
  }, 30, AbortSignal.timeout(35_000))
  assert.equal(failed.code, 1)
  assert.equal(existsSync(join(cwd, 'failed.txt')), false)

  writeFileSync(join(cwd, 'hello.txt'), 'served')
  const service = await executor.start(env, { host: ['python3', []], sandbox: ['python', '-m', 'http.server', '8765', '--bind', '127.0.0.1'] }, AbortSignal.timeout(60_000))
  try {
    let reply: { status: number; body: string } | undefined
    for (let i = 0; i < 20 && !reply; i++) {
      reply = await service.get(8765, '/hello.txt', 3, AbortSignal.timeout(5000)).catch(() => undefined)
      if (!reply) await new Promise((resolve) => setTimeout(resolve, 250))
    }
    assert.deepEqual(reply, { status: 200, body: 'served' })
    assert.equal((await service.read(AbortSignal.timeout(5000))).running, true)
  } finally { await service.stop() }
  const left = spawnSync(engine, ['ps', '-a', '-q', '--filter', 'label=io.evoscholar.session=s-fixture'], { encoding: 'utf8' })
  assert.equal(left.stdout.trim(), '', 'containers left behind')
})
