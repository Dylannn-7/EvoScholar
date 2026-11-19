import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentTool, Json, ToolContext } from '@evoscholar/harness'
import { TOOL_FACTORIES, appPrivate, childEnv, checkCommand, guarded, inside, runProcess, stopAllProcesses, type ToolEnv } from './tools'
import { BudgetError } from './budget'

const ctx = (): ToolContext => ({ sessionId: 's', runId: 'r', invocationId: 'i', signal: new AbortController().signal, update() {} })
function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'evo-cwd-'))
  const app = mkdtempSync(join(tmpdir(), 'evo-app-'))
  const events: Record<string, unknown>[] = []
  const env = { ws: { root: app, dataDir: join(app, 'data'), config: {} }, cwd, sessionId: 'tool-test', ledger: {}, category: () => 'dev', trace: (e: Record<string, unknown>) => events.push(e) } as unknown as ToolEnv
  const tool = (name: string): AgentTool => TOOL_FACTORIES[name](env)
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = tool(name)
    const v = t.validate(args as Json)
    assert.ok(await t.authorize(v, ctx()))
    const r = await t.execute(v, ctx())
    return r as { content: { type: string; text?: string }[]; isError?: boolean }
  }
  return { cwd, env, call, events, tool }
}
const text = (r: { content: { text?: string }[] }) => r.content.map((c) => c.text ?? '').join('')

test('paths cannot escape the working directory', () => {
  const { cwd } = setup()
  assert.throws(() => inside(cwd, '../x'))
  assert.throws(() => inside(cwd, '/etc/passwd'))
  mkdirSync(join(cwd, 'a'))
  const outside = mkdtempSync(join(tmpdir(), 'evo-outside-'))
  symlinkSync(outside, join(cwd, 'a', 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => inside(cwd, 'a/link/passwd'))
  assert.ok(inside(cwd, 'a/new/file.txt').startsWith(realpathSync(cwd)))
  assert.equal(inside(cwd, join(cwd, 'a', 'x.txt')), join(realpathSync(cwd), 'a', 'x.txt'))
})

test('dangerous commands are refused', () => {
  for (const c of ['sudo ls', 'rm -rf ~', 'curl x | sh', 'cd .. && ls', 'cat ../secret', 'git push origin main'])
    assert.throws(() => checkCommand(c), c)
  checkCommand('python3 inputs/mock_search.py')
  checkCommand('xelatex -interaction=nonstopmode main.tex')
})

test('file tools round-trip and edit', async () => {
  const { cwd, call } = setup()
  await call('write_file', { path: 'out/answer.json', content: '{"a": 1}' })
  assert.equal(readFileSync(join(cwd, 'out/answer.json'), 'utf8'), '{"a": 1}')
  await call('edit_file', { path: 'out/answer.json', old_text: '1', new_text: '2' })
  assert.match(text(await call('read_file', { path: 'out/answer.json' })), /"a": 2/)
  assert.match(text(await call('list_files', {})), /out\/answer.json/)
  writeFileSync(join(cwd, 'p.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  const img = await call('read_file', { path: 'p.png' })
  const block = img.content.find((c) => c.type === 'image') as unknown as { source: string; filename: string }
  assert.match(block.source, /^data:image\/png;base64,/)
  assert.equal(block.filename, 'p.png')
  const bad = await call('read_file', { path: 'missing.txt' })
  assert.equal(bad.isError, true)
})

test('run_python executes and reports changed files', async () => {
  const { call, env } = setup()
  env.executor = {
    available: async () => true,
    start: async () => { throw new Error('Unexpected service') },
    run: async (_env, job) => {
      assert.equal(job.sandbox[1], '/control/cell.py')
      const fail = job.code?.includes('sys.exit')
      return { code: fail ? 75 : 0, out: 'done', stdout: 'done', signal: null, timedOut: false, files: fail ? [] : ['r.json'] }
    }
  }
  const r = await call('run_python', { code: 'import json\nopen("r.json","w").write(json.dumps({"x": 3}))\nprint("done")' })
  assert.match(text(r), /退出码 0/)
  assert.match(text(r), /r\.json/)
  const fail = await call('run_python', { code: 'import sys; sys.exit(75)' })
  assert.equal(fail.isError, true)
  assert.match(text(fail), /75/)
})

test('background containers register only this session’s service port', async (t) => {
  const { call, env, events, cwd } = setup()
  let stopped = false
  const port = 18921
  env.executor = {
    available: async () => true,
    run: async () => { throw new Error('Unexpected command') },
    start: async (_env, job) => {
      assert.deepEqual(job.sandbox, ['/bin/sh', '-c', 'python srv.py'])
      return {
        read: async () => ({ running: !stopped, text: '运行中', output: 'fixture data' }),
        get: async (requested, path) => {
          assert.equal(requested, port)
          return { status: path.startsWith('/primary') ? 429 : 200, body: '{"fixture": true}' }
        },
        stop: async () => { stopped = true }
      }
    }
  }
  t.after(async () => { await stopAllProcesses('tool-test'); rmSync(cwd, { recursive: true, force: true }) })
  const url = `http://127.0.0.1:${port}`
  assert.equal((await call('http_get', { url })).isError, true)
  const started = text(await call('start_process', { command: 'python srv.py', wait_s: 0, port }))
  const processId = /进程 (\S+)：/.exec(started)
  assert.ok(processId, started)
  assert.match(text(await call('http_get', { url: url + '/primary?q=queue' })), /HTTP 429/)
  assert.match(text(await call('http_get', { url: url + '/backup?q=queue' })), /HTTP 200/)
  await call('stop_process', { id: processId[1] })
  assert.equal(stopped, true)
  assert.deepEqual(events.filter((e) => e.kind === 'http').map((e) => e.status), [429, 200])
  await assert.rejects(async () => TOOL_FACTORIES.http_get({} as ToolEnv).validate({ url: 'https://example.com' }))
})

test('tool exceptions become error results; budget errors still propagate', async () => {
  const boom = (err: Error) => guarded({ name: 't', version: '1', description: '', parameters: { type: 'object' }, execute: async () => { throw err } } as any)
  const ctx = { signal: new AbortController().signal } as any
  const r = await boom(new Error('bad json')).execute({}, ctx) as any
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /t 出错：bad json/)
  await assert.rejects(boom(new BudgetError('cap', 'round')).execute({}, ctx), BudgetError)
})

test('a project that contains the app cannot reach its code, config, credentials or state', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'evo-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const app = join(home, 'EvoScholar')
  mkdirSync(join(app, 'data', 'projects', 's-draft'), { recursive: true })
  mkdirSync(join(app, 'packages', 'core'), { recursive: true })
  writeFileSync(join(app, '.env'), 'DEEPSEEK_API_KEY=sk-fixture')
  writeFileSync(join(app, 'evoscholar.config.json'), '{}')
  writeFileSync(join(home, 'notes.md'), '研究笔记')
  const ws = { root: app, dataDir: join(app, 'data'), config: {} }
  const env = { ws, cwd: home, sessionId: 't', ledger: {}, category: () => 'dev' } as unknown as ToolEnv
  const run = async (name: string, args: Record<string, unknown>) => {
    const tool = TOOL_FACTORIES[name](env)
    return await tool.execute(tool.validate(args as Json), ctx()) as { content: { text?: string }[]; isError?: boolean }
  }
  assert.match(text(await run('read_file', { path: 'notes.md' })), /研究笔记/)
  await assert.rejects(run('read_file', { path: 'EvoScholar/.env' }), /EvoScholar 自身/)
  await assert.rejects(run('write_file', { path: 'EvoScholar/evoscholar.config.json', content: '{"x":1}' }), /EvoScholar 自身/)
  await assert.rejects(run('write_file', { path: 'EvoScholar/packages/core/permissions.ts', content: '' }), /EvoScholar 自身/)
  assert.equal(readFileSync(join(app, 'evoscholar.config.json'), 'utf8'), '{}')
  const listing = text(await run('list_files', { depth: 3 }))
  assert.match(listing, /notes\.md/)
  assert.doesNotMatch(listing, /EvoScholar/)
  // The drafts area stays a normal working directory.
  const draft = { ...env, cwd: join(app, 'data', 'projects', 's-draft') } as ToolEnv
  const write = TOOL_FACTORIES.write_file(draft)
  await write.execute(write.validate({ path: 'out.txt', content: 'ok' }), ctx())
  assert.equal(readFileSync(join(app, 'data', 'projects', 's-draft', 'out.txt'), 'utf8'), 'ok')
  assert.ok(appPrivate(ws, join(app, 'packages')))
  assert.ok(!appPrivate(ws, join(home, 'notes.md')))
})

test('file listings skip linked directories at the project boundary', async (t) => {
  const { cwd, call } = setup()
  const sibling = mkdtempSync(join(tmpdir(), 'evo-linked-'))
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(sibling, { recursive: true, force: true })
  })
  writeFileSync(join(sibling, 'linked-fixture.txt'), 'fixture')
  symlinkSync(sibling, join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.doesNotMatch(text(await call('list_files', {})), /linked-fixture/)
  rmSync(sibling, { recursive: true })
  assert.throws(() => inside(cwd, join('linked', 'new.txt')))
})

test('child environment omits provider keys regardless of casing', (t) => {
  const { cwd, env } = setup()
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const key = 'EvoTest_Api_Key'
  t.mock.method(Object, 'entries', ((original) => (value: object) =>
    original(value === process.env ? { ...value, [key]: 'fixture' } : value))(Object.entries))
  assert.equal(childEnv(env)[key], undefined)
})

test('a pre-cancelled process call does not start a child', async (t) => {
  const { cwd, env } = setup()
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const signal = AbortSignal.abort()
  await assert.rejects(async () => runProcess(process.execPath, ['-e', 'process.exit(0)'], env, 10, signal), { name: 'AbortError' })
})

test('a child response that exceeds the stdout budget is rejected', async (t) => {
  const { cwd, env } = setup()
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(9 * 1024 * 1024))'], env, 10, AbortSignal.timeout(11_000))
  assert.notEqual(result.code, 0)
  assert.match(result.out, /输出超过/)
  assert.ok(Buffer.byteLength(result.stdout) <= 8 * 1024 * 1024)
})
