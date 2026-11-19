#!/usr/bin/env node
// Zero-cost interactive demo: a scripted local model + a throw-away workspace with a sample project.
// No API key and no network. Usage: npm run build && npm run demo   (then open the printed URL)
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const PORT = Number(process.env.EVOSCHOLAR_PORT ?? 4399)
const MOCK_PORT = Number(process.env.EVOSCHOLAR_DEMO_MOCK_PORT ?? 4398)
if (!existsSync(join(ROOT, 'apps/server/dist/server.js'))) {
  console.error('请先运行 npm run build')
  process.exit(1)
}

// ---------------------------------------------------------------- scripted model (OpenAI chat-completions SSE)
const ANSWER = `## 拟合结果

三个谐振峰都用洛伦兹线型拟合：

| 峰 | 中心波长 (nm) | FWHM (pm) | Q 值 |
| --- | --- | --- | --- |
| 1 | 1549.32 | 41.2 | 3.76 × 10⁴ |
| 2 | 1550.11 | 38.9 | 3.98 × 10⁴ |
| 3 | 1550.87 | 44.5 | 3.49 × 10⁴ |

- 拟合参数已写入交付目录的 \`fit_results.csv\`，在「资料空间」里可以找到
- 这是演示模式：回答由本地脚本生成，不调用任何模型，也不产生费用`

const PLOT = (out) => `# 演示绘图目标：${out}/fig1_spectrum.svg`
function fixturePlot() {
  const wave = Array.from({ length: 500 }, (_, i) => {
    const nm = 1549 + 2.5 * i / 499
    const y = 1 - [[0.8, 1549.32, 0.02], [0.9, 1550.11, 0.019], [0.7, 1550.87, 0.022]]
      .reduce((sum, [a, c, w]) => sum + a / (1 + ((nm - c) / w) ** 2), 0)
    return `${(70 + i).toFixed(1)},${(30 + (1 - y) * 250).toFixed(1)}`
  }).join(' ')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="350" viewBox="0 0 600 350">
<rect width="600" height="350" fill="white"/><path d="M70 25V290H575" fill="none" stroke="#334155"/>
<polyline points="${wave}" fill="none" stroke="#176785" stroke-width="2"/>
<g font-size="15" fill="#17293d"><text x="235" y="325">波长（nm）</text><text x="100" y="60">微环透射谱示例</text>
<text x="65" y="310">1549</text><text x="260" y="310">1550</text><text x="460" y="310">1551</text></g></svg>`
}

function script (body) {
  const msgs = body.messages ?? []
  const text = (c) => (typeof c === 'string' ? c : JSON.stringify(c ?? ''))
  const system = text(msgs[0]?.content)
  const out = /写到 (\S+?)\/ 下/.exec(system)?.[1] ?? 'evoscholar-out'
  const users = msgs.filter((m) => m.role === 'user').map((m) => text(m.content))
  const lastUser = users.at(-1) ?? ''
  const lastUserIdx = msgs.map((m) => m.role).lastIndexOf('user')
  const sinceUser = msgs.slice(lastUserIdx + 1)
  const tools = sinceUser.filter((m) => m.role === 'tool')
  const lastTool = text(tools.at(-1)?.content)
  const recall = users.some((u) => /L-\d{4}/.test(u))
  if (!body.tools?.length) return { say: 'OK' }
  if (lastUser.startsWith('【自检】')) return { think: '自检：图和数据文件都已生成，尺寸与字号符合单栏要求。', say: '自检完成：交付文件齐全，结论与数据一致。' }
  const n = tools.length
  if (n === 0) return { think: recall ? '按 L-0001，读数据前先列目录确认真实文件名。' : '用户要拟合透射谱。先看看项目里有哪些数据文件。', call: ['list_files', { path: 'data' }] }
  if (!recall && n === 1) return { think: '看起来数据在 data/spectrum.txt，直接读取。', call: ['run_python', { code: "import pandas as pd\npd.read_csv('data/spectrum.txt')" }] }
  if (!recall && n === 2) return { think: '失败了：文件名是我猜的。先反思再继续。', call: ['reflect', { situation: '读取 data/spectrum.txt 失败', cause: '凭描述猜了文件名，实际是 data/spectrum.csv', next_action: '改读 data/spectrum.csv；以后读数据前先列目录确认', adjust: 'lesson' }] }
  if (!recall && n === 3) return { think: '把这个做法记成经验，以后同类任务直接用。', call: ['note_lesson', { trigger: '读取用户的数据文件前', advice: '先用 list_files 确认真实文件名和扩展名，不要凭描述猜' }] }
  if (!recall && n === 4) return { think: '配色是口味问题，用户没说明，给几个方案让用户选。', call: ['offer_choices', { question: '出图配色用哪一套？', topic: '出图配色', options: [{ label: 'Okabe-Ito', detail: '色盲友好的离散配色' }, { label: 'viridis', detail: '连续色，适合多条曲线' }, { label: '期刊单色', detail: '黑灰线型区分' }] }] }
  const k = recall ? n : n - 4
  if (k === 1) return { think: '用洛伦兹线型拟合并按单栏尺寸出图。', call: ['run_python', { code: PLOT(out) }] }
  if (k === 2) return { think: /退出码 [1-9]|Error|出错/.test(lastTool) ? '这台电脑的 Python 环境还没装绘图库（npm run setup:python 会装好），先把拟合参数交付。' : '图已生成，把拟合参数整理成 CSV 交付。', call: ['write_file', { path: `${out}/fit_results.csv`, content: 'peak,center_nm,fwhm_pm,Q\n1,1549.32,41.2,37600\n2,1550.11,38.9,39800\n3,1550.87,44.5,34900\n' }] }
  return { think: '核对：三个峰的 Q 值都在 3.5–4 万之间，与 FWHM 一致。', say: recall ? `已按 L-0001 先确认文件名，并沿用你上次选的配色。\n\n${ANSWER}` : ANSWER }
}

const mock = createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ data: [{ id: 'demo-model', context_window: 128000, supported_reasoning_efforts: ['low', 'medium', 'high'] }] }))
  }
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const plan = script(JSON.parse(raw || '{}'))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const ev = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)
    if (plan.think) ev({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: plan.think }, finish_reason: null }] })
    if (plan.call) {
      ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `c${Date.now()}`, type: 'function', function: { name: plan.call[0], arguments: JSON.stringify(plan.call[1]) } }] }, finish_reason: null }] })
      ev({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    } else {
      for (let i = 0; i < plan.say.length; i += 24) ev({ choices: [{ index: 0, delta: { content: plan.say.slice(i, i + 24) }, finish_reason: null }] })
      ev({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    }
    ev({ choices: [], usage: { prompt_tokens: 2400, completion_tokens: 120, prompt_cache_hit_tokens: 1800 } })
    res.end('data: [DONE]\n\n')
  })
})

// ---------------------------------------------------------------- throw-away workspace + sample project
const ws = mkdtempSync(join(tmpdir(), 'evoscholar-demo-'))
const link = (target, path) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
cpSync(join(ROOT, 'evoscholar.config.json'), join(ws, 'evoscholar.config.json'))
for (const d of ['genomes', 'prompts', 'skills']) cpSync(join(ROOT, d), join(ws, d), { recursive: true })
for (const d of ['figures', 'writing']) cpSync(join(ROOT, 'rulepacks', d), join(ws, 'rulepacks', d), { recursive: true })
link(join(ROOT, 'python'), join(ws, 'python'))
mkdirSync(join(ws, 'data'))
const venv = `pyenv-${process.platform}-${process.arch}`
if (existsSync(join(ROOT, 'data', venv))) link(join(ROOT, 'data', venv), join(ws, 'data', venv))
writeFileSync(join(ws, '.env'), 'DEMO_API_KEY=demo\n')
writeFileSync(join(ws, 'data', 'settings.json'), JSON.stringify({
  providers: { demo: { custom: true, label: '演示模型（本地脚本）', protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, gatewayApproval: { base: `http://127.0.0.1:${MOCK_PORT}/v1`, privateAccess: true }, credentialOrigin: `http://127.0.0.1:${MOCK_PORT}`, apiKeyEnv: 'DEMO_API_KEY', models: [{ id: 'demo-model', contextWindow: 128000, reasoningEffort: { supported: true, values: ['low', 'medium', 'high'] } }], modelsFetchedAt: new Date().toISOString() } },
  defaults: { model: 'demo/demo-model', permission: 'ask' },
  efforts: {}
}, null, 2))
const project = join(ws, '示例项目-微环光谱')
mkdirSync(join(project, 'data'), { recursive: true })
writeFileSync(join(project, 'data', 'spectrum.csv'), 'wavelength_nm,transmission\n1549.00,0.99\n1549.32,0.21\n1549.70,0.97\n1550.11,0.11\n1550.50,0.96\n1550.87,0.31\n1551.20,0.98\n')
writeFileSync(join(project, 'README.md'), '# 微环谐振器透射谱\n\n演示用的示例项目。\n')

process.chdir(ws)
process.env.DEMO_API_KEY = 'demo'
const { openRuntime, openWorkspace, addProject, inside } = await import(join(ROOT, 'packages/core/dist/index.js'))
const { createServerApp } = await import(join(ROOT, 'apps/server/dist/server.js'))
const demoExecutor = {
  available: async () => true,
  start: async () => { throw new Error('演示不启动后台进程') },
  run: async (env, job) => {
    const match = /^# 演示绘图目标：(.+\/fig1_spectrum\.svg)$/.exec(job.code ?? '')
    const result = (code, out, files = []) => ({ code, out, stdout: out, signal: null, timedOut: false, files })
    if (!match) return result(1, '找不到 data/spectrum.txt')
    const path = inside(env.cwd, match[1])
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, fixturePlot())
    return result(0, '已写入演示图', [match[1]])
  }
}
const rt = openRuntime(openWorkspace(ws), undefined, demoExecutor)
addProject(rt.ws, rt.db, project, '示例项目 · 微环光谱')
const { announcePairing, createLocalAuth } = await import(join(ROOT, 'apps/server/dist/local-auth.js'))
const auth = createLocalAuth()
const app = createServerApp(rt, { webDir: join(ROOT, 'apps/web/public'), auth })
const server = createServer(app.handler)
mock.listen(MOCK_PORT, '127.0.0.1', () => server.listen(PORT, '127.0.0.1', () => {
  announcePairing(PORT, auth)
  console.log('不需要 API Key，不联网，不产生费用。左侧「示例项目」里新建会话，输入：')
  console.log('  把 data 里的透射谱拟合成洛伦兹线型并出图')
  console.log('可以看到思考、工具调用、失败后的反思、记经验、选项卡和交付文件；再开一个会话问同样的问题，会回忆刚学到的经验。')
  console.log(`临时工作区：${ws}（按 Ctrl+C 退出时删除）\n`)
}))
const stop = async () => {
  await app.dispose().catch(() => {})
  server.close(); mock.close()
  try { rt.db.close() } catch {}
  rmSync(ws, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
