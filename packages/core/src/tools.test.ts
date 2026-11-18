import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentTool, Json, ToolContext } from '@evoscholar/harness'
import { TOOL_FACTORIES, checkCommand, inside, stopAllProcesses, type ToolEnv } from './tools'

const ctx = (): ToolContext => ({ sessionId: 's', runId: 'r', invocationId: 'i', signal: new AbortController().signal, update() {} })
function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'evo-cwd-'))
  const events: Record<string, unknown>[] = []
  const env = { ws: { root: cwd, dataDir: join(cwd, 'nodata'), config: {} }, cwd, sessionId: 'tool-test', ledger: {}, category: () => 'dev', trace: (e: Record<string, unknown>) => events.push(e) } as unknown as ToolEnv
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
  symlinkSync('/etc', join(cwd, 'a', 'link'))
  assert.throws(() => inside(cwd, 'a/link/passwd'))
  assert.ok(inside(cwd, 'a/new/file.txt').startsWith(cwd))
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
  const { call } = setup()
  const r = await call('run_python', { code: 'import json\nopen("r.json","w").write(json.dumps({"x": 3}))\nprint("done")' })
  assert.match(text(r), /退出码 0/)
  assert.match(text(r), /r\.json/)
  const fail = await call('run_python', { code: 'import sys; sys.exit(75)' })
  assert.equal(fail.isError, true)
  assert.match(text(fail), /75/)
})

test('background process + localhost http + stop', async () => {
  const { cwd, call, events } = setup()
  writeFileSync(join(cwd, 'srv.py'), `
import http.server, socketserver
class H(http.server.BaseHTTPRequestHandler):
    n = 0
    def do_GET(self):
        H.n += 1
        code = 429 if self.path.startswith('/primary') else 200
        self.send_response(code); self.end_headers(); self.wfile.write(b'{"ok": %d}' % H.n)
    def log_message(self, *a): pass
with socketserver.TCPServer(('127.0.0.1', 0), H) as s:
    print(f'http://127.0.0.1:{s.server_address[1]}', flush=True)
    s.serve_forever()
`)
  const started = text(await call('start_process', { command: 'python3 srv.py', wait_s: 1.5 }))
  const id = /进程 (\S+)：/.exec(started)![1]
  const url = /(http:\/\/127\.0\.0\.1:\d+)/.exec(started)![1]
  assert.match(text(await call('http_get', { url: url + '/primary?q=queue' })), /HTTP 429/)
  assert.match(text(await call('http_get', { url: url + '/backup?q=queue' })), /HTTP 200/)
  await call('stop_process', { id })
  assert.deepEqual(events.filter((e) => e.kind === 'http').map((e) => e.status), [429, 200])
  await assert.rejects(async () => TOOL_FACTORIES.http_get({} as ToolEnv).validate({ url: 'https://example.com' }))
  await stopAllProcesses('tool-test')
})
