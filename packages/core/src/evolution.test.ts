import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isDeepSeekPeak } from './pricing'
import { TOOL_FACTORIES, type ToolEnv } from './tools'
import { addLessons, candidateDetail, dossier, evaluate, lineDiff, lineage, listCandidates, evolveRound, judge, mutate, nextVersionPath, openResearchSession, openRuntime, openWorkspace, promote, readSkillFile, rollback, sanitizeProposals, type CaseResult } from './index'

const REPO = resolve(__dirname, '../../..')
const BENCH = `
import json, sys, shutil
from pathlib import Path
ROOT = Path(__file__).resolve().parent
cmd, *a = sys.argv[1:]
cases = {case['id']: case for case in json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))['cases']}
def write_task(dest, case_id, phase):
    ref = cases[case_id].get('task')
    prompt = '把 {"x": 1} 写入 answer.json，x 为数字。'
    if ref:
        seed = (ROOT / ref).read_text(encoding='utf-8')
        prompt = seed.split(f'<!-- prompt-{phase}:begin -->')[1].split(f'<!-- prompt-{phase}:end -->')[0].strip()
    (dest / 'task.md').write_text(prompt, encoding='utf-8')
    (dest / '.benchmark-case.json').write_text(json.dumps({'id': case_id, 'phase': phase}))
if cmd == 'prepare':
    d = Path(a[1]); d.mkdir(parents=True, exist_ok=True)
    write_task(d, a[0], 1)
elif cmd == 'advance':
    d = Path(a[0]); m = json.loads((d / '.benchmark-case.json').read_text())
    write_task(d, m['id'], 2)
elif cmd == 'grade':
    d = Path(a[0]); m = json.loads((d / '.benchmark-case.json').read_text())
    try: ok = json.loads((d / 'answer.json').read_text()).get('x') == 1 and not isinstance(json.loads((d / 'answer.json').read_text()).get('x'), bool)
    except Exception: ok = False
    print(json.dumps({'id': m['id'], 'phase': m['phase'], 'machine_status': 'pass' if ok else 'fail', 'failures': [] if ok else ['answer.json 的 x 不符合验收答案'], 'manual_review': []}))
    sys.exit(0 if ok else 1)
`

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'evo-ev-'))
  for (const f of ['evoscholar.config.json']) cpSync(join(REPO, f), join(dir, f))
  // Start from generation 0 only, whatever real evolution rounds have added to the repo.
  cpSync(join(REPO, 'skills'), join(dir, 'skills'), { recursive: true })
  mkdirSync(join(dir, 'genomes'))
  cpSync(join(REPO, 'genomes', 'g-0000.yaml'), join(dir, 'genomes', 'g-0000.yaml'))
  writeFileSync(join(dir, 'genomes', 'ACTIVE'), 'g-0000\n')
  mkdirSync(join(dir, 'prompts'))
  for (const f of ['system@v1.md', 'compaction@v1.md']) cpSync(join(REPO, 'prompts', f), join(dir, 'prompts', f))
  mkdirSync(join(dir, 'evals'))
  writeFileSync(join(dir, 'evals', 'bench.py'), BENCH)
  writeFileSync(join(dir, 'evals', 'manifest.json'), JSON.stringify({ cases: [
    { id: 'T01', title: '数字类型', category: 'data', default_split: 'development', phases: 1, trace: false, manual_review: false },
    { id: 'T02', title: '数字类型 2', category: 'data', default_split: 'development', phases: 1, trace: false, manual_review: false },
    { id: 'A01', title: '验收', category: 'data', default_split: 'acceptance', phases: 1, trace: false, manual_review: false }
  ] }))
  writeFileSync(join(dir, '.env'), 'DEEPSEEK_API_KEY=sk-test\n')
  delete process.env.DEEPSEEK_API_KEY
  return dir
}

const sse = (chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
const usage = { choices: [], usage: { prompt_tokens: 800, completion_tokens: 60 } }

test('helpers: lessons section, version paths, judge, sanitize', () => {
  const p = addLessons('# 指令\n\n## 工具\n- a', ['数值用数字类型'])
  assert.match(p, /## 经验手册\n- 数值用数字类型/)
  assert.equal(addLessons(p, ['数值用数字类型', '新条目']).match(/数值用数字类型/g)!.length, 1)
  const vdir = mkdtempSync(join(tmpdir(), 'evo-v-'))
  mkdirSync(join(vdir, 'prompts'))
  for (const v of [1, 3]) writeFileSync(join(vdir, 'prompts', `system@v${v}.md`), '')
  assert.equal(nextVersionPath(vdir, 'prompts/system@v1.md'), 'prompts/system@v4.md')
  const r = (id: string, pass: boolean) => ({ caseId: id, pass } as CaseResult)
  assert.equal(judge([r('a', false), r('b', true)], [r('a', true), r('b', true)]).better, true)
  assert.equal(judge([r('a', false), r('b', true)], [r('a', true), r('b', false)]).better, false)
  // Repeated samples: a fix that does not reproduce (0/2 → 1/2) plus a lucky regression is not enough.
  const j = judge([r('a', false), r('a', false), r('b', true), r('b', true)], [r('a', true), r('a', false), r('b', true), r('b', true)])
  assert.equal(j.gain, 0.5)
  assert.equal(j.better, false)
  assert.equal(judge([r('a', false), r('a', false), r('c', false)], [r('a', true), r('a', true), r('c', false)]).better, true)
  const s = sanitizeProposals([
    { target: 'instructions', diagnosis: 'd', bullets: ['通用规则', '照抄 L03 的答案'], cases: ['T01', 'ZZZ'] },
    { target: 'tool:rm_rf', diagnosis: 'x', bullets: ['y'], cases: [] }
  ], ['write_file'], ['T01'])
  assert.deepEqual(s, [{ target: 'instructions', diagnosis: 'd', bullets: ['通用规则'], cases: ['T01'] }])
})

test('full evolution round: baseline fails → reflect → candidate passes → promote → rollback', async () => {
  const dir = workspace()
  const ws = openWorkspace(dir)
  const rt = openRuntime(ws, () => {})
  const real = globalThis.fetch
  let reflectorCalls = 0
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    const system = body.messages.find((m: { role: string }) => m.role === 'system')?.content ?? ''
    if (!body.tools?.length) {
      reflectorCalls++
      const json = JSON.stringify({ proposals: [{ target: 'instructions', diagnosis: 'JSON 中数值被写成字符串', bullets: ['输出 JSON 时数值用数字类型，不要加引号'], cases: ['T01', 'T02'] }] })
      return sse([{ choices: [{ index: 0, delta: { content: json }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, usage])
    }
    const done = body.messages.some((m: { role: string }) => m.role === 'tool')
    if (done) return sse([{ choices: [{ index: 0, delta: { content: '完成' }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, usage])
    const content = String(system).includes('不要加引号') ? '{"x": 1}' : '{"x": "1"}'
    return sse([
      { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'w1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'answer.json', content }) } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, usage
    ])
  }) as typeof fetch
  try {
    const logs: string[] = []
    const rep = await evolveRound(rt, { force: true, concurrency: 1, onProgress: (m) => logs.push(m) })
    assert.equal(rep.status, 'done', logs.join('\n'))
    assert.equal(rep.baseline.filter((r) => r.pass).length, 0)
    assert.equal(reflectorCalls, 1)
    assert.equal(rep.candidates.length, 1)
    const c = rep.candidates[0]
    assert.equal(c.status, 'pending', c.reason)
    assert.equal(c.devPass, 2)
    assert.equal(c.accPass, 1)
    assert.equal(c.genome, 'g-0001')
    const g = rt.genomes.load('g-0001')
    assert.equal(g.status, 'candidate')
    assert.equal(g.parent, 'g-0000')
    assert.equal(g.instructions.system, 'prompts/system@v2.md')
    assert.match(readFileSync(join(dir, 'prompts/system@v2.md'), 'utf8'), /## 经验手册\n- 输出 JSON 时数值用数字类型/)
    assert.equal(rt.genomes.activeId(), 'g-0000', 'nothing goes live without approval')
    assert.match(readFileSync(rep.reportPath, 'utf8'), /待审批/)
    assert.ok(rep.costCny > 0)
    assert.ok(rt.ledger.summary().byCategory.evolution > 0)

    // Baseline results are cached by behavioural hash: a second suite run costs nothing.
    // Baseline: 2 dev + 2 confirmation re-runs of the flipped cases + 1 acceptance.
    const cached = rt.db.prepare(`SELECT COUNT(*) n FROM eval_runs WHERE genome_id = 'g-0000'`).get() as { n: number }
    assert.equal(cached.n, 5)
    assert.ok(logs.some((l) => l.includes('复核翻转的 2 题')), logs.join('\n'))

    // The reflector sees what the agent actually wrote for a failed file (not the answer).
    const failedBase = rep.baseline.find((r) => !r.pass)!
    const ev = dossier(rt, { id: failedBase.caseId, title: 't', category: 'data' } as any, failedBase)
    assert.match(ev, /answer\.json（智能体写出的开头）：\n\{"x": "1"\}/)

    // Review data for the approval panel.
    assert.deepEqual(lineDiff('a\nb', 'a\nc').map((l) => l.op + l.text), [' a', '-b', '+c'])
    assert.equal(listCandidates(rt, 'pending')[0].genome_id, 'g-0001')
    const d = candidateDetail(rt, 'g-0001')
    assert.equal(d.promptDiffs.length, 1)
    assert.equal(d.promptDiffs[0].key, 'system')
    assert.ok(d.promptDiffs[0].diff.some((l) => l.op === '+' && l.text.includes('不要加引号')))
    assert.ok(d.genomeDiff.some((l) => l.op === '+' && l.text.includes('system@v2.md')))
    assert.deepEqual(d.cases.map((x) => [x.caseId, x.base, x.cand]), [['A01', false, true], ['T01', false, true], ['T02', false, true]])
    assert.match(d.report ?? '', /进化报告/)

    promote(rt, 'g-0001')
    assert.equal(rt.genomes.activeId(), 'g-0001')
    assert.equal(rt.genomes.load('g-0000').status, 'archived')
    assert.throws(() => promote(rt, 'g-0001'))
    rollback(rt)
    assert.equal(rt.genomes.activeId(), 'g-0000')
    assert.equal(rt.genomes.load('g-0000').status, 'active')
  } finally {
    globalThis.fetch = real
  }
})

test('evolution refuses to run at peak time unless forced', async () => {
  const rt = openRuntime(openWorkspace(workspace()), () => {})
  if (!isDeepSeekPeak()) return
  await assert.rejects(evolveRound(rt), /高峰/)
})

test('a dev evaluation obeys its own round cap before reaching the gateway', async (t) => {
  const rt = openRuntime(openWorkspace(workspace()), () => {})
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    throw new Error('evaluation should have been blocked before sending')
  }
  t.after(() => { globalThis.fetch = realFetch; rt.db.close() })
  await assert.rejects(evaluate(rt, rt.genomes.load(), 'development', { category: 'dev', capCny: 0.001 }),
    { name: 'BudgetError', scope: 'round' })
  assert.equal(calls, 0)
  assert.equal(rt.ledger.summary().reservedCny, 0)
})

test('resuming a baseline keeps previously billed requests under the same round cap', async (t) => {
  const ws = openWorkspace(workspace())
  ws.config.evolution.offPeakOnly = false
  const rt = openRuntime(ws, () => {})
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch; rt.db.close() })
  const id = 'evo-20261118134108-01234567'
  const previous = rt.ledger.forRound(id).record({ category: 'evolution', kind: 'model', provider: 'deepseek', costUsd: 0.02 })
  rt.db.prepare("INSERT INTO evolution_runs(id, ts_start, status, base_genome, cost_cny) VALUES (?, ?, 'budget', ?, ?)")
    .run(id, new Date().toISOString(), rt.genomes.activeId(), previous)
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('resumed round should have exhausted its budget') }
  const result = await evolveRound(rt, { resumeBaselineRunId: id, capCny: previous })
  assert.equal(result.runId, id)
  assert.equal(result.status, 'budget')
  assert.equal(result.costCny, previous)
  assert.equal(calls, 0)
  assert.deepEqual(rt.db.prepare('SELECT id FROM evolution_runs').all().map((row) => row.id), [id])
})

test('evaluation cache skips old rows and refreshes only the task whose prompt changed', async (t) => {
  const dir = workspace()
  const manifestPath = join(dir, 'evals', 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const taskPath = join(dir, 'evals', 'T01.md')
  manifest.cases[0].task = 'T01.md'
  manifest.cases[0].phases = 2
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const writeSeed = (phase2: string) => writeFileSync(taskPath,
    `<!-- prompt-1:begin -->\n写 answer.json。\n<!-- prompt-1:end -->\n<!-- prompt-2:begin -->\n${phase2}\n<!-- prompt-2:end -->\n`)
  writeSeed('第二阶段')
  const rt = openRuntime(openWorkspace(dir), () => {})
  const genome = rt.genomes.load()
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch; rt.db.close() })
  rt.db.prepare(`INSERT INTO eval_runs (genome_id, genome_hash, case_id, split, pass, failures, ts)
                  VALUES (?, ?, 'T01', 'development', 0, '[]', ?)`)
    .run(genome.id, rt.genomes.hash(genome), new Date().toISOString())
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    calls++
    const { messages } = JSON.parse(String(init?.body))
    const lastPrompt = messages.findLastIndex((m: { role: string }) => m.role === 'user')
    if (messages.slice(lastPrompt + 1).some((m: { role: string }) => m.role === 'tool'))
      return sse([{ choices: [{ index: 0, delta: { content: '完成' }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, usage])
    return sse([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `w-${calls}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'answer.json', content: '{"x": 1}' }) } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, usage
    ])
  }

  const first = await evaluate(rt, genome, 'development')
  assert.ok(first.every((r) => r.pass && !r.cached))
  const firstCalls = calls
  assert.ok(firstCalls > 0)
  assert.ok((await evaluate(rt, genome, 'development')).every((r) => r.cached))
  assert.equal(calls, firstCalls)

  writeSeed('第二阶段改为明确 JSON 字段格式')
  const [edited, unchanged] = await evaluate(rt, genome, 'development')
  assert.equal(edited.caseId, 'T01')
  assert.ok(edited.pass && !edited.cached)
  assert.notEqual(edited.sessionId, first[0].sessionId)
  assert.equal(unchanged.caseId, 'T02')
  assert.ok(unchanged.cached)
  assert.equal(unchanged.sessionId, first[1].sessionId)
  assert.ok(calls > firstCalls)
  assert.match(readFileSync(join(edited.runDir, 'task.md'), 'utf8'), /明确 JSON 字段格式/)
  assert.ok((await evaluate(rt, genome, 'development')).every((r) => r.cached))
})

const finishText = (content: string) => sse([
  { choices: [{ index: 0, delta: { content }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, usage
])

const callTool = (id: string, name: string, args: Record<string, unknown>) => sse([
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, usage
])

for (const target of ['skill:distilled-numeric-output', 'workflow:verify-output']) {
  test(`v2 ${target}: assessed candidate, approval and rollback`, async (t) => {
    const rt = openRuntime(openWorkspace(workspace()), () => {})
    const originalFetch = globalThis.fetch
    t.after(() => { globalThis.fetch = originalFetch; rt.db.close() })
    const base = rt.genomes.load()
    const oldHash = rt.genomes.hash(base)
    const newSkill = target.startsWith('skill:')
    const lesson = '导出结构化产物后校验字段的数据类型。'
    let reviews = 0
    let reads = 0
    globalThis.fetch = async (_url, init) => {
      const { messages, tools } = JSON.parse(String(init?.body)) as {
        messages: { role: string; content: string; reasoning_content?: string; tool_calls?: { id: string }[] }[]
        tools?: { function: { name: string } }[]
      }
      const system = messages[0].content
      if (system.includes('EvoScholar 的「反思器」')) {
        const positive = messages[1].content.split('已通过的开发集轨迹（仅工具顺序）：')[1].split('失败任务')[0]
        assert.match(positive, /data · 2 步 · write_file/)
        assert.doesNotMatch(positive, /answer\.json|\{"x"/)
        return finishText(JSON.stringify({ proposals: [{
          target, description: '需要输出结构化数值时使用。', diagnosis: '数字字段需要校验',
          bullets: newSkill ? [lesson] : [], cases: ['T02']
        }] }))
      }
      if (system.includes('你是科研工作流的只读子代理')) {
        reviews++
        assert.equal(tools?.length ?? 0, 0)
        assert.match(messages[1].content, /待交付答复/)
        assert.match(messages[1].content, /宿主读取的文件证据[\s\S]+task\.md[\s\S]+answer\.json/)
        return finishText('请确认输出的 x 是 JSON 数字。')
      }
      const results = messages.filter((message) => message.role === 'tool').map((message) => message.content)
      if (messages.some((message) => !message.reasoning_content && message.tool_calls?.some((call) => call.id.startsWith('review_'))))
        return new Response('Missing reasoning_content', { status: 400 })
      const difficult = system.includes('T02-')
      const skillEnabled = system.includes('distilled-numeric-output')
      if (difficult && skillEnabled && !results.length)
        return callTool('read-skill', 'read_skill', { name: 'distilled-numeric-output' })
      if (skillEnabled && results.some((result) => result.includes(lesson))) reads++
      const reviewed = system.includes('请确认输出的 x 是 JSON 数字。')
      if (reviewed && difficult && !results.some((result) => result.includes('已覆盖')))
        return callTool('correct-answer', 'write_file', { path: 'answer.json', content: '{"x":1}' })
      if (results.some((result) => result.includes('已创建') || result.includes('已覆盖'))) return finishText('已交付。')
      const pass = !difficult || results.some((result) => result.includes(lesson))
      return callTool('write-answer', 'write_file', { path: 'answer.json', content: pass ? '{"x":1}' : '{"x":"1"}' })
    }
    const report = await evolveRound(rt, { force: true, concurrency: 1 })
    assert.equal(report.status, 'done', readFileSync(report.reportPath, 'utf8'))
    assert.equal(report.candidates.length, 1)
    const [candidate] = report.candidates
    assert.equal(candidate.status, 'pending', candidate.reason)
    assert.equal(candidate.basePass, 1)
    assert.equal(candidate.devPass, 2)
    assert.equal(candidate.accPass, 1)
    assert.equal(rt.genomes.activeId(), base.id)
    assert.equal(rt.genomes.hash(base), oldHash)
    assert.throws(() => rollback(rt, candidate.genome), /只能回滚/)
    const detail = candidateDetail(rt, candidate.genome)
    if (newSkill) {
      assert.ok(reads > 0)
      assert.match(detail.skillDiffs[0].to ?? '', /SKILL@v1\.md$/)
      assert.ok(detail.skillDiffs[0].diff.some((line) => line.op === '+' && line.text.includes(lesson)))
    } else {
      assert.ok(reviews > 0)
      assert.ok(detail.workflowDiff.some((line) => line.op === '+' && line.text === 'review: before-final'))
    }
    assert.equal(lineage(rt).find((node) => node.id === candidate.genome)?.candidateStatus, 'pending')
    assert.equal(promote(rt, candidate.genome).id, candidate.genome)
    const restored = rollback(rt)
    assert.equal(restored.id, base.id)
    assert.deepEqual(restored.skills, base.skills)
    assert.deepEqual(restored.workflows, base.workflows)
  })
}

test('final parent step performs one review using current files before another tool call', async (t) => {
  const rt = openRuntime(openWorkspace(workspace()), () => {})
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch; rt.db.close() })
  const base = rt.genomes.load()
  const genome = { ...base, workflows: { review: 'before-final' as const }, budgets: { ...base.budgets, maxSteps: 3 } }
  let parentCalls = 0
  let reviewCalls = 0
  globalThis.fetch = async (_url, init) => {
    const { messages, tools, thinking } = JSON.parse(String(init?.body))
    const system = messages[0].content
    if (system.includes('你是科研工作流的只读子代理')) {
      assert.equal(parentCalls, 2)
      assert.equal(tools?.length ?? 0, 0)
      assert.deepEqual(thinking, { type: 'disabled' })
      assert.match(messages[1].content, /宿主读取的文件证据[\s\S]+answer\.json[\s\S]+\{"n":3\}/)
      reviewCalls++
      return finishText('核对得到当前 n=3。')
    }
    parentCalls++
    if (parentCalls === 1) return callTool('write-summary', 'write_file', { path: 'answer.json', content: '{"n":3}' })
    if (parentCalls === 2) return callTool('read-summary', 'read_file', { path: 'answer.json' })
    assert.match(system, /本轮只读核对记录[\s\S]+核对得到当前 n=3/)
    assert.ok(!tools.some((tool: { function: { name: string } }) => tool.function.name === 'verify_workflow_output'))
    return callTool('patch-summary', 'edit_file', { path: 'answer.json', old_text: '3', new_text: '4' })
  }
  const rs = await openResearchSession(rt, { genome, stage: 'data', category: 'dev' })
  try {
    assert.equal((await rs.ask('生成统计摘要')).status, 'budget')
    assert.equal(readFileSync(join(rs.cwd, 'answer.json'), 'utf8'), '{"n":4}')
    assert.equal(parentCalls, 3)
    assert.equal(reviewCalls, 1)
    const event = rt.db.prepare("SELECT payload FROM events WHERE session_id=? AND type='host.workflow.review'").get(rs.id) as { payload: string }
    const { trigger, ok } = JSON.parse(event.payload)
    assert.deepEqual({ trigger, ok }, { trigger: 'last-step', ok: true })
  } finally { await rs.dispose() }
})

test('skill revision preserves the previous genome and hides unpinned revisions', async (t) => {
  const rt = openRuntime(openWorkspace(workspace()), () => {})
  t.after(() => rt.db.close())
  const base = rt.genomes.load()
  const old = readSkillFile(rt.ws.root, 'literature-review', 1)!
  const oldHash = rt.genomes.hash(base)
  const candidate = mutate(rt, base, {
    target: 'skill:literature-review', description: '检索文献时使用。', diagnosis: '检查题录',
    bullets: ['按标题和出版年份核对题录。'], cases: []
  }, 'test')
  assert.equal(candidate.skills?.[0].version, 2)
  assert.equal(readSkillFile(rt.ws.root, 'literature-review', 1)?.raw, old.raw)
  assert.match(readSkillFile(rt.ws.root, 'literature-review', 2)!.body, /按标题和出版年份核对题录/)
  assert.equal(readSkillFile(rt.ws.root, 'literature-review', 3), null)
  for (const [genome, revision] of [[base, 1], [candidate, 2]] as const) {
    const tool = TOOL_FACTORIES.read_skill({ ws: rt.ws, skills: genome.skills } as ToolEnv)
    const result = await tool.execute(tool.validate({ name: 'literature-review' }), { signal: new AbortController().signal } as never)
    assert.ok('content' in result && result.content[0].type === 'text')
    assert.match(result.content[0].text, new RegExp(`# 技能 literature-review v${revision}\\n`))
    assert.equal(result.content[0].text.includes('按标题和出版年份核对题录'), revision === 2)
  }
  assert.equal(rt.genomes.hash(base), oldHash)
  assert.throws(() => promote(rt, candidate.id), /缺少评测记录/)
})

test('parallel workflow actually runs both search delegates concurrently and can merge them', async (t) => {
  const rt = openRuntime(openWorkspace(workspace()), () => {})
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch; rt.db.close() })
  const propose = (target: string) => ({ target: `workflow:${target}`, diagnosis: '文献工作流', bullets: [], cases: [] })
  const base = rt.genomes.load()
  const split = mutate(rt, base, propose('split-research'), 'test')
  assert.equal(split.workflows?.literature, 'split')
  const parallel = mutate(rt, split, propose('parallel-search'), 'test')
  assert.equal(parallel.workflows?.literature, 'parallel')
  const merged = mutate(rt, parallel, propose('merge-research'), 'test')
  assert.equal(merged.workflows?.literature, 'delegated')
  assert.deepEqual(merged.tools.enabled, base.tools.enabled)
  let active = 0
  let peak = 0
  const searches: string[] = []
  const delegateTools = new Set<string>()
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.crossref.org/works?')) {
      const query = new URL(String(url)).searchParams.get('query.bibliographic')
      assert.ok(query)
      searches.push(query)
      return Response.json({ message: { items: [] } })
    }
    const { messages, tools } = JSON.parse(String(init?.body))
    if (messages[0].content.includes('你是科研工作流的只读子代理')) {
      const names = tools.map((item: { function: { name: string } }) => item.function.name)
      delegateTools.add(names.join(','))
      assert.ok(names.every((name: string) => ['lit_search', 'lit_lookup', 'lit_verify'].includes(name)))
      if (!names.includes('lit_search')) return finishText('候选题录已核对。')
      if (messages.some((message: { role: string }) => message.role === 'tool'))
        return finishText(`已检索：${messages[1].content}`)
      active++
      peak = Math.max(peak, active)
      try {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return callTool('crossref-search', 'lit_search', { query: messages[1].content, sources: ['crossref'] })
      } finally { active-- }
    }
    const evidence = messages.filter((message: { role: string }) => message.role === 'tool')
      .map((message: { content: string }) => message.content).join('\n')
    if (messages[0].content.includes('交给 researcher'))
      return evidence ? finishText('单代理工作流完成。') : callTool('merged', 'delegate_task', { agent: 'researcher', task: '统一文献范围' })
    if (messages[0].content.includes('交 searcher 检索')) {
      if (evidence.includes('候选题录已核对')) return finishText('拆分工作流完成。')
      if (evidence) return callTool('verify-refs', 'delegate_task', { agent: 'verifier', task: '核对候选题录' })
      return callTool('search-refs', 'delegate_task', { agent: 'searcher', task: '拆分检索范围' })
    }
    if (evidence) {
      assert.match(evidence, /硅光网络/)
      assert.match(evidence, /光子机器学习/)
      return finishText('两个检索分支均已完成。')
    }
    return callTool('parallel', 'parallel_lit_search', { queries: ['硅光网络', '光子机器学习'] })
  }
  const session = await openResearchSession(rt, { genome: parallel, stage: 'literature', category: 'dev' })
  try {
    const result = await session.ask('检索两个文献方向')
    assert.equal(result.status, 'complete')
    assert.match(result.answer, /两个检索分支均已完成/)
    assert.equal(peak, 2)
    assert.deepEqual(new Set(searches), new Set(['硅光网络', '光子机器学习']))
    assert.equal(existsSync(join(session.cwd, '.evoscholar', 'last_search.json')), false)
    assert.ok(rt.ledger.summary().byCategory.dev > 0)
  } finally { await session.dispose() }
  for (const [genome, expected] of [[split, '拆分工作流完成。'], [merged, '单代理工作流完成。']] as const) {
    const rs = await openResearchSession(rt, { genome, stage: 'literature', category: 'dev' })
    try { assert.equal((await rs.ask('检索并核验文献')).answer, expected) } finally { await rs.dispose() }
  }
  assert.ok(delegateTools.has('lit_lookup,lit_verify'))
  assert.ok(delegateTools.has('lit_search,lit_lookup,lit_verify'))
})
