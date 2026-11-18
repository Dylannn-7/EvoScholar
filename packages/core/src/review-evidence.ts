import { closeSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { extname, join } from 'node:path'
import { runPyHelper } from './tools/exec'
import { inside } from './tools/sandbox'
import type { ToolEnv } from './tools/types'

const TEXT = new Set(['.csv', '.tsv', '.json', '.md', '.txt', '.bib', '.tex'])
const VISUAL = new Set(['.pdf', '.svg', '.png', '.jpg', '.jpeg'])
const EXCERPT_BYTES = 2100
const PACK_BYTES = 16_000

/** Gather a small, read-only evidence packet before invoking the reviewer. */
export async function reviewEvidence(env: ToolEnv, signal: AbortSignal): Promise<string> {
  const samples: string[] = []
  let used = 0
  let pdfsRead = 0
  const add = (text: string) => {
    const bytes = Buffer.byteLength(text)
    if (used + bytes <= PACK_BYTES) {
      samples.push(text)
      used += bytes
    }
  }
  const scan = async (relative: string, depth: number): Promise<void> => {
    let entries
    try { entries = readdirSync(inside(env.cwd, relative), { withFileTypes: true }) } catch { return }
    const priority = (name: string) => name === 'task.md' ? 0 : name === 'answer.json' ? 1 : name === 'inputs' ? 3 : 2
    entries.sort((a, b) => priority(a.name) - priority(b.name) || a.name.localeCompare(b.name))
    for (const entry of entries.slice(0, 40)) {
      signal.throwIfAborted()
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || used >= PACK_BYTES) continue
      const name = relative === '.' ? entry.name : join(relative, entry.name)
      if (entry.isDirectory() && depth > 0) await scan(name, depth - 1)
      const type = extname(entry.name).toLowerCase()
      if (!entry.isFile() || (!TEXT.has(type) && !VISUAL.has(type))) continue
      const cap = Math.min(EXCERPT_BYTES, PACK_BYTES - used - 256)
      if (cap <= 0) return
      try {
        const file = inside(env.cwd, name)
        const fd = openSync(file, 'r')
        try {
          const length = fstatSync(fd).size
          const label = `${name}（${length} 字节）`
          if (type === '.pdf' && pdfsRead < 2) {
            pdfsRead++
            const raw = await runPyHelper(env, 'evoscholar_lit.py', ['pages', file, '1,2'], signal, 8)
            const pages = JSON.parse(raw) as { page: number; text: string }[]
            const excerpt = pages.map((page) => `第 ${page.page} 页：${page.text.trim()}`).join('\n')
            const sample = Buffer.from(excerpt)
            add(`${label}，前两页文字节选\n${sample.subarray(0, cap).toString('utf8')}`)
            continue
          }
          if (VISUAL.has(type)) { add(label); continue }
          const buffer = Buffer.alloc(cap)
          const count = readSync(fd, buffer, 0, cap, 0)
          add(`${label}${count < length ? '，仅文件开头' : ''}\n${buffer.subarray(0, count).toString('utf8')}`)
        } finally { closeSync(fd) }
      } catch {
        signal.throwIfAborted()
        add(`${name}（读取失败）`)
      }
    }
  }
  await scan('.', 2)
  return samples.join('\n\n') || '工作目录中没有采集到可用的文件。'
}
