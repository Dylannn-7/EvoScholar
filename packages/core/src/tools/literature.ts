import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Json } from '@evoscholar/harness'
import { runLitHelper } from './exec'
import { setTimeout as delay } from 'node:timers/promises'
import { atomicWriteFile } from '../atomic-file'
import { MiB, readJson, readText } from '../http-body'
import { modelPath } from './sandbox'
import { objectArgs, textResult, type ToolEnv, type ToolFactory } from './types'

export type Work = {
  title: string
  authors: string[]
  year?: number
  venue?: string
  doi?: string
  arxiv?: string
  url?: string
  abstract?: string
  citations?: number
  oaPdf?: string
  type?: string
  sources: string[]
  retracted?: boolean
}

const UA = () => `EvoScholar/0.1 (https://github.com/Dylannn-7/EvoScholar${process.env.UNPAYWALL_EMAIL ? `; mailto:${process.env.UNPAYWALL_EMAIL}` : ''})`
export const normDoi = (s?: string | null) => {
  const m = /10\.\d{4,9}\/[^\s"<>{}]+/i.exec(String(s ?? '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, ''))
  return m ? m[0].replace(/[.,;:)\]}'"]+$/, '').toLowerCase() : undefined
}
export const normArxiv = (s?: string | null) => /(\d{4}\.\d{4,5})(v\d+)?/.exec(String(s ?? ''))?.[1]
export const titleKey = (t?: string) => (t ?? '').normalize('NFKC').toLowerCase().replace(/[^0-9a-z一-鿿]+/g, '')
/** Dice coefficient on character bigrams of the title keys (0..1). */
export function titleSim(a?: string, b?: string): number {
  const x = titleKey(a), y = titleKey(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const grams = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1) } return m }
  const gx = grams(x), gy = grams(y)
  let inter = 0
  for (const [g, n] of gx) inter += Math.min(n, gy.get(g) ?? 0)
  return (2 * inter) / (x.length - 1 + y.length - 1)
}
const strip = (s?: string) => (s ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

type Ctx = { env: ToolEnv; signal: AbortSignal }
async function getJson(ctx: Ctx, source: string, url: string, headers: Record<string, string> = {}): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA(), ...headers }, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20000)]) })
    ctx.env.trace?.({ kind: 'search', source, status: res.status })
    if (res.status === 429 && attempt === 0) {
      await res.body?.cancel().catch(() => {})
      await delay(1500, undefined, { signal: ctx.signal })
      continue
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`${source} HTTP ${res.status}`)
    }
    const type = res.headers.get('content-type') ?? ''
    return type.includes('json') ? readJson(res, 8 * MiB, `${source} 响应`) : readText(res, 8 * MiB, `${source} 响应`)
  }
}

const yearFilter = (w: Work, from?: number, to?: number) => (!from || (w.year ?? 0) >= from) && (!to || (w.year ?? 9999) <= to)

const SOURCES: Record<string, (ctx: Ctx, q: string, n: number, from?: number, to?: number) => Promise<Work[]>> = {
  async arxiv(ctx, q, n) {
    const xml: string = await getJson(ctx, 'arxiv', `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(`all:${q}`)}&start=0&max_results=${n}&sortBy=relevance`)
    return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
      const tag = (t: string) => decode(strip(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(e)?.[1]))
      const id = tag('id')
      return {
        title: tag('title'), authors: [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => strip(m[1])),
        year: Number(tag('published').slice(0, 4)) || undefined, venue: 'arXiv', arxiv: normArxiv(id),
        doi: normDoi(/<arxiv:doi[^>]*>([^<]+)</.exec(e)?.[1]), url: id, abstract: tag('summary').slice(0, 1200),
        oaPdf: id.replace('/abs/', '/pdf/'), sources: ['arxiv']
      }
    })
  },
  async crossref(ctx, q, n, from, to) {
    const f = [from && `from-pub-date:${from}`, to && `until-pub-date:${to}`].filter(Boolean).join(',')
    const j = await getJson(ctx, 'crossref', `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(q)}&rows=${n}${f ? `&filter=${f}` : ''}&select=DOI,title,author,issued,container-title,type,is-referenced-by-count,abstract,URL`)
    return (j.message?.items ?? []).map((it: any) => ({
      title: strip(it.title?.[0]), authors: (it.author ?? []).map((a: any) => [a.given, a.family].filter(Boolean).join(' ') || a.name),
      year: it.issued?.['date-parts']?.[0]?.[0], venue: it['container-title']?.[0], doi: normDoi(it.DOI), url: it.URL,
      abstract: strip(it.abstract).slice(0, 1200) || undefined, citations: it['is-referenced-by-count'], type: it.type, sources: ['crossref']
    }))
  },
  async dblp(ctx, q, n) {
    const j = await getJson(ctx, 'dblp', `https://dblp.org/search/publ/api?q=${encodeURIComponent(q)}&format=json&h=${n}`)
    const hits = j.result?.hits?.hit ?? []
    return hits.map((h: any) => {
      const i = h.info
      const au = i.authors?.author
      return {
        title: decode(strip(i.title)).replace(/\.$/, ''), authors: (Array.isArray(au) ? au : au ? [au] : []).map((a: any) => decode(String(a.text ?? a)).replace(/\s\d{4}$/, '')),
        year: Number(i.year) || undefined, venue: i.venue, doi: normDoi(i.doi), url: i.ee ?? i.url, type: i.type, sources: ['dblp']
      }
    })
  },
  async openreview(ctx, q, n) {
    const j = await getJson(ctx, 'openreview', `https://api2.openreview.net/notes/search?term=${encodeURIComponent(q)}&limit=${n}&source=forum`)
    return (j.notes ?? []).map((x: any) => ({
      title: x.content?.title?.value ?? '', authors: x.content?.authors?.value ?? [], venue: x.content?.venue?.value,
      year: x.pdate ? new Date(x.pdate).getUTCFullYear() : x.cdate ? new Date(x.cdate).getUTCFullYear() : undefined,
      url: `https://openreview.net/forum?id=${x.forum ?? x.id}`, abstract: String(x.content?.abstract?.value ?? '').slice(0, 1200) || undefined, sources: ['openreview']
    }))
  },
  async semantic_scholar(ctx, q, n, from, to) {
    const yr = from || to ? `&year=${from ?? ''}-${to ?? ''}` : ''
    const key = process.env.SEMANTIC_SCHOLAR_API_KEY
    const j = await getJson(ctx, 'semantic_scholar', `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=${n}${yr}&fields=title,authors,year,venue,externalIds,citationCount,openAccessPdf,abstract,url`, key ? { 'x-api-key': key } : {})
    return (j.data ?? []).map((p: any) => ({
      title: p.title, authors: (p.authors ?? []).map((a: any) => a.name), year: p.year, venue: p.venue || undefined,
      doi: normDoi(p.externalIds?.DOI), arxiv: p.externalIds?.ArXiv, url: p.url, citations: p.citationCount,
      oaPdf: p.openAccessPdf?.url || undefined, abstract: p.abstract?.slice(0, 1200) || undefined, sources: ['semantic_scholar']
    }))
  },
  async openalex(ctx, q, n, from, to) {
    const key = process.env.OPENALEX_API_KEY
    if (!key) throw new Error('openalex 需要免费 API Key（OPENALEX_API_KEY）')
    const f = from || to ? `&filter=publication_year:${from ?? ''}-${to ?? ''}` : ''
    const j = await getJson(ctx, 'openalex', `https://api.openalex.org/works?search=${encodeURIComponent(q)}&per_page=${n}${f}&api_key=${key}`)
    return (j.results ?? []).map((w: any) => ({
      title: w.title, authors: (w.authorships ?? []).map((a: any) => a.author?.display_name), year: w.publication_year,
      venue: w.primary_location?.source?.display_name, doi: normDoi(w.doi), url: w.id, citations: w.cited_by_count,
      oaPdf: w.best_oa_location?.pdf_url || undefined, sources: ['openalex']
    }))
  }
}
export const DEFAULT_SOURCES = ['arxiv', 'semantic_scholar', 'dblp', 'crossref', 'openreview']

/** Merge works from several sources by DOI, arXiv id, or near-identical title. */
export function mergeWorks(works: Work[]): Work[] {
  const out: Work[] = []
  for (const w of works) {
    const hit = out.find((o) => (w.doi && o.doi === w.doi) || (w.arxiv && o.arxiv === w.arxiv) || (titleSim(o.title, w.title) >= 0.93 && (!o.year || !w.year || Math.abs(o.year - w.year) <= 1)))
    if (!hit) { out.push({ ...w, sources: [...w.sources] }); continue }
    for (const k of ['doi', 'arxiv', 'venue', 'abstract', 'oaPdf', 'url', 'year', 'type'] as const) if (!hit[k] && w[k]) (hit as any)[k] = w[k]
    if (hit.venue === 'arXiv' && w.venue && w.venue !== 'arXiv') hit.venue = w.venue
    if (hit.doi?.startsWith('10.48550/') && w.doi && !w.doi.startsWith('10.48550/')) hit.doi = w.doi
    hit.citations = Math.max(hit.citations ?? 0, w.citations ?? 0) || undefined
    if (!hit.authors.length) hit.authors = w.authors
    for (const s of w.sources) if (!hit.sources.includes(s)) hit.sources.push(s)
  }
  return out
}

export function formatWork(w: Work, i: number): string {
  const au = w.authors.length > 3 ? `${w.authors.slice(0, 3).join(', ')} 等` : w.authors.join(', ')
  const ids = [w.doi && `DOI ${w.doi}`, w.arxiv && `arXiv ${w.arxiv}`].filter(Boolean).join(' · ')
  return `[${i + 1}] ${w.title}\n${au}${w.year ? ` (${w.year})` : ''}${w.venue ? ` · ${w.venue}` : ''}${w.citations ? ` · 被引 ${w.citations}` : ''}${w.retracted ? ' · ⚠ 已撤稿' : ''}\n${ids}${w.url ? `\n${w.url}` : ''}${w.oaPdf ? `\nPDF: ${w.oaPdf}` : ''}${w.abstract ? `\n摘要：${w.abstract.slice(0, 400)}` : ''}\n来源：${w.sources.join(', ')}`
}

export async function searchAll(ctx: Ctx, q: string, sources: string[], n: number, from?: number, to?: number) {
  const errors: string[] = []
  const results = await Promise.all(sources.map(async (s) => {
    try { return (await SOURCES[s](ctx, q, n, from, to)).filter((w) => w.title && yearFilter(w, from, to)) } catch (e) { errors.push(`${s}: ${(e as Error).message}`); return [] }
  }))
  return { works: mergeWorks(results.flat()), errors }
}

/** Canonical metadata for a DOI from Crossref, with retraction signals when Crossref exposes them. */
export async function lookupDoi(ctx: Ctx, doi: string): Promise<Work | null> {
  try {
    const j = await getJson(ctx, 'crossref', `https://api.crossref.org/works/${encodeURIComponent(doi)}`)
    const it = j.message
    const retracted = (it['updated-by'] ?? []).some((u: any) => /retract/i.test(u.type ?? '')) || !!it.relation?.['is-retracted-by'] || /^retracted/i.test(strip(it.title?.[0]))
    return {
      title: strip(it.title?.[0]), authors: (it.author ?? []).map((a: any) => [a.given, a.family].filter(Boolean).join(' ') || a.name),
      year: it.issued?.['date-parts']?.[0]?.[0], venue: it['container-title']?.[0], doi: normDoi(it.DOI), url: it.URL, type: it.type,
      citations: it['is-referenced-by-count'], retracted, sources: ['crossref']
    }
  } catch (e) {
    if (/HTTP 404/.test((e as Error).message)) return null
    throw e
  }
}
async function lookupArxiv(ctx: Ctx, id: string): Promise<Work | null> {
  const xml: string = await getJson(ctx, 'arxiv', `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`)
  if (!/<entry>/.test(xml) || /<title>Error<\/title>/.test(xml)) return null
  const e = /<entry>([\s\S]*?)<\/entry>/.exec(xml)![1]
  const tag = (t: string) => decode(strip(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(e)?.[1]))
  return { title: tag('title'), authors: [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => strip(m[1])), year: Number(tag('published').slice(0, 4)) || undefined, venue: 'arXiv', arxiv: normArxiv(id), doi: normDoi(/<arxiv:doi[^>]*>([^<]+)</.exec(e)?.[1]), url: tag('id'), sources: ['arxiv'] }
}
async function lookupTitle(ctx: Ctx, title: string, year?: number): Promise<{ work: Work; score: number } | null> {
  const { works } = await searchAll(ctx, title, ['crossref', 'arxiv', 'dblp'], 5)
  let best: { work: Work; score: number } | null = null
  for (const w of works) {
    let score = titleSim(title, w.title)
    if (year && w.year && Math.abs(year - w.year) > 1) score -= 0.15
    if (!best || score > best.score) best = { work: w, score }
  }
  return best
}

const intArg = (v: unknown, lo: number, hi: number, name: string) => {
  if (v !== undefined && (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi)) throw new Error(`${name} must be an integer ${lo}–${hi}`)
}

export const litSearch: ToolFactory = (env) => ({
  name: 'lit_search',
  version: '1',
  description:
    '在免费学术数据源中检索论文并按 DOI / arXiv / 题名自动去重合并。默认来源：arxiv、semantic_scholar、dblp、crossref、openreview；可选 openalex（需 Key）。' +
    'IEEE、Optica、SPIE 期刊经 crossref 覆盖。中文文献请用 web_search 加 site:cnki.net 或 site:wanfangdata.com.cn。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      sources: { type: 'array', items: { type: 'string', enum: Object.keys(SOURCES) } },
      year_from: { type: 'integer' },
      year_to: { type: 'integer' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: '每个来源的条数，默认 8' }
    },
    required: ['query'],
    additionalProperties: false
  },
  scheduling: 'parallel',
  validate(i) {
    const a = objectArgs(i, ['query', 'sources', 'year_from', 'year_to', 'limit'], ['query'])
    if (typeof a.query !== 'string' || !a.query.trim()) throw new Error('query required')
    if (a.sources !== undefined && (!Array.isArray(a.sources) || a.sources.some((s) => !(String(s) in SOURCES)))) throw new Error(`sources must be from ${Object.keys(SOURCES).join(', ')}`)
    intArg(a.limit, 1, 50, 'limit'); intArg(a.year_from, 1900, 2100, 'year_from'); intArg(a.year_to, 1900, 2100, 'year_to')
    return a as Json
  },
  authorize: async () => true,
  async execute(args, c) {
    const a = args as { query: string; sources?: string[]; year_from?: number; year_to?: number; limit?: number }
    const { works, errors } = await searchAll({ env, signal: c.signal }, a.query, a.sources ?? DEFAULT_SOURCES, a.limit ?? 8, a.year_from, a.year_to)
    works.sort((x, y) => y.sources.length - x.sources.length || (y.citations ?? 0) - (x.citations ?? 0))
    const save = !env.readOnly && (await env.approve?.('lit_search', '保存最近一次文献检索结果', 'edit', c.signal) ?? true)
    if (save) {
      c.signal.throwIfAborted()
      const file = modelPath(env, join('.evoscholar', 'last_search.json'))
      mkdirSync(dirname(file), { recursive: true })
      atomicWriteFile(file, JSON.stringify({ query: a, works }, null, 2))
    }
    const saved = save ? '；完整结果存于 .evoscholar/last_search.json' : ''
    const head = `共 ${works.length} 条（已合并去重${saved}）${errors.length ? `\n部分来源失败：${errors.join('；')}` : ''}`
    return textResult(`${head}\n\n${works.slice(0, 25).map(formatWork).join('\n\n')}`)
  }
})

export const litLookup: ToolFactory = (env) => ({
  name: 'lit_lookup',
  version: '1',
  description: '按 DOI、arXiv 号或题名查一篇论文的权威元数据（作者、年份、刊名、类型、被引、撤稿标记）。题名查找会给出相似度。',
  parameters: {
    type: 'object',
    properties: { doi: { type: 'string' }, arxiv: { type: 'string' }, title: { type: 'string' }, year: { type: 'integer' } },
    additionalProperties: false
  },
  scheduling: 'parallel',
  validate(i) {
    const a = objectArgs(i, ['doi', 'arxiv', 'title', 'year'])
    if (!a.doi && !a.arxiv && !a.title) throw new Error('Provide doi, arxiv or title')
    return a as Json
  },
  authorize: async () => true,
  async execute(args, c) {
    const a = args as { doi?: string; arxiv?: string; title?: string; year?: number }
    const ctx = { env, signal: c.signal }
    if (a.doi) {
      const d = normDoi(a.doi)
      if (!d) return textResult('DOI 格式无效', true)
      const w = await lookupDoi(ctx, d)
      return w ? textResult(formatWork(w, 0)) : textResult(`Crossref 中没有 DOI ${d}`, true)
    }
    if (a.arxiv) {
      const id = normArxiv(a.arxiv)
      const w = id ? await lookupArxiv(ctx, id) : null
      return w ? textResult(formatWork(w, 0)) : textResult(`arXiv 中没有 ${a.arxiv}`, true)
    }
    const best = await lookupTitle(ctx, a.title!, a.year)
    if (!best) return textResult('没有找到匹配的论文', true)
    return textResult(`题名相似度 ${best.score.toFixed(2)}${best.score < 0.85 ? '（偏低，可能不是同一篇）' : ''}\n${formatWork(best.work, 0)}`)
  }
})

type Ref = { id?: string; title?: string; doi?: string; year?: number; first_author?: string; arxiv?: string }
export const litVerify: ToolFactory = (env) => ({
  name: 'lit_verify',
  version: '1',
  description:
    '逐条核验参考文献是否真实存在、元数据是否一致、是否撤稿。传 references 数组，或传工作目录内的 .bib / .ris / GB/T 7714 文本文件路径。' +
    '结果：verified（一致）、mismatch（存在但字段不符）、not_found（查不到，可能编造）、retracted（已撤稿）。',
  parameters: {
    type: 'object',
    properties: {
      references: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, doi: { type: 'string' }, arxiv: { type: 'string' }, year: { type: 'integer' }, first_author: { type: 'string' } } } },
      file: { type: 'string' }
    },
    additionalProperties: false
  },
  scheduling: 'parallel',
  validate(i) {
    const a = objectArgs(i, ['references', 'file'])
    if (!a.references === !a.file) throw new Error('Provide exactly one of references or file')
    if (a.references && (!Array.isArray(a.references) || a.references.length > 200)) throw new Error('references must be an array (≤200)')
    return a as Json
  },
  authorize: async () => true,
  async execute(args, c) {
    const a = args as { references?: Ref[]; file?: string }
    let refs: Ref[] = a.references ?? []
    if (a.file) {
      const parsed = JSON.parse(await runLitHelper(env, ['parse', modelPath(env, a.file)], c.signal)) as { records: any[] }
      refs = parsed.records.map((r, i) => ({ id: r.key ?? String(i + 1), title: r.title, doi: r.doi, year: r.year, first_author: r.authors?.[0], arxiv: r.eprint }))
    }
    const ctx = { env, signal: c.signal }
    const rows: { id: string; status: string; note: string; matched?: Work }[] = []
    const queue = refs.map((r, i) => ({ r, i }))
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const { r, i } = job
        const id = r.id ?? String(i + 1)
        try {
          let w: Work | null = null
          let note = ''
          if (r.doi && normDoi(r.doi)) w = await lookupDoi(ctx, normDoi(r.doi)!)
          else if (r.arxiv && normArxiv(r.arxiv)) w = await lookupArxiv(ctx, normArxiv(r.arxiv)!)
          else if (r.title) { const b = await lookupTitle(ctx, r.title, r.year); if (b && b.score >= 0.85) w = b.work; else note = b ? `最相近：${b.work.title}（相似度 ${b.score.toFixed(2)}）` : '' }
          if (!w) { rows.push({ id, status: 'not_found', note: note || '数据库中查不到' }); continue }
          const issues: string[] = []
          if (r.title && titleSim(r.title, w.title) < 0.85) issues.push(`题名不符：库中为「${w.title}」`)
          if (r.year && w.year && Math.abs(r.year - w.year) > 1) issues.push(`年份不符：库中为 ${w.year}`)
          if (r.first_author && w.authors[0] && titleKey(w.authors[0]).indexOf(titleKey(r.first_author.split(/[ ,]/).filter(Boolean).sort((x, y) => y.length - x.length)[0])) < 0) issues.push(`第一作者可能不符：库中为 ${w.authors[0]}`)
          rows.push({ id, status: w.retracted ? 'retracted' : issues.length ? 'mismatch' : 'verified', note: issues.join('；'), matched: w })
        } catch (e) {
          rows.push({ id, status: 'error', note: (e as Error).message })
        }
      }
    }
    await Promise.all([worker(), worker(), worker()])
    rows.sort((x, y) => refs.findIndex((r, i) => (r.id ?? String(i + 1)) === x.id) - refs.findIndex((r, i) => (r.id ?? String(i + 1)) === y.id))
    env.trace?.({ kind: 'verify', total: rows.length, verified: rows.filter((r) => r.status === 'verified').length })
    const count = (s: string) => rows.filter((r) => r.status === s).length
    const lines = rows.map((r) => `${r.id}\t${r.status}${r.matched?.doi ? `\t${r.matched.doi}` : ''}${r.note ? `\t${r.note}` : ''}`)
    return textResult(`核验 ${rows.length} 条：verified ${count('verified')}，mismatch ${count('mismatch')}，not_found ${count('not_found')}，retracted ${count('retracted')}，error ${count('error')}\n${lines.join('\n')}`)
  }
})

export const pdfText: ToolFactory = (env) => ({
  name: 'pdf_text',
  version: '1',
  description: '按页提取 PDF 文字（带页码）。没有文字层的扫描页会被标出，请用 pdf_page_image 把那一页渲染成图片后直接看图识别。',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, pages: { type: 'array', items: { type: 'integer', minimum: 1 }, description: '只取这些页，默认全部' } },
    required: ['path'],
    additionalProperties: false
  },
  scheduling: 'parallel',
  validate: (i) => objectArgs(i, ['path', 'pages'], ['path']) as Json,
  authorize: async () => true,
  async execute(args, c) {
    const a = args as { path: string; pages?: number[] }
    const file = modelPath(env, a.path)
    if (!existsSync(file)) return textResult(`文件不存在：${a.path}`, true)
    const pages = JSON.parse(await runLitHelper(env, ['pages', file, (a.pages ?? []).join(',')], c.signal)) as { page: number; text: string; has_text: boolean }[]
    let out = `${basename(file)}：${pages.length} 页`
    const scanned = pages.filter((p) => !p.has_text).map((p) => p.page)
    if (scanned.length) out += `；无文字层（扫描）页：${scanned.join(', ')}`
    for (const p of pages) out += `\n\n=== 第 ${p.page} 页 ===\n${p.text.trim()}`
    return textResult(out.length > 80000 ? out.slice(0, 80000) + '\n…（已截断，请用 pages 参数分页读取）' : out)
  }
})

export const pdfPageImage: ToolFactory = (env) => ({
  name: 'pdf_page_image',
  version: '1',
  description: '把 PDF 的某一页渲染成图片交给你直接查看（用于扫描版 PDF、图表、公式或版式检查）。',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, page: { type: 'integer', minimum: 1 }, dpi: { type: 'integer', minimum: 60, maximum: 220 } },
    required: ['path', 'page'],
    additionalProperties: false
  },
  scheduling: 'parallel',
  validate: (i) => objectArgs(i, ['path', 'page', 'dpi'], ['path', 'page']) as Json,
  authorize: async (args, ctx) => env.approve?.('pdf_page_image', `渲染 ${(args as { path: string }).path} 的页面`, 'edit', ctx.signal) ?? true,
  async execute(args, c) {
    const a = args as { path: string; page: number; dpi?: number }
    const file = modelPath(env, a.path)
    const out = modelPath(env, join('.evoscholar', 'pages', `${basename(file, '.pdf')}-p${a.page}.png`))
    mkdirSync(dirname(out), { recursive: true })
    await runLitHelper(env, ['render', file, String(a.page), out, String(a.dpi ?? 130)], c.signal)
    return { content: [{ type: 'text', text: `${basename(file)} 第 ${a.page} 页：` }, { type: 'image', mimeType: 'image/png', source: `data:image/png;base64,${readFileSync(out).toString('base64')}`, filename: basename(out) }] }
  }
})

export const litImport: ToolFactory = (env) => ({
  name: 'lit_import',
  version: '1',
  description: '导入题录文件（知网 / 万方导出的 RIS、NoteExpress、EndNote、GB/T 7714 文本，或 BibTeX），自动识别格式，输出规范化记录并保存为 JSON。',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, save_as: { type: 'string', description: '保存规范化记录的 JSON 路径，默认 <原文件名>.records.json' } },
    required: ['path'],
    additionalProperties: false
  },
  scheduling: 'exclusive',
  validate: (i) => objectArgs(i, ['path', 'save_as'], ['path']) as Json,
  authorize: async (args, ctx) => env.approve?.('lit_import', `保存 ${(args as { path: string }).path} 的规范化题录`, 'edit', ctx.signal) ?? true,
  async execute(args, c) {
    const a = args as { path: string; save_as?: string }
    const file = modelPath(env, a.path)
    const r = JSON.parse(await runLitHelper(env, ['parse', file], c.signal)) as { format: string; records: any[] }
    const target = modelPath(env, a.save_as ?? `${a.path.replace(/\.[^.]+$/, '')}.records.json`)
    atomicWriteFile(target, JSON.stringify(r.records, null, 2))
    const bad = r.records.filter((x) => x.parse_error).length
    const preview = r.records.slice(0, 10).map((x, i) => `${i + 1}. ${x.title ?? x.raw}${x.year ? ` (${x.year})` : ''}${x.venue ? ` · ${x.venue}` : ''}${x.doi ? ` · ${x.doi}` : ''}`).join('\n')
    return textResult(`格式：${r.format}，共 ${r.records.length} 条${bad ? `（${bad} 条未能解析）` : ''}，已保存到 ${a.save_as ?? target.slice(env.cwd.length + 1)}\n${preview}`)
  }
})
