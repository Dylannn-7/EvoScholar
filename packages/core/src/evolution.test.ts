import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isDeepSeekPeak } from './pricing'
import { addLessons, candidateDetail, dossier, lineDiff, listCandidates, evolveRound, judge, nextVersionPath, openRuntime, openWorkspace, promote, rollback, sanitizeProposals, type CaseResult } from './index'

const REPO = resolve(__dirname, '../../..')
const BENCH = `
import json, sys, shutil
from pathlib import Path
ROOT = Path(__file__).resolve().parent
cmd, *a = sys.argv[1:]
if cmd == 'prepare':
    d = Path(a[1]); d.mkdir(parents=True, exist_ok=True)
    (d / 'task.md').write_text('把 {"x": 1} 写入 answer.json，x 为数字。', encoding='utf-8')
    (d / '.benchmark-case.json').write_text(json.dumps({'id': a[0], 'phase': 1}))
elif cmd == 'grade':
    d = Path(a[0]); m = json.loads((d / '.benchmark-case.json').read_text())
    try: ok = json.loads((d / 'answer.json').read_text()).get('x') == 1 and not isinstance(json.loads((d / 'answer.json').read_text()).get('x'), bool)
    except Exception: ok = False
    print(json.dumps({'id': m['id'], 'phase': 1, 'machine_status': 'pass' if ok else 'fail', 'failures': [] if ok else ['answer.json 的 x 不符合验收答案'], 'manual_review': []}))
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
