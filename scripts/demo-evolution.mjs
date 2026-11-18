import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify, stripVTControlCharacters } from 'node:util'

const root = fileURLToPath(new URL('../', import.meta.url))
const cli = join(root, 'apps', 'cli', 'dist', 'main.js')
const run = promisify(execFile)
const lesson = '将测量结果写入 JSON 时，数值字段使用 JSON number，保留数值类型'

function mockTurn({ messages, tools }) {
  let delta
  let reason = 'stop'
  const toolCall = (name, args) => {
    reason = 'tool_calls'
    return {
      tool_calls: [{ index: 0, id: `demo-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
    }
  }
  const results = messages.filter((message) => message.role === 'tool')
  if (!tools?.length) {
    delta = { content: JSON.stringify({
      proposals: [{ target: 'instructions', diagnosis: '数值字段被写成字符串，判分时类型不符', bullets: [lesson] }]
    }) }
  } else if (!results.length) {
    delta = toolCall('read_file', { path: 'task.md' })
  } else if (results.length === 1) {
    const task = String(results[0].content)
    const match = /采样值（摄氏度）：(\[[\d ,.-]+\])/.exec(task)
    assert.ok(match, 'The mock expected the public sample task')
    const samples = JSON.parse(match[1])
    const mean = samples.reduce((total, sample) => total + sample, 0) / samples.length
    const passing = task.includes('冷却阶段') || messages.some((m) => m.role === 'system' && String(m.content).includes(lesson))
    delta = toolCall('write_file', {
      path: 'answer.json',
      content: JSON.stringify({ count: samples.length, mean: passing ? mean : String(mean) })
    })
  } else {
    delta = { content: '已保存 answer.json。' }
  }

  const chunks = [
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: reason }] },
    { choices: [], usage: { prompt_tokens: 750, completion_tokens: 50 } }
  ]
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
}

await readFile(cli).catch(() => {
  throw new Error('请先运行 npm run build / Run npm run build first')
})
const workspace = await mkdtemp(join(tmpdir(), 'evoscholar-demo-'))
const gateway = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const response = mockTurn(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(response)
  } catch (error) {
    console.error(error.message)
    res.writeHead(400).end()
  }
})
try {
  gateway.listen(0, '127.0.0.1')
  await once(gateway, 'listening')
  for (const name of ['genomes', 'prompts', 'skills', 'examples/evolution']) {
    await cp(join(root, name), join(workspace, name), { recursive: true })
  }
  const config = JSON.parse(await readFile(join(root, 'evoscholar.config.json'), 'utf8'))
  config.dataDir = 'data'
  config.evolution.offPeakOnly = false
  config.providers = {
    deepseek: {
      endpoint: `http://127.0.0.1:${gateway.address().port}/v1/chat/completions`,
      protocol: 'chat-completions',
      apiKeyEnv: 'EVOSCHOLAR_DEMO_API_KEY'
    }
  }
  await writeFile(join(workspace, 'evoscholar.config.json'), JSON.stringify(config))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.endsWith('_API_KEY')))
  env.EVOSCHOLAR_DEMO_API_KEY = 'local-demo'
  const active = async () => (await readFile(join(workspace, 'genomes', 'ACTIVE'), 'utf8')).trim()

  async function command(...args) {
    console.log(`\n$ es ${args.join(' ')}`)
    const { stdout } = await run(process.execPath, ['--no-warnings', cli, ...args], { cwd: workspace, env, timeout: 60_000 })
    console.log(stripVTControlCharacters(stdout).trimEnd())
    return stripVTControlCharacters(stdout)
  }

  console.log('公开示例评测集 · 本地模拟网关 · ¥0 实际支出')
  const baseline = await active()
  assert.match(await command('eval', 'all'), /通过 1\/3/)
  assert.match(await command('evolve', '--candidates', '1'), /开发集 0\/2|基线通过 0\/2/)
  const candidates = await command('candidates')
  const candidate = /^([\w-]+)\s+pending\s+/m.exec(candidates)?.[1]
  assert.ok(candidate, 'Expected a pending candidate')
  assert.equal(await active(), baseline)
  const detail = await command('candidates', candidate)
  assert.match(detail, /开发集 0 → 2 \/ 2/)
  assert.match(detail, /验收集 1 → 1 \/ 1/)
  assert.ok(detail.includes(lesson))
  await command('promote', candidate)
  assert.equal(await active(), candidate)
  await command('rollback')
  assert.equal(await active(), baseline)
} catch (error) {
  if (error.stdout) console.error(stripVTControlCharacters(error.stdout))
  if (error.stderr) console.error(error.stderr)
  throw error
} finally {
  gateway.close()
  await rm(workspace, { recursive: true, force: true })
}
