import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import type { Json } from '@evoscholar/harness'
import { runPyHelper } from './exec'
import { modelPath } from './sandbox'
import { objectArgs, textResult, type ToolFactory } from './types'

type Issue = { level: 'error' | 'warning'; rule: string; message: string }
type FileReport = { ok: boolean; status: 'pass' | 'review' | 'fail' | 'measured'; issues: Issue[]; measured: Record<string, unknown>; preview?: string }

/**
 * Post-render check of a saved figure against a venue rule pack (rulepacks/figures/<venue>.yaml):
 * physical size, editable fonts, raster DPI. Returns the findings plus a PNG preview the model sees.
 */
export const figureCheck: ToolFactory = (env) => ({
  name: 'figure_check',
  version: '1',
  description:
    '出图后检查：按期刊规则包检查已导出图的尺寸、PDF 字体嵌入和位图有效分辨率（含 PDF 内嵌位图），返回实际文件的渲染预览。' +
    'venue 可选 nature、ieee、optica、wiley、neurips、iclr、icml、cvpr；不给则只测量不判定。' +
    '已知投稿尺寸时，传 columns（half / single / double）或 target_width_mm，位图会按目标栏宽计算有效 DPI。' +
    '字号、坐标轴单位、配色等需要 matplotlib 对象的检查，请在 run_python 里用 evoscholar_fig.check_figure / save。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '图文件路径（工作目录内）' },
      venue: { type: 'string', description: '规则包标识，如 nature、ieee' },
      columns: { type: 'string', enum: ['half', 'single', 'double'], description: '采用规则包的目标栏宽' },
      target_width_mm: { type: 'number', exclusiveMinimum: 0, description: '明确的目标排版宽度（mm），和 columns 二选一' },
      photo: { type: 'boolean', description: '位图是照片 / 显微图像而不是数据线稿（分辨率要求不同）' }
    },
    required: ['path'],
    additionalProperties: false
  },
  scheduling: 'parallel',
  validate: (i) => {
    const a = objectArgs(i, ['path', 'venue', 'photo', 'columns', 'target_width_mm'], ['path']) as { venue?: unknown; columns?: unknown; target_width_mm?: unknown }
    if (a.venue !== undefined && !/^[a-z0-9-]{1,30}$/.test(String(a.venue))) throw new Error('venue 只能是小写字母、数字和 -')
    if (a.columns !== undefined && !['half', 'single', 'double'].includes(String(a.columns))) throw new Error('columns 只能是 half、single 或 double')
    if (a.target_width_mm !== undefined) {
      if (a.columns !== undefined) throw new Error('columns 和 target_width_mm 只能指定一个')
      if (typeof a.target_width_mm !== 'number' || !Number.isFinite(a.target_width_mm) || a.target_width_mm <= 0)
        throw new Error('目标栏宽必须是正数（mm）')
    }
    return a as Json
  },
  authorize: async () => true,
  async execute(args, c) {
    const a = args as { path: string; venue?: string; photo?: boolean; columns?: string; target_width_mm?: number }
    const file = modelPath(env, a.path)
    if (!existsSync(file)) return textResult(`文件不存在：${a.path}`, true)
    const dir = mkdtempSync(join(tmpdir(), 'evoscholar-figure-check-'))
    const cli = ['check', file, '--preview-out', join(dir, 'preview.png')]
    if (a.venue) cli.push('--venue', a.venue)
    if (a.photo) cli.push('--photo')
    if (a.columns) cli.push('--columns', a.columns)
    if (a.target_width_mm !== undefined) cli.push('--target-width-mm', String(a.target_width_mm))
    let r: FileReport
    let png: Buffer | undefined
    try {
      r = JSON.parse(await runPyHelper(env, 'evoscholar_fig.py', cli, c.signal)) as FileReport
      if (r.preview && existsSync(r.preview)) png = readFileSync(r.preview)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    const m = r.measured
    const size = m.width_mm ? `${m.width_mm}×${m.height_mm} mm` : '尺寸未知'
    const errors = r.issues.filter((issue) => issue.level === 'error').length
    const label = { pass: '✓ 通过', review: '待核对', fail: `✗ ${errors} 个错误`, measured: '仅测量' }[r.status]
    const details = [size]
    if (m.effective_dpi !== undefined) details.push(`${m.target_width_mm} mm 栏宽下有效 DPI ${m.effective_dpi}`)
    if (m.dpi !== undefined) details.push(`文件 DPI ${m.dpi}`)
    if (m.min_embedded_dpi !== undefined) details.push(`PDF 嵌入位图最低有效 DPI ${m.min_embedded_dpi}`)
    if (m.fonts) details.push(`字体 ${(m.fonts as string[]).join(', ')}`)
    if (m.text_elements !== undefined) details.push(`SVG 文本元素 ${m.text_elements} 个`)
    const lines = [
      `${label} · ${basename(file)}（${a.venue ? `规则包 ${a.venue}` : '未指定规则包'}）· ${details.join(' · ')}`,
      ...r.issues.map((i) => `- [${i.level === 'error' ? '错误' : '提醒'}] ${i.message}`)
    ]
    env.trace?.({ kind: 'figure.check', file: relative(env.cwd, file), venue: a.venue ?? null, ok: r.ok, status: r.status, issues: r.issues.length })
    const content: ({ type: 'text'; text: string } | { type: 'image'; mimeType: string; source: string; filename: string })[] = [{ type: 'text', text: lines.join('\n') }]
    if (png && r.preview) {
      content.push({ type: 'text', text: '渲染预览（请看图检查重叠、裁切、可读性）：' })
      const mimeType = /\.jpe?g$/i.test(r.preview) ? 'image/jpeg' : 'image/png'
      content.push({ type: 'image', mimeType, source: `data:${mimeType};base64,${png.toString('base64')}`, filename: basename(r.preview) })
    }
    return { content }
  }
})
