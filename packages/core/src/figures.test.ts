import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { TOOL_FACTORIES, pythonBin, type ToolEnv } from './tools'
import { checkFeedbackStats, feedbackEvents, openRuntime, openWorkspace, readCheckReport, recordCheckFeedback } from './index'

const REPO = resolve(__dirname, '../../..')
const config = JSON.parse(readFileSync(join(REPO, 'evoscholar.config.json'), 'utf8'))
const workspace = { root: REPO, dataDir: resolve(REPO, config.dataDir ?? 'data'), config }

test('figure_check measures a saved figure, applies the rule pack and returns a preview image', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fig-'))
  const events: Record<string, unknown>[] = []
  const env = { ws: workspace, cwd, sessionId: 't', trace: (e: Record<string, unknown>) => events.push(e) } as unknown as ToolEnv
  // A 6-inch-wide PDF: too wide for a Nature column; and a 150-dpi PNG: below IEEE's line-art 600 dpi.
  execFileSync(pythonBin(env), ['-c', `
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
from PIL import Image
plt.rcParams['pdf.fonttype'] = 42
Image.new('RGB', (1200, 600)).save('no-dpi.png')
fig, ax = plt.subplots(figsize=(8, 3)); ax.plot([0, 1], [0, 1]); fig.savefig('wide.pdf'); fig.savefig('low.png', dpi=150)
`], { cwd })
  const tool = TOOL_FACTORIES.figure_check(env)
  const signal = new AbortController().signal
  const r = (await tool.execute(tool.validate!({ path: 'wide.pdf', venue: 'nature' }) as never, { signal } as never)) as { content: { type: string; text?: string; mimeType?: string }[] }
  assert.match(r.content[0].text!, /✗ 1 个错误 · wide\.pdf（规则包 nature）· 203\.2×76\.2 mm/)
  assert.match(r.content[0].text!, /超过 183 mm/)
  assert.equal(r.content.at(-1)!.type, 'image')
  assert.equal(r.content.at(-1)!.mimeType, 'image/png')
  const low = (await tool.execute({ path: 'low.png', venue: 'ieee' } as never, { signal } as never)) as { content: { text?: string }[] }
  assert.match(low.content[0].text!, /低于要求 600 dpi/)
  const missing = (await tool.execute({ path: 'no-dpi.png', venue: 'ieee', photo: true } as never, { signal } as never)) as typeof low
  assert.match(missing.content[0].text!, /^待核对/)
  const single = (await tool.execute({ path: 'no-dpi.png', venue: 'ieee', photo: true, columns: 'single' } as never, { signal } as never)) as typeof low
  assert.match(single.content[0].text!, /^✓ 通过[\s\S]*88.9 mm 栏宽下有效 DPI 342.86/)
  assert.deepEqual(events.map((e) => e.status), ['fail', 'fail', 'review', 'pass'])
  assert.throws(() => tool.validate!({ path: 'x', venue: 'ieee', columns: 'single', target_width_mm: 89 }))
  assert.throws(() => tool.validate!({ path: 'x', venue: '../etc' }))
  await assert.rejects(tool.execute({ path: '../outside.pdf' } as never, { signal } as never))
})

test('manuscript_check runs rule packs on a LaTeX project and writes reports', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ms-'))
  const { mkdirSync, writeFileSync, existsSync } = await import('node:fs')
  mkdirSync(join(cwd, 'paper'))
  writeFileSync(join(cwd, 'paper', 'main.tex'), '\\documentclass{article}\\begin{document}\n\\section{A}\\label{s}\nSee \\ref{s} and \\ref{nope}.\n\\end{document}\n')
  const events: Record<string, unknown>[] = []
  const env = { ws: workspace, cwd, sessionId: 't', trace: (e: Record<string, unknown>) => events.push(e) } as unknown as ToolEnv
  const tool = TOOL_FACTORIES.manuscript_check(env)
  const r = (await tool.execute(tool.validate!({ path: 'paper/main.tex', annotate: true }) as never, { signal: new AbortController().signal } as never)) as { content: { text: string }[] }
  const text = r.content[0].text
  assert.match(text, /稿件检查报告：main\.tex/)
  assert.match(text, /main\.tex:3 · \\ref\{nope\} 引用了不存在的标签/)
  const report = readCheckReport(join(cwd, '.evoscholar', 'checks', 'main', 'report.json'))
  assert.equal(report.summary.source_path, 'paper/main.tex')
  assert.ok(existsSync(join(cwd, '.evoscholar', 'checks', 'main', 'annotated', 'main.tex')))
  assert.equal(events[0].kind, 'manuscript.check')
  assert.throws(() => tool.validate!({ path: 'x', packs: ['../etc'] }))
  assert.throws(() => tool.validate!({ path: 'x', variant: 'a b' }))
})

test('check_feedback records verdicts from a manuscript_check report; stats compute per-rule false-positive rates', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const cwd = mkdtempSync(join(tmpdir(), 'fb-'))
  mkdirSync(join(cwd, '.evoscholar', 'checks', 'main'), { recursive: true })
  writeFileSync(join(cwd, '.evoscholar', 'checks', 'main', 'report.json'), JSON.stringify({
    summary: { file: 'main.tex', packs: ['common'] },
    findings: [{ id: 'F001', rule: 'common.units', pack: 'common', loc: 'main.tex:3', message: 'm' }, { id: 'F002', rule: 'common.units', pack: 'common', loc: 'main.tex:4', message: 'm' }]
  }))
  const events: Record<string, unknown>[] = []
  const env = { ws: { root: REPO, dataDir: join(REPO, 'data') }, cwd, trace: (e: Record<string, unknown>) => events.push(e) } as unknown as ToolEnv
  const tool = TOOL_FACTORIES.check_feedback(env)
  const r = (await tool.execute(tool.validate!({ ids: ['F002', 'F009'], verdict: 'false_positive', note: '单位是变量名' }) as never, {} as never)) as { content: { text: string }[] }
  assert.match(r.content[0].text, /已记录 1 条为「误报」：F002（common\.units）/)
  assert.match(r.content[0].text, /没有这些编号：F009/)
  assert.equal(events[0].verdict, 'false_positive')
  assert.throws(() => tool.validate!({ ids: ['x'], verdict: 'valid' }))
  // stats over the events table (CLI path)
  const ws = mkdtempSync(join(tmpdir(), 'fbws-'))
  const { cpSync } = await import('node:fs')
  cpSync(join(REPO, 'evoscholar.config.json'), join(ws, 'evoscholar.config.json'))
  mkdirSync(join(ws, 'genomes'))
  cpSync(join(REPO, 'genomes', 'g-0000.yaml'), join(ws, 'genomes', 'g-0000.yaml'))
  writeFileSync(join(ws, 'genomes', 'ACTIVE'), 'g-0000\n')
  const rt = openRuntime(openWorkspace(ws), () => {})
  const rep = readCheckReport(join(cwd, '.evoscholar', 'checks', 'main', 'report.json'))
  recordCheckFeedback(rt, feedbackEvents(rep, ['F001'], 'valid').events)
  recordCheckFeedback(rt, feedbackEvents(rep, ['F002'], 'false_positive').events)
  const stats = checkFeedbackStats(rt)
  assert.deepEqual(stats.map((s) => [s.rule, s.valid, s.false_positive, s.fp_rate]), [['common.units', 1, 1, 0.5]])
})
