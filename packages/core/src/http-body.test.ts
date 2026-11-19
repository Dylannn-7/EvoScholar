import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Json, ToolContext } from '@evoscholar/harness'
import { MiB, readJson, readText } from './http-body'
import { TOOL_FACTORIES, type ToolEnv } from './tools'

const stream = (chunks: number, size: number) => new ReadableStream<Uint8Array>({
  start(controller) {
    for (let i = 0; i < chunks; i++) controller.enqueue(new Uint8Array(size).fill(97))
    controller.close()
  }
})

test('bounded reads stop at the declared or streamed size and reject invalid JSON', async () => {
  assert.equal(await readText(new Response('你好'), 1024), '你好')
  assert.deepEqual(await readJson(new Response('{"a":1}'), 1024), { a: 1 })
  await assert.rejects(readText(new Response('x', { headers: { 'content-length': String(2 * MiB) } }), MiB, '模型列表'), /模型列表超过 1 MB/)
  // No content-length: the limit applies while streaming.
  await assert.rejects(readText(new Response(stream(5, 300 * 1024)), MiB), /超过 1 MB/)
  assert.equal((await readText(new Response(stream(3, 300 * 1024)), MiB)).length, 900 * 1024)
  await assert.rejects(readJson(new Response('<html>'), 1024, '模型列表'), /不是有效的 JSON/)
})

test('literature rate-limit backoff ends as soon as the turn is cancelled', async () => {
  const real = globalThis.fetch
  globalThis.fetch = (async () => new Response('{}', { status: 429 })) as typeof fetch
  try {
    const env = { ws: { root: resolve(__dirname, '../../..'), dataDir: '/nonexistent', config: {} }, cwd: mkdtempSync(join(tmpdir(), 'lit-')), trace: () => {} } as unknown as ToolEnv
    const tool = TOOL_FACTORIES.lit_search(env)
    const controller = new AbortController()
    const ctx: ToolContext = { sessionId: 's', runId: 'r', invocationId: 'i', signal: controller.signal, update() {} }
    setTimeout(() => controller.abort(), 100)
    const started = Date.now()
    await tool.execute(tool.validate({ query: 'photonic', sources: ['crossref'] } as Json), ctx).catch(() => {})
    assert.ok(Date.now() - started < 1000, 'backoff ignored the abort signal')
  } finally {
    globalThis.fetch = real
  }
})
