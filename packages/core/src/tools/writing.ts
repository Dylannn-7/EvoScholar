import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { feedbackEvents, readCheckReport, VERDICTS } from '../checkfeedback'
import { basename, join, relative } from 'node:path'
import type { Json } from '@evoscholar/harness'
import { runPyHelper } from './exec'
import { modelPath } from './sandbox'
import { objectArgs, textResult, type ToolFactory } from './types'

type Finding = { id: string; rule: string; severity: 'error' | 'warning' | 'info'; loc: string; message: string; evidence: string; source: string; pack: string }
type Report = { summary: Record<string, unknown>; findings: Finding[]; verify: string[]; counts: Record<string, number>; text: string; written?: string[] }

/**
 * Manuscript check (LaTeX / Word / Markdown / PDF) against writing rule packs
 * (rulepacks/writing/<pack>.yaml). Writes report.json / report.md (and annotated copies) under
 * .evoscholar/checks/ and returns the readable report.
 */
export const manuscriptCheck: ToolFactory = (env) => ({
  name: 'manuscript_check',
  version: '1',
  description:
    '按规则包检查稿件（.tex 主文件会沿 \\input 追踪；.docx；.md；编译后的 .pdf 用于页数和元数据）。' +
    '规则包：common（默认）、hust-thesis（variant: master / doctor / undergrad）、ml-conference（variant: neurips2026 / neurips2025 / icml2026 / iclr2026 / icml2027 / iclr2027）、' +
    'aaai、cvf、acl、eccv、ijcai、optica、ieee-journal、gbt7714、advanced-photonics、springer-journal、cn-physics。' +
    'acs、wiley、science、springer-nature、cn-optics、cn-computing 的专用规则按期刊或稿型 variant 选择，见插件的规则包详情。' +
    '返回带定位（文件:行、段落 N、p.N）和依据的问题清单；annotate=true 时另存带批注的副本（Word 插批注，LaTeX 行尾 % EVO 注释），原稿不改。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '稿件路径（工作目录内）' },
      packs: { type: 'array', items: { type: 'string' }, description: '规则包列表，默认 ["common"]' },
      variant: { type: 'string', description: '规则包的类型，如 master、neurips2026' },
      annotate: { type: 'boolean', description: '是否生成带批注的副本' },
      stage: { type: 'string', enum: ['submission', 'camera-ready'], description: '投稿版（默认，做匿名检查）或录用后终稿（不查匿名，页数按终稿上限）' }
    },
    required: ['path'],
    additionalProperties: false
  },
  scheduling: 'exclusive',
  validate: (i) => {
    const a = objectArgs(i, ['path', 'packs', 'variant', 'annotate', 'stage'], ['path']) as { packs?: unknown; variant?: unknown; stage?: unknown }
    if (a.stage !== undefined && a.stage !== 'submission' && a.stage !== 'camera-ready') throw new Error('stage 只能是 submission 或 camera-ready')
    if (a.packs !== undefined && (!Array.isArray(a.packs) || a.packs.length > 6 || a.packs.some((p) => typeof p !== 'string' || !/^[a-z0-9-]{1,40}$/.test(p))))
      throw new Error('packs 必须是小写规则包名数组（最多 6 个）')
    if (a.variant !== undefined && !/^[a-z0-9-]{1,30}$/.test(String(a.variant))) throw new Error('variant 只能是小写字母、数字和 -')
    return a as Json
  },
  authorize: async (args, ctx) => env.approve?.('manuscript_check', `保存 ${(args as { path: string }).path} 的检查报告`, 'edit', ctx.signal) ?? true,
  async execute(args, c) {
    const a = args as { path: string; packs?: string[]; variant?: string; annotate?: boolean; stage?: string }
    const file = modelPath(env, a.path)
    const out = modelPath(env, join('.evoscholar', 'checks', basename(file).replace(/\.[^.]+$/, '')))
    mkdirSync(out, { recursive: true })
    const cli = ['check', file, '--out', out, ...(a.packs ?? ['common']).flatMap((p) => ['--pack', p]), ...(a.variant ? ['--variant', a.variant] : []), ...(a.annotate ? ['--annotate'] : []), ...(a.stage ? ['--stage', a.stage] : [])]
    const r = JSON.parse(await runPyHelper(env, 'evoscholar_write.py', cli, c.signal, 180)) as Report
    env.trace?.({ kind: 'manuscript.check', file: relative(env.cwd, file), packs: a.packs ?? ['common'], variant: a.variant ?? null, counts: r.counts })
    const files = (r.written ?? []).map((w) => relative(env.cwd, w)).join('、')
    return textResult(`${r.text}\n\n完整报告：${files}`)
  }
})

/** Record the user's verdict (有效 / 误报 / 不确定) on findings of a manuscript_check report. */
export const checkFeedback: ToolFactory = (env) => ({
  name: 'check_feedback',
  version: '1',
  description: '记录用户对稿件检查结果的判断：哪些问题有效、哪些是误报。用户说「F003 是误报」之类时调用；report 默认用最近一次 manuscript_check 的报告。',
  parameters: {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'string' }, description: '问题编号，如 ["F003", "F007"]' },
      verdict: { type: 'string', enum: ['valid', 'false_positive', 'unsure'] },
      note: { type: 'string', description: '用户给的原因（可选）' },
      report: { type: 'string', description: 'report.json 路径（可选）' }
    },
    required: ['ids', 'verdict'],
    additionalProperties: false
  },
  scheduling: 'exclusive',
  validate: (i) => {
    const a = objectArgs(i, ['ids', 'verdict', 'note', 'report'], ['ids', 'verdict']) as { ids?: unknown; verdict?: unknown; note?: unknown }
    if (!Array.isArray(a.ids) || !a.ids.length || a.ids.length > 200 || a.ids.some((x) => typeof x !== 'string' || !/^F\d{3,4}$/.test(x))) throw new Error('ids 必须是 F001 形式的编号数组')
    if (!VERDICTS[String(a.verdict)]) throw new Error('verdict 只能是 valid、false_positive 或 unsure')
    if (a.note !== undefined && String(a.note).length > 500) throw new Error('note 太长')
    return a as Json
  },
  authorize: async (_args, ctx) => env.approve?.('check_feedback', '记录稿件检查反馈', 'edit', ctx.signal) ?? true,
  async execute(args) {
    const a = args as { ids: string[]; verdict: string; note?: string; report?: string }
    let file: string | undefined
    if (a.report) file = modelPath(env, a.report)
    else {
      const dir = modelPath(env, join('.evoscholar', 'checks'))
      const cands = existsSync(dir) ? readdirSync(dir).map((d) => join(dir, d, 'report.json')).filter((f) => existsSync(f)) : []
      file = cands.map((f) => modelPath(env, f)).sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs)[0]
    }
    if (!file || !existsSync(file)) return textResult('没有找到稿件检查报告，先运行 manuscript_check', true)
    const { events, missing } = feedbackEvents(readCheckReport(file), a.ids, VERDICTS[a.verdict], a.note)
    for (const e of events) env.trace?.(e)
    const label = { valid: '有效', false_positive: '误报', unsure: '不确定' }[VERDICTS[a.verdict]]
    return textResult(`已记录 ${events.length} 条为「${label}」：${events.map((e) => `${e.finding}（${e.rule}）`).join('、')}${missing.length ? `\n报告里没有这些编号：${missing.join('、')}` : ''}`, events.length === 0)
  }
})
