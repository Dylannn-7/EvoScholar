import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Json, ToolContext } from '@evoscholar/harness'
import { TOOL_FACTORIES, mergeWorks, titleSim, type ToolEnv, type Work } from './tools'

const ctx = (): ToolContext => ({ sessionId: 's', runId: 'r', invocationId: 'i', signal: new AbortController().signal, update() {} })
const env = () => ({ ws: { root: resolve(__dirname, '../../..'), dataDir: '/nonexistent', config: {} }, cwd: mkdtempSync(join(tmpdir(), 'lit-')), trace: () => {} }) as unknown as ToolEnv
const run = async (name: string, args: Record<string, unknown>) => {
  const t = TOOL_FACTORIES[name](env())
  return (await t.execute(t.validate(args as Json), ctx())) as { content: { text?: string }[]; isError?: boolean }
}
const txt = (r: { content: { text?: string }[] }) => r.content.map((c) => c.text ?? '').join('')

test('title similarity and cross-source merge', () => {
  assert.equal(titleSim('Photonic Tensor Cores.', 'photonic tensor cores'), 1)
  assert.ok(titleSim('Deep learning with coherent nanophotonic circuits', 'Deep Learning with Coherent Nanophotonic Circuit') > 0.93)
  const w = (o: Partial<Work>): Work => ({ title: '', authors: [], sources: [], ...o })
  const merged = mergeWorks([
    w({ title: 'Photonic tensor cores', arxiv: '2401.01234', venue: 'arXiv', doi: '10.48550/arxiv.2401.01234', sources: ['arxiv'], year: 2024 }),
    w({ title: 'Photonic Tensor Cores', doi: '10.1038/s41566-024-1', venue: 'Nature Photonics', sources: ['crossref'], year: 2025, citations: 12 }),
    w({ title: 'Other', sources: ['dblp'] })
  ])
  assert.equal(merged.length, 2)
  assert.equal(merged[0].doi, '10.1038/s41566-024-1')
  assert.equal(merged[0].venue, 'Nature Photonics')
  assert.deepEqual(merged[0].sources, ['arxiv', 'crossref'])
})

test('lit_search merges sources and tolerates a failing one; lit_verify flags fabricated refs', async () => {
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url)
    if (u.includes('semanticscholar')) return new Response('{}', { status: 429 })
    if (u.includes('export.arxiv.org'))
      return new Response(`<feed><entry><id>http://arxiv.org/abs/2401.01234v2</id><published>2024-01-03</published><title>Photonic Tensor Cores</title><summary>abc</summary><author><name>Yu Lin</name></author></entry></feed>`, { headers: { 'content-type': 'application/atom+xml' } })
    if (u.includes('api.crossref.org/works/'))
      return u.includes('10.9999') ? new Response('', { status: 404 }) : Response.json({ message: { DOI: '10.1038/S41566-024-1', title: ['Photonic tensor cores'], author: [{ given: 'Yu', family: 'Lin' }], issued: { 'date-parts': [[2025]] }, 'container-title': ['Nature Photonics'], 'updated-by': [] } })
    if (u.includes('api.crossref.org/works'))
      return Response.json({ message: { items: [{ DOI: '10.1038/s41566-024-1', title: ['Photonic tensor cores'], author: [{ given: 'Yu', family: 'Lin' }], issued: { 'date-parts': [[2025]] }, 'container-title': ['Nature Photonics'] }] } })
    if (u.includes('dblp')) return Response.json({ result: { hits: { hit: [] } } })
    if (u.includes('openreview')) return Response.json({ notes: [] })
    return new Response('', { status: 404 })
  }) as typeof fetch
  try {
    const s = txt(await run('lit_search', { query: 'photonic tensor cores' }))
    assert.match(s, /共 1 条/)
    assert.match(s, /10\.1038\/s41566-024-1/)
    assert.match(s, /semantic_scholar: semantic_scholar HTTP 429/)
    const v = txt(await run('lit_verify', { references: [
      { id: 'ok', doi: '10.1038/s41566-024-1', title: 'Photonic tensor cores', year: 2025 },
      { id: 'wrongyear', doi: 'https://doi.org/10.1038/S41566-024-1', year: 2019 },
      { id: 'fake', doi: '10.9999/made.up' }
    ] }))
    assert.match(v, /ok\tverified/)
    assert.match(v, /wrongyear\tmismatch/)
    assert.match(v, /fake\tnot_found/)
  } finally {
    globalThis.fetch = real
  }
})
