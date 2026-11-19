import { test } from 'node:test'
import { checkGatewayIp } from './gateway'

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ModelEvent } from '@evoscholar/harness'
import {
  addProject, createGeminiModel, createModel, endpointFor, indexFiles, listDirs, listLibrary, listProviders, modelFor,
  openRuntime, openWorkspace, parseModelList, permissionGate, projectFiles, providerInfo, saveSettings, setDeliverable,
  shellFor, fetchProviderModels, testProviderConnection, usageBy, usageTotals, type EvoConfig, type HarnessGenome
} from './index'

const REPO = resolve(__dirname, '../../..')

function tempWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'evo-v2-'))
  cpSync(join(REPO, 'evoscholar.config.json'), join(dir, 'evoscholar.config.json'))
  cpSync(join(REPO, 'genomes'), join(dir, 'genomes'), { recursive: true })
  cpSync(join(REPO, 'prompts'), join(dir, 'prompts'), { recursive: true })
  cpSync(join(REPO, 'skills'), join(dir, 'skills'), { recursive: true })
  mkdirSync(join(dir, 'data'))
  return dir
}

const sse = (events: unknown[], done = false) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''), { headers: { 'content-type': 'text/event-stream' } })

async function drain(it: AsyncIterable<ModelEvent>) {
  const out: ModelEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

test('provider endpoints follow protocol, editable base URL, region and auth style', () => {
  const dir = tempWorkspace()
  try {
    const ws = openWorkspace(dir)
    assert.equal(endpointFor(ws.config, 'deepseek').url, 'https://api.deepseek.com/v1/chat/completions')
    assert.equal(endpointFor(ws.config, 'deepseek', 'messages').url, 'https://api.deepseek.com/anthropic/v1/messages')
    assert.equal(endpointFor(ws.config, 'openai').url, 'https://api.openai.com/v1/responses')
    assert.equal(endpointFor(ws.config, 'anthropic').url, 'https://api.anthropic.com/v1/messages')
    assert.equal(endpointFor(ws.config, 'gemini').url, 'https://generativelanguage.googleapis.com/v1beta')
    const gem = providerInfo(ws.config, 'gemini')!
    assert.equal(gem.defaultProtocol, 'gemini')
    assert.equal(gem.authHeader, 'x-goog-api-key')
    assert.throws(() => endpointFor(ws.config, 'azure'), /Base URL/)

    ws.settings.providers.deepseek = { protocol: 'messages' }
    ws.settings.providers.zhipu = { region: 'china' }
    ws.settings.providers.kimi = { baseUrl: 'https://proxy.example.com/v1' }
    ws.settings.providers.mygw = { custom: true, label: 'My GW', protocol: 'chat-completions', baseUrl: 'http://localhost:9000/v1', models: [{ id: 'm1' }] }
    saveSettings(ws)
    const ws2 = openWorkspace(dir)
    assert.equal(endpointFor(ws2.config, 'deepseek').url, 'https://api.deepseek.com/anthropic/v1/messages')
    assert.equal(endpointFor(ws2.config, 'zhipu').url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions')
    assert.equal(endpointFor(ws2.config, 'kimi').url, 'https://proxy.example.com/v1/chat/completions')
    const custom = listProviders(ws2.config).find((p) => p.id === 'mygw')!
    assert.equal(custom.custom, true)
    assert.equal(endpointFor(ws2.config, 'mygw').url, 'http://localhost:9000/v1/chat/completions')
    assert.deepEqual(providerInfo(ws2.config, 'deepseek')!.official.sort(), ['chat-completions', 'messages'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Azure-style api-key header replaces Bearer; connection test reads the reply', async () => {
  const dir = tempWorkspace()
  const old = process.env.AZURE_API_KEY
  try {
    process.env.AZURE_API_KEY = 'az-key'
    const ws = openWorkspace(dir)
    ws.settings.providers.azure = { baseUrl: 'https://res.openai.azure.com/openai/v1', gatewayApproval: { base: 'https://res.openai.azure.com/openai/v1', privateAccess: false }, credentialOrigin: 'https://res.openai.azure.com', models: [{ id: 'gpt-dep' }] }
    saveSettings(ws)
    let seen: { url: string; headers: Headers; body: Record<string, unknown> } | undefined
    const fetchMock = (async (url: string, init: RequestInit) => {
      seen = { url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) }
      return sse([{ choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 9, completion_tokens: 1 } }], true)
    }) as unknown as typeof fetch
    const r = await testProviderConnection(ws.config, 'azure/gpt-dep', { fetch: fetchMock })
    assert.ok(r.ok, JSON.stringify(r))
    assert.equal(r.ok && r.text, 'OK')
    assert.equal(seen!.url, 'https://res.openai.azure.com/openai/v1/chat/completions')
    assert.equal(seen!.headers.get('api-key'), 'az-key')
    assert.equal(seen!.headers.get('authorization'), null)
    assert.equal(seen!.body.model, 'gpt-dep')
  } finally {
    if (old === undefined) delete process.env.AZURE_API_KEY
    else process.env.AZURE_API_KEY = old
    rmSync(dir, { recursive: true, force: true })
  }
})

test('model lists parse OpenAI-style and Gemini-style responses with raw ids', () => {
  const oa = parseModelList({ data: [{ id: 'gpt-x', context_window: 1000, supported_reasoning_efforts: ['minimal', 'high'] }, { id: 'gpt-x' }] }, 'chat-completions')
  assert.deepEqual(oa, [{ id: 'gpt-x', contextWindow: 1000, reasoningEffort: { supported: true, values: ['minimal', 'high'] } }])
  const gm = parseModelList({ models: [
    { name: 'models/gemini-3-pro-preview', inputTokenLimit: 1048576, outputTokenLimit: 65536, thinking: true, supportedGenerationMethods: ['generateContent'] },
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }
  ] }, 'gemini')
  assert.equal(gm.length, 1)
  assert.equal(gm[0].id, 'gemini-3-pro-preview')
  assert.equal(gm[0].contextWindow, 1048576)
  assert.equal(gm[0].maxOutputTokens, 65536)
})

test('Gemini adapter streams thoughts, text and function calls, and replays thought signatures', async () => {
  const bodies: Record<string, any>[] = []
  const urls: string[] = []
  const fetchMock = (async (url: string, init: RequestInit) => {
    urls.push(url)
    assert.equal(new Headers(init.headers).get('x-goog-api-key'), 'g-key')
    bodies.push(JSON.parse(String(init.body)))
    return sse([
      { candidates: [{ content: { parts: [{ text: '先看文件', thought: true }] } }] },
      { candidates: [{ content: { parts: [{ functionCall: { name: 'list_files', args: { path: '.' } }, thoughtSignature: 'SIG1' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5, thoughtsTokenCount: 7, cachedContentTokenCount: 40 } }
    ])
  }) as unknown as typeof fetch
  const model = createGeminiModel({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3-pro-preview', apiKey: () => 'g-key', fetch: fetchMock, parameters: { thinkingConfig: { thinkingLevel: 'high' } } })
  const req = {
    requestId: 'r1', instructions: 'sys', maxOutputTokens: 1000,
    tools: [{ name: 'list_files', version: '1', description: 'ls', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    messages: [{ id: 'u1', role: 'user' as const, content: [{ type: 'text' as const, text: '列一下' }] }]
  }
  const ev = await drain(model.stream(req, new AbortController().signal))
  assert.ok(urls[0].endsWith('/models/gemini-3-pro-preview:streamGenerateContent?alt=sse'))
  assert.equal(bodies[0].generationConfig.thinkingConfig.thinkingLevel, 'high')
  assert.equal(bodies[0].generationConfig.thinkingConfig.includeThoughts, true)
  assert.equal(bodies[0].tools[0].functionDeclarations[0].name, 'list_files')
  assert.ok(ev.some((e) => e.type === 'reasoning-delta' && e.text === '先看文件'))
  const fin = ev.at(-1) as Extract<ModelEvent, { type: 'finish' }>
  assert.equal(fin.reason, 'tools')
  assert.equal(fin.calls![0].name, 'list_files')
  assert.deepEqual(fin.usage, { inputTokens: 100, outputTokens: 12, cacheReadTokens: 40 })

  // Next request: the assistant turn replays its signature; the tool result becomes a functionResponse.
  const callId = fin.calls![0].id
  await drain(model.stream({
    ...req,
    requestId: 'r2',
    messages: [
      ...req.messages,
      { id: 'a1', role: 'assistant', content: [], calls: fin.calls, providerState: { adapterId: model.id, value: fin.providerState! } },
      { id: 't1', role: 'tool', invocationId: `a1/${callId}`, content: [{ type: 'text', text: 'a.csv' }] }
    ]
  }, new AbortController().signal))
  const contents = bodies[1].contents
  assert.deepEqual(contents.map((c: { role: string }) => c.role), ['user', 'model', 'user'])
  assert.equal(contents[1].parts[0].thoughtSignature, 'SIG1')
  assert.deepEqual(contents[2].parts[0].functionResponse, { name: 'list_files', response: { content: 'a.csv' } })
})

test('permission modes gate edits and execution like Claude Code', async () => {
  const asked: string[] = []
  const ui = async (tool: string) => { asked.push(tool); return true }
  let mode: 'ask' | 'acceptEdits' | 'plan' | 'bypass' = 'ask'
  const gate = permissionGate(() => mode, ui)!
  assert.equal(await gate('write_file', 'x', 'edit'), true)
  assert.equal(await gate('run_python', 'x', 'exec'), true)
  assert.deepEqual(asked, ['write_file', 'run_python'])
  mode = 'acceptEdits'
  await gate('write_file', 'x', 'edit')
  await gate('run_command', 'x', 'exec')
  assert.deepEqual(asked, ['write_file', 'run_python', 'run_command'])
  mode = 'plan'
  assert.equal(await gate('write_file', 'x', 'edit'), false)
  assert.equal(await gate('run_python', 'x', 'exec'), false)
  mode = 'bypass'
  assert.equal(await gate('run_python', 'x', 'exec'), true)
  assert.equal(asked.length, 3)
  assert.equal(await permissionGate(() => 'ask')?.('write_file', 'fixture', 'edit'), true, 'unattended runs keep auto-approve')
})

test('model choice: session pick, then user defaults, then legacy genome roles', () => {
  const g = { routing: { roles: { main: 'deepseek/a', fast: 'deepseek/b' } } } as unknown as HarnessGenome
  assert.equal(modelFor(g, 'main'), 'deepseek/a')
  assert.equal(modelFor(g, 'fast'), 'deepseek/b')
  assert.equal(modelFor(g, 'main', { defaults: { model: 'openai/x' } }), 'openai/x')
  assert.equal(modelFor(g, 'main', { session: 'gemini/y', defaults: { model: 'openai/x' } }), 'gemini/y')
  assert.equal(modelFor(g, 'fast', { session: 'gemini/y' }), 'gemini/y')
  assert.equal(modelFor(g, 'fast', { session: 'gemini/y', defaults: { fast: 'openai/mini' } }), 'openai/mini')
  assert.throws(() => modelFor({ routing: {} } as unknown as HarnessGenome, 'main'), /模型/)
})

test('projects, folder picker, library index and token usage', () => {
  const dir = tempWorkspace()
  const proj = mkdtempSync(join(tmpdir(), 'evo-proj-'))
  try {
    const rt = openRuntime(openWorkspace(dir))
    assert.throws(() => addProject(rt.ws, rt.db, homedir()), /主目录/)
    assert.throws(() => addProject(rt.ws, rt.db, rt.ws.dataDir), /数据目录/)
    assert.throws(() => addProject(rt.ws, rt.db, rt.ws.root), /程序目录/)
    assert.throws(() => addProject(rt.ws, rt.db, join(rt.ws.root, 'genomes')), /程序目录/)
    assert.throws(() => addProject(rt.ws, rt.db, 'relative/path'), /绝对路径/)
    mkdirSync(join(proj, 'paper', 'figs'), { recursive: true })
    mkdirSync(join(proj, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(proj, 'paper', 'main.tex'), '\\section{A}')
    writeFileSync(join(proj, 'node_modules', 'x', 'skip.js'), '')
    const p = addProject(rt.ws, rt.db, proj)
    assert.equal(addProject(rt.ws, rt.db, proj).id, p.id, 'adding the same folder twice returns the same project')
    assert.deepEqual(projectFiles(p.path).map((f) => f.path), ['paper/main.tex'])
    assert.ok(listDirs(proj).dirs.some((d) => d.name === 'paper'))
    assert.ok(!listDirs(proj).dirs.some((d) => d.name === 'node_modules'))

    rt.db.prepare(`INSERT INTO sessions (id, created_at, genome_id, title, category, project_id, cwd) VALUES ('s1', ?, 'g-0007', '光谱', 'usage', ?, ?)`).run(new Date().toISOString(), p.id, p.path)
    mkdirSync(join(proj, 'evoscholar-out', 's1'), { recursive: true })
    writeFileSync(join(proj, 'evoscholar-out', 's1', 'fig1.png'), 'png')
    writeFileSync(join(proj, 'evoscholar-out', 's1', 'fit.csv'), 'a,b')
    const n = indexFiles(rt.db, { root: p.path, projectId: p.id, sessionId: 's1' }, ['evoscholar-out/s1/fig1.png', 'evoscholar-out/s1/fit.csv', 'missing.txt', '.evoscholar/trace.jsonl'], 'output')
    assert.equal(n, 2)
    const all = listLibrary(rt.db, { projectId: p.id })
    assert.equal(all.length, 2)
    assert.equal(all.find((f) => f.path.endsWith('.png'))!.type, 'figure')
    setDeliverable(rt.db, all.find((f) => f.path.endsWith('.csv'))!.id, true)
    assert.deepEqual(listLibrary(rt.db, { deliverable: true }).map((f) => f.path), ['evoscholar-out/s1/fit.csv'])
    assert.equal(listLibrary(rt.db, { type: 'figure' }).length, 1)

    rt.ledger.record({ category: 'usage', kind: 'model', provider: 'deepseek', model: 'deepseek/deepseek-flash', sessionId: 's1', inputTokens: 1000, cacheReadTokens: 600, outputTokens: 200, costUsd: 0 })
    rt.ledger.record({ category: 'usage', kind: 'model', provider: 'gemini', model: 'gemini/gemini-3-pro-preview', sessionId: 's1', inputTokens: 500, outputTokens: 50, costUsd: 0 })
    const byModel = usageBy(rt.db, 'model', { days: 7 })
    assert.deepEqual(byModel.map((r) => r.key), ['deepseek/deepseek-flash', 'gemini/gemini-3-pro-preview'])
    assert.equal(usageBy(rt.db, 'project')[0].label, p.name)
    const t = usageTotals(rt.db, 7)
    assert.equal(t.inputTokens, 1500)
    assert.equal(t.cacheReadTokens, 600)
    rt.db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
  }
})

test('shell commands use PowerShell on Windows and /bin/sh elsewhere', () => {
  const [cmd, args] = shellFor('echo hi')
  if (process.platform === 'win32') assert.equal(cmd, 'powershell.exe')
  else assert.deepEqual([cmd, args], ['/bin/sh', ['-c', 'echo hi']])
  assert.equal(typeof createModel, 'function')
})

test('plan mode blocks side effects in unattended sessions', async () => {
  const gate = permissionGate(() => 'plan')
  assert.equal(await gate?.('write_file', 'fixture', 'edit'), false)
  assert.equal(await gate?.('run_command', 'fixture', 'exec'), false)
})

test('Gemini requires a terminal result rather than treating a truncated stream as complete', async () => {
  const model = createGeminiModel({
    baseUrl: 'https://gemini.test/v1beta', model: 'fixture', apiKey: () => 'fixture-key',
    fetch: async () => sse([{ candidates: [{ content: { parts: [{ text: 'partial' }] } }] }])
  })
  await assert.rejects(drain(model.stream({
    requestId: 'fixture', instructions: '', messages: [], tools: [], maxOutputTokens: 10
  }, new AbortController().signal)), /结束状态/)
  assert.deepEqual(parseModelList({ models: [null, 5, { name: 'models/fixture' }] }, 'gemini'), [{ id: 'fixture' }])
})

test('evolution approval still calls the user in completely permissive mode', async () => {
  let asked = 0
  const gate = permissionGate(() => 'bypass', async () => { asked++; return false })
  assert.equal(await gate?.('run_skill', 'fixture', 'evolution'), false)
  assert.equal(asked, 1)
  assert.equal(await permissionGate(() => 'bypass')?.('run_skill', 'fixture', 'evolution'), false)
})

test('custom HTTPS supports proxy fake-IP and denies unapproved private or link-local destinations', () => {
  const publicGateway = new URL('https://gateway.example/v1')
  assert.doesNotThrow(() => checkGatewayIp(publicGateway, '198.18.9.2', 4317, false))
  assert.throws(() => checkGatewayIp(publicGateway, '192.168.1.10', 4317, false), /授权/)
  assert.doesNotThrow(() => checkGatewayIp(publicGateway, '192.168.1.10', 4317, true))
  assert.throws(() => checkGatewayIp(publicGateway, '169.254.1.2', 4317, true), /链路本地/)
  assert.throws(() => checkGatewayIp(publicGateway, '::ffff:169.254.1.2', 4317, true), /链路本地/)
  assert.throws(() => checkGatewayIp(new URL('http://127.0.0.1:4317'), '127.0.0.1', 4317, true), /工作台/)
})

test('fixed public presets keep the injected transport, and a custom public gateway uses the authorized root', async (t) => {
  const old = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = 'fixture-key'
  t.after(() => {
    if (old === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = old
  })
  const config = { providers: {} } as EvoConfig
  const fixed = await fetchProviderModels(config, 'deepseek', async (input, init) => {
    assert.equal(new URL(String(input)).hostname, 'api.deepseek.com')
    assert.equal(init?.redirect, 'error')
    return Response.json({ data: [{ id: 'fixture' }] })
  })
  assert.equal(fixed.ok, true)
  const base = 'https://gateway.example/v1'
  config.providers.fixture = {
    baseUrl: base, apiKeyEnv: 'DEEPSEEK_API_KEY', credentialOrigin: new URL(base).origin,
    gatewayApproval: { base, privateAccess: false }
  }
  const custom = await fetchProviderModels(config, 'fixture', async (input) => {
    const url = new URL(String(input))
    assert.doesNotThrow(() => checkGatewayIp(url, '198.18.0.9', 4317, false))
    assert.equal(url.pathname, '/v1/models')
    return Response.json({ data: [{ id: 'fixture' }] })
  })
  assert.equal(custom.ok, true)
})

test('usageTotals aggregates beyond the 400-model grouping limit and ignores dev sessions', () => {
  const dir = tempWorkspace()
  try {
    const rt = openRuntime(openWorkspace(dir))
    const ts = new Date().toISOString()
    rt.db.prepare(`INSERT INTO sessions (id, created_at, genome_id, title, category) VALUES ('s-dev', ?, 'g-0007', 'dev', 'dev')`).run(ts)
    const stmt = rt.db.prepare(`INSERT INTO ledger (ts, category, kind, provider, model, session_id, input_tokens, cache_read_tokens, output_tokens, cost_usd, cost_cny)
      VALUES (?, 'usage', 'model', 'openai', ?, NULL, 10, 2, 5, 0, 0)`)
    rt.db.exec('BEGIN')
    for (let i = 0; i < 450; i++) stmt.run(ts, `openai/m-${i}`)
    rt.db.prepare(`INSERT INTO ledger (ts, category, kind, provider, model, session_id, input_tokens, cache_read_tokens, output_tokens, cost_usd, cost_cny)
      VALUES (?, 'usage', 'model', 'openai', 'openai/dev-only', 's-dev', 9999, 0, 9999, 0, 0)`).run(ts)
    rt.db.exec('COMMIT')
    assert.equal(usageBy(rt.db, 'model').length, 400)
    const totals = usageTotals(rt.db, 7)
    assert.equal(totals.requests, 450)
    assert.equal(totals.inputTokens, 4500)
    assert.equal(totals.cacheReadTokens, 900)
    assert.equal(totals.outputTokens, 2250)
    rt.db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('testProviderConnection records sessionless token usage without cost', async (t) => {
  const dir = tempWorkspace()
  const old = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = 'probe-key'
  t.after(() => {
    if (old === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = old
    rmSync(dir, { recursive: true, force: true })
  })
  const rt = openRuntime(openWorkspace(dir))
  t.after(() => rt.db.close())
  const fetchMock = (async () => sse([
    { choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 18, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 6 } } }
  ], true)) as unknown as typeof fetch
  const res = await testProviderConnection(rt.ws.config, 'deepseek/deepseek-flash', { fetch: fetchMock, ledger: rt.ledger })
  assert.equal(res.ok, true)
  const rows = rt.db.prepare(`SELECT category, kind, provider, model, session_id, input_tokens, cache_read_tokens, output_tokens, cost_usd, cost_cny FROM ledger`).all() as Record<string, unknown>[]
  assert.equal(rows.length, 1)
  assert.deepEqual({ ...rows[0] }, {
    category: 'usage', kind: 'model', provider: 'deepseek', model: 'deepseek/deepseek-flash',
    session_id: null, input_tokens: 18, cache_read_tokens: 6, output_tokens: 3, cost_usd: 0, cost_cny: 0
  })
  const bySession = usageBy(rt.db, 'session', { days: 7 })
  assert.equal(bySession.length, 1)
  assert.equal(bySession[0].label, '（无会话）')
  assert.equal(bySession[0].inputTokens, 18)
  assert.equal(usageTotals(rt.db, 7).requests, 1)
})
