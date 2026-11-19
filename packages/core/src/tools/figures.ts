import { existsSync, readFileSync } from 'node:fs'
import { basename, extname, relative } from 'node:path'
import type { Json } from '@evoscholar/harness'
import { runPyHelper } from './exec'
import { modelPath } from './sandbox'
import { objectArgs, textResult, type ToolFactory } from './types'

type Issue = { level: 'error' | 'warning'; rule: string; message: string }
type FileReport = { ok: boolean; issues: Issue[]; measured: Record<string, unknown>; preview?: string }

/**
 * Post-render check of a saved figure against a venue rule pack (rulepacks/figures/<venue>.yaml):
 * physical size, editable fonts, raster DPI. Returns the findings plus a PNG preview the model sees.
 */
export const figureCheck: ToolFactory = (env) => ({
  name: 'figure_check',
  version: '1',
  description:
    '出图后检查：对已保存的图（PDF / SVG / PNG / JPG / TIFF）按期刊规则包检查尺寸、字体是否可编辑、位图分辨率，并把渲染预览图交给你看。' +
    'venue 可选 nature、ieee、optica、wiley、neurips、iclr、icml、cvpr；不给则只测量不判定。' +
    '字号、坐标轴单位、配色等需要 matplotlib 对象的检查，请在 run_python 里用 evoscholar_fig.check_figure / save。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '图文件路径（工作目录内）' },
      venue: { type: 'string', description: '规则包标识，如 nature、ieee' },
      photo: { type: 'boolean', description: '位图是照片 / 显微图像而不是数据线稿（分辨率要求不同）' }
    },
    required: ['path'],
    additionalProperties: false
  },
  scheduling: 'parallel',
  validate: (i) => {
    const a = objectArgs(i, ['path', 'venue', 'photo'], ['path']) as { venue?: unknown }
    if (a.venue !== undefined && !/^[a-z0-9-]{1,30}$/.test(String(a.venue))) throw new Error('venue 只能是小写字母、数字和 -')
    return a as Json
  },
  authorize: async () => true,
  async execute(args, c) {
    const a = args as { path: string; venue?: string; photo?: boolean }
    const file = modelPath(env, a.path)
    if (!existsSync(file)) return textResult(`文件不存在：${a.path}`, true)
    if (!/\.(png|jpe?g)$/i.test(file)) {
      if (!(await env.approve?.('figure_check', `渲染 ${a.path} 的检查预览`, 'edit', c.signal) ?? true))
        return textResult('未获准保存图形预览', true)
      c.signal.throwIfAborted()
      const ext = extname(file)
      modelPath(env, (ext ? file.slice(0, -ext.length) : file) + '.preview.png')
    }
    const cli = ['check', file, '--preview', ...(a.venue ? ['--venue', a.venue] : []), ...(a.photo ? ['--photo'] : [])]
    const r = JSON.parse(await runPyHelper(env, 'evoscholar_fig.py', cli, c.signal)) as FileReport
    const m = r.measured
    const size = m.width_mm ? `${m.width_mm}×${m.height_mm} mm` : '尺寸未知'
    const lines = [
      `${r.ok ? '✓' : '✗'} ${basename(file)}（${a.venue ? `规则包 ${a.venue}` : '未指定规则包'}）· ${size}${m.dpi ? ` · ${m.dpi} dpi` : ''}${m.fonts ? ` · 字体 ${(m.fonts as string[]).join(', ')}` : ''}${m.text_elements !== undefined ? ` · SVG 文本元素 ${m.text_elements} 个` : ''}`,
      ...r.issues.map((i) => `- [${i.level === 'error' ? '错误' : '提醒'}] ${i.message}`)
    ]
    env.trace?.({ kind: 'figure.check', file: relative(env.cwd, file), venue: a.venue ?? null, ok: r.ok, issues: r.issues.length })
    const content: ({ type: 'text'; text: string } | { type: 'image'; mimeType: string; source: string; filename: string })[] = [{ type: 'text', text: lines.join('\n') }]
    if (r.preview && existsSync(r.preview)) {
      content.push({ type: 'text', text: '渲染预览（请看图检查重叠、裁切、可读性）：' })
      content.push({ type: 'image', mimeType: 'image/png', source: `data:image/png;base64,${readFileSync(r.preview).toString('base64')}`, filename: basename(r.preview) })
    }
    return { content }
  }
})
