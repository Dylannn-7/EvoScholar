import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative } from 'node:path'
import type { Json } from '@evoscholar/harness'
import { inside } from './sandbox'
import { objectArgs, textResult, type ToolFactory } from './types'

const IMAGE: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const TEXT_LIMIT = 200_000

function isProbablyText(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false
  return true
}

export const listFiles: ToolFactory = (env) => ({
  name: 'list_files',
  version: '1',
  description: '列出工作目录（或其子目录）中的文件和文件夹，带大小。depth 默认 2。',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: '相对工作目录的路径，默认 .' }, depth: { type: 'integer', minimum: 1, maximum: 5 } },
    additionalProperties: false
  },
  scheduling: 'parallel',
  validate: (i) => objectArgs(i, ['path', 'depth']) as Json,
  authorize: async () => true,
  async execute(args) {
    const a = args as { path?: string; depth?: number }
    const root = inside(env.cwd, a.path ?? '.')
    const out: string[] = []
    const walk = (dir: string, d: number) => {
      for (const name of readdirSync(dir).sort()) {
        if (name === 'node_modules' || name === '.git') continue
        const full = join(dir, name)
        const st = statSync(full)
        const rel = relative(env.cwd, full)
        out.push(st.isDirectory() ? `${rel}/` : `${rel}  (${st.size} B)`)
        if (out.length > 500) return
        if (st.isDirectory() && d > 1) walk(full, d - 1)
      }
    }
    walk(root, a.depth ?? 2)
    return textResult(out.length ? out.join('\n') : '（空目录）')
  }
})

export const readFile: ToolFactory = (env) => ({
  name: 'read_file',
  version: '1',
  description:
    '读取工作目录中的文件。文本文件返回内容（可用 offset/limit 按行分页）；PNG/JPG 等图片会以图像形式交给你查看；PDF 请用 run_python 提取。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      offset: { type: 'integer', minimum: 1, description: '起始行号，从 1 开始' },
      limit: { type: 'integer', minimum: 1, maximum: 5000, description: '最多读取的行数' }
    },
    required: ['path'],
    additionalProperties: false
  },
  scheduling: 'parallel',
  validate: (i) => objectArgs(i, ['path', 'offset', 'limit'], ['path']) as Json,
  authorize: async () => true,
  async execute(args) {
    const a = args as { path: string; offset?: number; limit?: number }
    const file = inside(env.cwd, a.path)
    if (!existsSync(file)) return textResult(`文件不存在：${a.path}`, true)
    const st = statSync(file)
    if (st.isDirectory()) return textResult(`${a.path} 是目录，请用 list_files`, true)
    const mime = IMAGE[extname(file).toLowerCase()]
    if (mime) {
      if (st.size > 8 * 1024 * 1024) return textResult('图片超过 8 MB', true)
      // The harness media layer accepts data: URLs (or http URLs) and slash-free filenames.
      const dataUrl = `data:${mime};base64,${readFileSync(file).toString('base64')}`
      return {
        content: [
          { type: 'text', text: `图片 ${a.path}（${(st.size / 1024).toFixed(1)} KB）：` },
          { type: 'image', mimeType: mime, source: dataUrl, filename: basename(file) }
        ]
      }
    }
    const buf = readFileSync(file)
    if (!isProbablyText(buf)) return textResult(`${a.path} 是二进制文件（${st.size} B），请用 run_python 处理`, true)
    const lines = buf.toString('utf8').split('\n')
    const start = (a.offset ?? 1) - 1
    const slice = lines.slice(start, a.limit ? start + a.limit : undefined).join('\n')
    const text = slice.length > TEXT_LIMIT ? slice.slice(0, TEXT_LIMIT) + `\n…（已截断；共 ${lines.length} 行，请用 offset/limit 分页）` : slice
    return textResult(text)
  }
})

export const writeFile: ToolFactory = (env) => ({
  name: 'write_file',
  version: '1',
  description: '在工作目录中创建或覆盖一个文本文件（UTF-8），会自动创建上级目录。',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
    additionalProperties: false
  },
  scheduling: 'exclusive',
  validate(i) {
    const a = objectArgs(i, ['path', 'content'], ['path', 'content'])
    if (typeof a.content !== 'string') throw new Error('content must be a string')
    return a as Json
  },
  authorize: async (args) => (env.approve ? env.approve('write_file', `写入文件 ${(args as { path: string }).path}`, 'edit') : true),
  async execute(args) {
    const a = args as { path: string; content: string }
    const file = inside(env.cwd, a.path)
    mkdirSync(dirname(file), { recursive: true })
    const existed = existsSync(file)
    writeFileSync(file, a.content, 'utf8')
    env.trace?.({ kind: 'file.write', path: a.path, bytes: Buffer.byteLength(a.content) })
    env.onFiles?.([relative(env.cwd, file)])
    return textResult(`${existed ? '已覆盖' : '已创建'} ${a.path}（${Buffer.byteLength(a.content)} B）`)
  }
})

export const editFile: ToolFactory = (env) => ({
  name: 'edit_file',
  version: '1',
  description: '把文件中唯一出现的一段文本 old_text 替换为 new_text。old_text 必须与原文完全一致且只出现一次。',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } },
    required: ['path', 'old_text', 'new_text'],
    additionalProperties: false
  },
  scheduling: 'exclusive',
  validate: (i) => objectArgs(i, ['path', 'old_text', 'new_text'], ['path', 'old_text', 'new_text']) as Json,
  authorize: async (args) => (env.approve ? env.approve('edit_file', `修改文件 ${(args as { path: string }).path}`, 'edit') : true),
  async execute(args) {
    const a = args as { path: string; old_text: string; new_text: string }
    const file = inside(env.cwd, a.path)
    if (!existsSync(file)) return textResult(`文件不存在：${a.path}`, true)
    const text = readFileSync(file, 'utf8')
    const count = text.split(a.old_text).length - 1
    if (count !== 1) return textResult(`old_text 出现了 ${count} 次，需要恰好 1 次`, true)
    writeFileSync(file, text.replace(a.old_text, () => a.new_text), 'utf8')
    env.trace?.({ kind: 'file.edit', path: a.path })
    env.onFiles?.([relative(env.cwd, file)])
    return textResult(`已修改 ${a.path}`)
  }
})
