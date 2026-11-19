import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ContentBlock, ModelEvent, ModelRequest } from '@evoscholar/harness'
import { createChatCompletionsModel } from '@evoscholar/harness/chat-completions'
import { createMessagesModel } from '@evoscholar/harness/messages'
import { createResponsesModel } from '@evoscholar/harness/responses'
import { createGeminiModel, createModel, type AuthHeader, type EvoConfig, type Protocol } from './index'

const sse = (events: unknown[], done = false) =>
  new Response(
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''),
    { headers: { 'content-type': 'text/event-stream' } }
  )

async function drain(it: AsyncIterable<ModelEvent>) {
  const out: ModelEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

const TOOLS: ModelRequest['tools'] = [
  { name: 'read_file', version: '1', description: 'Read file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'calc_stats', version: '1', description: 'Compute stats', parameters: { type: 'object', properties: { column: { type: 'string' } } } }
]

const PNG_DATA = 'data:image/png;base64,iVBORw0KGgo='
const PDF_DATA = 'data:application/pdf;base64,JVBERi0xLjQK'

const MIXED_ATTACHMENTS: ContentBlock[] = [
  { type: 'text', text: '请同时检查图片与 PDF 附件' },
  { type: 'image', mimeType: 'image/png', source: PNG_DATA, filename: 'fig1.png' },
  { type: 'file', mimeType: 'application/pdf', source: PDF_DATA, filename: 'paper.pdf' }
]

test('Chat Completions: parallel tool correlation, length truncation, and mixed attachments', async () => {
  const bodies: Record<string, any>[] = []
  let step = 0
  const fetchMock = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    step++
    if (step === 1) {
      return sse([
        { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [
          { index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":' } },
          { index: 1, id: 'call_b', type: 'function', function: { name: 'calc_stats', arguments: '{"column":' } }
        ] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { tool_calls: [
          { index: 0, function: { arguments: '"a.csv"}' } },
          { index: 1, function: { arguments: '"temp"}' } }
        ] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 40, completion_tokens: 15 } }
      ], true)
    }
    if (step === 2) {
      return sse([
        { choices: [{ index: 0, delta: { content: '完成汇总' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 60, completion_tokens: 8 } }
      ], true)
    }
    // Step 3: length-truncated incomplete tool call must be discarded cleanly.
    return sse([
      { choices: [{ index: 0, delta: { content: '正在调用', tool_calls: [
        { index: 0, id: 'call_cut', type: 'function', function: { name: 'read_file', arguments: '{"path":"trunc' } }
      ] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } }
    ], true)
  }) as unknown as typeof fetch

  const model = createChatCompletionsModel({
    endpoint: 'https://chat.example/v1/chat/completions', model: 'm-chat', apiKey: () => 'k',
    fetch: fetchMock, inputCapabilities: { images: true, files: true }
  })
  const baseReq: ModelRequest = {
    requestId: 'c1', instructions: 'sys', maxOutputTokens: 256, tools: TOOLS,
    messages: [{ id: 'u1', role: 'user', content: MIXED_ATTACHMENTS }]
  }

  const ev1 = await drain(model.stream(baseReq, new AbortController().signal))
  const fin1 = ev1.at(-1) as Extract<ModelEvent, { type: 'finish' }>
  assert.equal(fin1.reason, 'tools')
  assert.deepEqual(fin1.calls, [
    { id: 'call_a', name: 'read_file', arguments: { path: 'a.csv' } },
    { id: 'call_b', name: 'calc_stats', arguments: { column: 'temp' } }
  ])
  // Verify mixed attachments encoding in Turn 1 request.
  const userContent = bodies[0].messages[1].content
  assert.equal(userContent[0].type, 'text')
  assert.deepEqual(userContent[1], { type: 'image_url', image_url: { url: PNG_DATA } })
  assert.deepEqual(userContent[2], { type: 'file', file: { file_data: PDF_DATA, filename: 'paper.pdf' } })

  // Turn 2: parallel tool results correlated back by call IDs.
  const ev2 = await drain(model.stream({
    ...baseReq,
    requestId: 'c2',
    messages: [
      ...baseReq.messages,
      { id: 'a1', role: 'assistant', content: [], calls: fin1.calls },
      { id: 't1', role: 'tool', invocationId: 'a1/call_a', content: [{ type: 'text', text: 'rows=10' }] },
      { id: 't2', role: 'tool', invocationId: 'a1/call_b', content: [{ type: 'text', text: 'mean=25.4' }] }
    ]
  }, new AbortController().signal))
  assert.equal((ev2.at(-1) as Extract<ModelEvent, { type: 'finish' }>).reason, 'complete')
  const toolMsgs = bodies[1].messages.filter((m: { role: string }) => m.role === 'tool')
  assert.deepEqual(toolMsgs.map((m: { tool_call_id: string; content: string }) => [m.tool_call_id, m.content]), [
    ['call_a', 'rows=10'],
    ['call_b', 'mean=25.4']
  ])

  // Turn 3: length-truncated tool call is discarded.
  const ev3 = await drain(model.stream({ ...baseReq, requestId: 'c3' }, new AbortController().signal))
  const fin3 = ev3.at(-1) as Extract<ModelEvent, { type: 'finish' }>
  assert.equal(fin3.reason, 'length')
  assert.equal(fin3.calls, undefined)
})

test('Messages: parallel tool correlation, length truncation, and mixed attachments', async () => {
  const bodies: Record<string, any>[] = []
  let step = 0
  const fetchMock = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    step++
    if (step === 1) {
      return sse([
        { type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'read_file', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a.csv"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_2', name: 'calc_stats', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"column":"temp"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 18 } },
        { type: 'message_stop' }
      ])
    }
    if (step === 2) {
      return sse([
        { type: 'message_start', message: { usage: { input_tokens: 70, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '汇总完毕' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
        { type: 'message_stop' }
      ])
    }
    // Step 3: length-truncated tool call (stop_reason = max_tokens) must discard unfinished tool_use.
    return sse([
      { type: 'message_start', message: { usage: { input_tokens: 30, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '部分文本' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_cut', name: 'read_file', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"cut' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 12 } },
      { type: 'message_stop' }
    ])
  }) as unknown as typeof fetch

  const model = createMessagesModel({
    endpoint: 'https://messages.example/v1/messages', model: 'm-msg', apiKey: () => 'k',
    fetch: fetchMock, inputCapabilities: { images: true, files: true }
  })
  const baseReq: ModelRequest = {
    requestId: 'm1', instructions: 'sys', maxOutputTokens: 256, tools: TOOLS,
    messages: [{ id: 'u1', role: 'user', content: MIXED_ATTACHMENTS }]
  }

  const ev1 = await drain(model.stream(baseReq, new AbortController().signal))
  const fin1 = ev1.at(-1) as Extract<ModelEvent, { type: 'finish' }>
  assert.equal(fin1.reason, 'tools')
  assert.deepEqual(fin1.calls, [
    { id: 'tu_1', name: 'read_file', arguments: { path: 'a.csv' } },
    { id: 'tu_2', name: 'calc_stats', arguments: { column: 'temp' } }
  ])
  const userContent = bodies[0].messages[0].content
  assert.equal(userContent[0].type, 'text')
  assert.deepEqual(userContent[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } })
  assert.deepEqual(userContent[2], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQK' } })

  // Turn 2: parallel tool_result blocks grouped in a single user message.
  const ev2 = await drain(model.stream({
    ...baseReq,
    requestId: 'm2',
    messages: [
      ...baseReq.messages,
      { id: 'a1', role: 'assistant', content: [], calls: fin1.calls },
      { id: 't1', role: 'tool', invocationId: 'a1/tu_1', content: [{ type: 'text', text: 'rows=10' }] },
      { id: 't2', role: 'tool', invocationId: 'a1/tu_2', isError: true, content: [{ type: 'text', text: 'missing column' }] }
    ]
  }, new AbortController().signal))
  assert.equal((ev2.at(-1) as Extract<ModelEvent, { type: 'finish' }>).reason, 'complete')
  const toolTurn = bodies[1].messages[2]
  assert.equal(toolTurn.role, 'user')
  assert.equal(toolTurn.content.length, 2)
  assert.equal(toolTurn.content[0].tool_use_id, 'tu_1')
  assert.equal(toolTurn.content[1].tool_use_id, 'tu_2')
  assert.equal(toolTurn.content[1].is_error, true)

  // Turn 3: length-truncated tool_use is discarded.
  const ev3 = await drain(model.stream({ ...baseReq, requestId: 'm3' }, new AbortController().signal))
  const fin3 = ev3.at(-1) as Extract<ModelEvent, { type: 'finish' }>
  assert.equal(fin3.reason, 'length')
  assert.equal(fin3.calls, undefined)
})

test('Responses: parallel tool correlation, length truncation, and mixed attachments', async () => {
  const bodies: Record<string, any>[] = []
  let step = 0
  const fetchMock = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    step++
    if (step === 1) {
      return sse([
        { type: 'response.created', response: { id: 'resp_1' } },
        { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_item_1', call_id: 'call_r1', name: 'read_file' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_item_1', delta: '{"path":"a.csv"}' },
        { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_item_2', call_id: 'call_r2', name: 'calc_stats' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_item_2', delta: '{"column":"temp"}' },
        { type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 45, output_tokens: 14 } } }
      ])
    }
    if (step === 2) {
      return sse([
        { type: 'response.created', response: { id: 'resp_2' } },
        { type: 'response.output_text.delta', delta: '完成' },
        { type: 'response.completed', response: { id: 'resp_2', usage: { input_tokens: 65, output_tokens: 6 } } }
      ])
    }
    // Step 3: response.incomplete due to max_output_tokens must discard incomplete function_call.
    return sse([
      { type: 'response.created', response: { id: 'resp_3' } },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_cut', call_id: 'call_cut', name: 'read_file' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_cut', delta: '{"path":"cut' },
      { type: 'response.incomplete', response: { id: 'resp_3', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 25, output_tokens: 10 } } }
    ])
  }) as unknown as typeof fetch

  const model = createResponsesModel({
    endpoint: 'https://responses.example/v1/responses', model: 'm-resp', apiKey: () => 'k',
    fetch: fetchMock, inputCapabilities: { images: true, files: true }
  })
  const baseReq: ModelRequest = {
    requestId: 'r1', instructions: 'sys', maxOutputTokens: 256, tools: TOOLS,
    messages: [{ id: 'u1', role: 'user', content: MIXED_ATTACHMENTS }]
  }

  const ev1 = await drain(model.stream(baseReq, new AbortController().signal))
  const fin1 = ev1.at(-1) as Extract<ModelEvent, { type: 'finish' }>
  assert.equal(fin1.reason, 'tools')
  assert.deepEqual(fin1.calls, [
    { id: 'call_r1', name: 'read_file', arguments: { path: 'a.csv' } },
    { id: 'call_r2', name: 'calc_stats', arguments: { column: 'temp' } }
  ])
  const userContent = bodies[0].input[0].content
  assert.equal(userContent[0].type, 'input_text')
  assert.deepEqual(userContent[1], { type: 'input_image', image_url: PNG_DATA })
  assert.deepEqual(userContent[2], { type: 'input_file', file_data: PDF_DATA, filename: 'paper.pdf' })

  // Turn 2: function_call_output items correlate both parallel calls.
  const ev2 = await drain(model.stream({
    ...baseReq,
    requestId: 'r2',
    messages: [
      ...baseReq.messages,
      { id: 'a1', role: 'assistant', content: [], calls: fin1.calls },
      { id: 't1', role: 'tool', invocationId: 'a1/call_r1', content: [{ type: 'text', text: 'rows=10' }] },
      { id: 't2', role: 'tool', invocationId: 'a1/call_r2', content: [{ type: 'text', text: 'mean=25.4' }] }
    ]
  }, new AbortController().signal))
  assert.equal((ev2.at(-1) as Extract<ModelEvent, { type: 'finish' }>).reason, 'complete')
  const outputs = bodies[1].input.filter((it: { type?: string }) => it.type === 'function_call_output')
  assert.deepEqual(outputs, [
    { type: 'function_call_output', call_id: 'call_r1', output: 'rows=10' },
    { type: 'function_call_output', call_id: 'call_r2', output: 'mean=25.4' }
  ])

  // Turn 3: incomplete response discards truncated function_call.
  const ev3 = await drain(model.stream({ ...baseReq, requestId: 'r3' }, new AbortController().signal))
  const fin3 = ev3.at(-1) as Extract<ModelEvent, { type: 'finish' }>
  assert.equal(fin3.reason, 'length')
  assert.equal(fin3.calls, undefined)
})

test('Gemini: parallel tool correlation, multi-segment thought signatures across turns, length truncation, and mixed attachments', async () => {
  const bodies: Record<string, any>[] = []
  let step = 0
  const fetchMock = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    step++
    if (step === 1) {
      return sse([
        { candidates: [{ content: { parts: [
          { text: '第一段思考', thought: true, thoughtSignature: 'SIG_T1' },
          { text: '第二段思考', thought: true, thoughtSignature: 'SIG_T2' }
        ] } }] },
        { candidates: [{ content: { parts: [
          { functionCall: { id: 'gfc_1', name: 'read_file', args: { path: 'a.csv' } }, thoughtSignature: 'SIG_FC1' },
          { functionCall: { id: 'gfc_2', name: 'calc_stats', args: { column: 'temp' } }, thoughtSignature: 'SIG_FC2' }
        ] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 10, thoughtsTokenCount: 15 } }
      ])
    }
    if (step === 2) {
      return sse([
        { candidates: [{ content: { parts: [
          { text: '综合思考', thought: true, thoughtSignature: 'SIG_T3' },
          { text: '结论第一段。', thoughtSignature: 'SIG_OUT1' },
          { text: '结论第二段。', thoughtSignature: 'SIG_OUT2' }
        ] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 110, candidatesTokenCount: 12, thoughtsTokenCount: 6 } }
      ])
    }
    if (step === 3) {
      return sse([
        { candidates: [{ content: { parts: [{ text: '后续回答' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 130, candidatesTokenCount: 4 } }
      ])
    }
    // Step 4: MAX_TOKENS truncates function call and discards it.
    return sse([
      { candidates: [{ content: { parts: [
        { text: '截断前文本' },
        { functionCall: { id: 'gfc_cut', name: 'read_file', args: { path: 'cut' } } }
      ] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 20 } }
    ])
  }) as unknown as typeof fetch

  const model = createGeminiModel({
    baseUrl: 'https://gemini.example/v1beta', model: 'gemini-3-pro-preview', apiKey: () => 'g-key',
    fetch: fetchMock, inputCapabilities: { images: true, files: true }
  })
  assert.equal(model.capabilities.images, true)
  assert.equal(model.capabilities.files, true)
  const baseReq: ModelRequest = {
    requestId: 'g1', instructions: 'sys', maxOutputTokens: 512, tools: TOOLS,
    messages: [{ id: 'u1', role: 'user', content: MIXED_ATTACHMENTS }]
  }

  // Turn 1: mixed attachments + multi-segment thoughts + parallel functionCalls.
  const ev1 = await drain(model.stream(baseReq, new AbortController().signal))
  const fin1 = ev1.at(-1) as Extract<ModelEvent, { type: 'finish' }>
  assert.equal(fin1.reason, 'tools')
  assert.deepEqual(fin1.calls, [
    { id: 'gfc_1', name: 'read_file', arguments: { path: 'a.csv' } },
    { id: 'gfc_2', name: 'calc_stats', arguments: { column: 'temp' } }
  ])
  assert.deepEqual(bodies[0].contents[0].parts, [
    { text: '请同时检查图片与 PDF 附件' },
    { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
    { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0xLjQK' } }
  ])

  // Turn 2: replays multi-segment thought signatures + both parallel functionCalls & functionResponses.
  const a1Msg = { id: 'a1', role: 'assistant' as const, content: fin1.content, calls: fin1.calls, providerState: { adapterId: model.id, value: fin1.providerState! } }
  const t1Msg = { id: 't1', role: 'tool' as const, invocationId: 'a1/gfc_1', content: [{ type: 'text' as const, text: 'rows=10' }] }
  const t2Msg = { id: 't2', role: 'tool' as const, invocationId: 'a1/gfc_2', content: [{ type: 'text' as const, text: 'mean=25.4' }] }
  const ev2 = await drain(model.stream({ ...baseReq, requestId: 'g2', messages: [...baseReq.messages, a1Msg, t1Msg, t2Msg] }, new AbortController().signal))
  const fin2 = ev2.at(-1) as Extract<ModelEvent, { type: 'finish' }>
  assert.equal(fin2.reason, 'complete')
  assert.deepEqual(bodies[1].contents[1].parts, [
    { text: '第一段思考', thought: true, thoughtSignature: 'SIG_T1' },
    { text: '第二段思考', thought: true, thoughtSignature: 'SIG_T2' },
    { functionCall: { id: 'gfc_1', name: 'read_file', args: { path: 'a.csv' } }, thoughtSignature: 'SIG_FC1' },
    { functionCall: { id: 'gfc_2', name: 'calc_stats', args: { column: 'temp' } }, thoughtSignature: 'SIG_FC2' }
  ])
  assert.deepEqual(bodies[1].contents[2].parts, [
    { functionResponse: { id: 'gfc_1', name: 'read_file', response: { content: 'rows=10' } } },
    { functionResponse: { id: 'gfc_2', name: 'calc_stats', response: { content: 'mean=25.4' } } }
  ])

  // Turn 3: replays Turn 1 AND Turn 2 multi-segment thought & text signatures across turns.
  const a2Msg = { id: 'a2', role: 'assistant' as const, content: fin2.content, providerState: { adapterId: model.id, value: fin2.providerState! } }
  const u2Msg = { id: 'u2', role: 'user' as const, content: [{ type: 'text' as const, text: '继续说明' }] }
  await drain(model.stream({ ...baseReq, requestId: 'g3', messages: [...baseReq.messages, a1Msg, t1Msg, t2Msg, a2Msg, u2Msg] }, new AbortController().signal))
  assert.deepEqual(bodies[2].contents[3].parts, [
    { text: '综合思考', thought: true, thoughtSignature: 'SIG_T3' },
    { text: '结论第一段。', thoughtSignature: 'SIG_OUT1' },
    { text: '结论第二段。', thoughtSignature: 'SIG_OUT2' }
  ])

  // Turn 4: MAX_TOKENS discards incomplete functionCall.
  const ev4 = await drain(model.stream({ ...baseReq, requestId: 'g4' }, new AbortController().signal))
  const fin4 = ev4.at(-1) as Extract<ModelEvent, { type: 'finish' }>
  assert.equal(fin4.reason, 'length')
  assert.equal(fin4.calls, undefined)
})

test('all four protocols honour non-default auth headers (Azure api-key and alternate header styles)', async (t) => {
  const keyEnv = 'PROTO_FIXTURE_API_KEY'
  const prev = process.env[keyEnv]
  process.env[keyEnv] = 'secret-fixture-token'
  t.after(() => {
    if (prev === undefined) delete process.env[keyEnv]
    else process.env[keyEnv] = prev
  })

  const cases: { protocol: Protocol; authHeader?: AuthHeader; expectedHeader: string; expectedValue: string; forbidden: string[] }[] = [
    { protocol: 'chat-completions', authHeader: 'api-key', expectedHeader: 'api-key', expectedValue: 'secret-fixture-token', forbidden: ['authorization', 'x-api-key', 'x-goog-api-key'] },
    { protocol: 'chat-completions', authHeader: 'x-api-key', expectedHeader: 'x-api-key', expectedValue: 'secret-fixture-token', forbidden: ['authorization', 'api-key', 'x-goog-api-key'] },
    { protocol: 'messages', authHeader: 'api-key', expectedHeader: 'api-key', expectedValue: 'secret-fixture-token', forbidden: ['authorization', 'x-api-key', 'x-goog-api-key'] },
    { protocol: 'messages', authHeader: 'bearer', expectedHeader: 'authorization', expectedValue: 'Bearer secret-fixture-token', forbidden: ['x-api-key', 'api-key', 'x-goog-api-key'] },
    { protocol: 'responses', authHeader: 'api-key', expectedHeader: 'api-key', expectedValue: 'secret-fixture-token', forbidden: ['authorization', 'x-api-key', 'x-goog-api-key'] },
    { protocol: 'responses', authHeader: 'x-goog-api-key', expectedHeader: 'x-goog-api-key', expectedValue: 'secret-fixture-token', forbidden: ['authorization', 'api-key', 'x-api-key'] },
    { protocol: 'gemini', authHeader: 'api-key', expectedHeader: 'api-key', expectedValue: 'secret-fixture-token', forbidden: ['authorization', 'x-api-key', 'x-goog-api-key'] },
    { protocol: 'gemini', authHeader: 'bearer', expectedHeader: 'authorization', expectedValue: 'Bearer secret-fixture-token', forbidden: ['x-goog-api-key', 'api-key', 'x-api-key'] },
    // No explicit choice: Anthropic-compatible gateways keep receiving the adapter's x-api-key.
    { protocol: 'messages', expectedHeader: 'x-api-key', expectedValue: 'secret-fixture-token', forbidden: ['authorization', 'api-key', 'x-goog-api-key'] }
  ]

  const okResponseFor = (protocol: Protocol) => {
    if (protocol === 'chat-completions') return sse([
      { choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } }
    ], true)
    if (protocol === 'messages') return sse([
      { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' }
    ])
    if (protocol === 'responses') return sse([
      { type: 'response.created', response: { id: 'resp_auth' } },
      { type: 'response.output_text.delta', delta: 'OK' },
      { type: 'response.completed', response: { id: 'resp_auth', usage: { input_tokens: 5, output_tokens: 1 } } }
    ])
    return sse([{ candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } }])
  }

  for (const c of cases) {
    const base = 'https://gateway.example/v1'
    const config = {
      providers: {
        fixture: {
          custom: true,
          protocol: c.protocol,
          baseUrl: base,
          ...(c.authHeader ? { authHeader: c.authHeader } : {}),
          apiKeyEnv: keyEnv,
          credentialOrigin: 'https://gateway.example',
          gatewayApproval: { base, privateAccess: false },
          models: [{ id: 'm1', vision: true }]
        }
      }
    } as unknown as EvoConfig
    let seenHeaders: Headers | undefined
    const model = createModel(config, 'fixture/m1', {
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        seenHeaders = new Headers(init?.headers)
        return okResponseFor(c.protocol)
      }) as typeof fetch
    })
    const events = await drain(model.stream({
      requestId: `auth-${c.protocol}-${c.authHeader}`,
      instructions: 'sys',
      messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      tools: [],
      maxOutputTokens: 32
    }, new AbortController().signal))
    assert.equal((events.at(-1) as Extract<ModelEvent, { type: 'finish' }>).reason, 'complete', `${c.protocol}/${c.authHeader}`)
    assert.equal(seenHeaders!.get(c.expectedHeader), c.expectedValue, `${c.protocol}/${c.authHeader} expected ${c.expectedHeader}`)
    for (const bad of c.forbidden) {
      assert.equal(seenHeaders!.get(bad), null, `${c.protocol}/${c.authHeader} must not send ${bad}`)
    }
  }
})
