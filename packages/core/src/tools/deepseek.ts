import type { Json } from '@evoscholar/harness'
import { toolCostUsd } from '../pricing'
import { objectArgs, textResult, type ToolEnv, type ToolFactory } from './types'

const BASE = 'https://api.deepseek.com/v1/tools'

async function call(env: ToolEnv, kind: 'search' | 'fetch', body: Record<string, unknown>, signal: AbortSignal) {
  const key = process.env.DEEPSEEK_API_KEY
  if (!key) throw new Error('缺少 DEEPSEEK_API_KEY')
  signal.throwIfAborted()
  const category = env.category()
  const costUsd = category === 'usage' ? 0 : toolCostUsd(`deepseek/${kind}`)
  const reservation = category === 'usage' ? undefined : env.ledger.reserve({
    category, kind, provider: 'deepseek', sessionId: env.sessionId, genomeId: env.genomeId,
    units: 1, costUsd
  })
  let actual: { costUsd: number } | null | undefined
  try {
    const res = await fetch(`${BASE}/${kind}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      redirect: 'error'
    })
    if (!res.ok) {
      if (res.status < 500) actual = null
      return { ok: false as const, status: res.status, data: null }
    }
    const data = (await res.json()) as Record<string, unknown>
    const billable = kind === 'search' ? Array.isArray(data.results) && data.results.length > 0 : !!data.content
    actual = billable ? { costUsd } : null
    return { ok: true as const, status: res.status, data }
  } finally {
    reservation?.settle(actual)
  }
}

type SearchHit = { title: string; url: string; snippet?: string; summary?: string; content?: string; site_name?: string | null; date?: string | null; rerank_score?: number; authority?: number }

export function formatHits(hits: SearchHit[], withContent: boolean): string {
  if (!hits.length) return '没有搜索结果。'
  return hits
    .map((h, i) => {
      const meta = [h.site_name, h.date?.slice(0, 10), h.authority !== undefined && h.authority >= 0 ? `权威度 ${h.authority}/4` : null]
        .filter(Boolean)
        .join(' · ')
      const body = withContent && h.content ? h.content.slice(0, 4000) : (h.summary || h.snippet || '')
      return `[${i + 1}] ${h.title}\n${h.url}${meta ? `\n${meta}` : ''}\n${body}`
    })
    .join('\n\n')
}

export const deepseekSearch: ToolFactory = (env) => ({
  name: 'web_search',
  version: '1',
  description:
    '用 DeepSeek 搜索引擎检索网页，返回标题、链接、日期与摘要。支持 site:、-site:、"精确短语"、lang:、after:、before: 运算符。' +
    '检索知网或万方时用 site:cnki.net 或 site:wanfangdata.com.cn。query 不超过 128 字。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索词，1–128 字' },
      count: { type: 'integer', minimum: 1, maximum: 20, description: '返回条数，默认 8' },
      need_content: { type: 'boolean', description: '是否返回网页正文（更耗上下文），默认 false' }
    },
    required: ['query'],
    additionalProperties: false
  },
  scheduling: 'parallel',
  validate(input) {
    const a = objectArgs(input, ['query', 'count', 'need_content'], ['query'])
    if (typeof a.query !== 'string' || !a.query.trim() || [...a.query].length > 128) throw new Error('query must be 1–128 characters')
    if (a.count !== undefined && (!Number.isInteger(a.count) || (a.count as number) < 1 || (a.count as number) > 20)) throw new Error('count must be 1–20')
    if (a.need_content !== undefined && typeof a.need_content !== 'boolean') throw new Error('need_content must be boolean')
    return a as Json
  },
  authorize: async () => true,
  async execute(args, ctx) {
    const a = args as { query: string; count?: number; need_content?: boolean }
    const r = await call(env, 'search', { query: a.query, count: a.count ?? 8, need_content: a.need_content ?? false }, ctx.signal)
    if (!r.ok) return textResult(`搜索失败：HTTP ${r.status}`, true)
    return textResult(formatHits((r.data?.results as SearchHit[]) ?? [], !!a.need_content))
  }
})

export const deepseekFetch: ToolFactory = (env) => ({
  name: 'web_fetch',
  version: '1',
  description: '用 DeepSeek Fetch 读取一个网页，返回 Markdown 正文。能否读取取决于目标站点的访问策略。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http(s) 链接' },
      max_chars: { type: 'integer', minimum: 1000, maximum: 60000, description: '返回正文的最大字符数，默认 15000' }
    },
    required: ['url'],
    additionalProperties: false
  },
  scheduling: 'parallel',
  validate(input) {
    const a = objectArgs(input, ['url', 'max_chars'], ['url'])
    if (typeof a.url !== 'string') throw new Error('url must be a string')
    const u = new URL(a.url)
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new Error('Only plain http(s) URLs are allowed')
    if (a.max_chars !== undefined && (!Number.isInteger(a.max_chars) || (a.max_chars as number) < 1000 || (a.max_chars as number) > 60000)) throw new Error('max_chars must be 1000–60000')
    return a as Json
  },
  authorize: async () => true,
  async execute(args, ctx) {
    const a = args as { url: string; max_chars?: number }
    const r = await call(env, 'fetch', { url: a.url }, ctx.signal)
    if (!r.ok) return textResult(`读取失败：HTTP ${r.status}`, true)
    const content = String(r.data?.content ?? '')
    if (!content) return textResult('页面没有可读取的内容（可能被站点拒绝）。', true)
    const max = a.max_chars ?? 15000
    const title = String(r.data?.title ?? '')
    return textResult(`${title ? `# ${title}\n\n` : ''}${content.slice(0, max)}${content.length > max ? `\n\n…（已截断，原文 ${content.length} 字符）` : ''}`)
  }
})
