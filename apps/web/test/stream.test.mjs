import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openEventStream } from '../public/ui/stream.js'

test('SSE reconnects and resynchronizes before delivering events from the replacement stream', { timeout: 2000 }, async () => {
  const done = Promise.withResolvers()
  const seen = []
  let connections = 0
  const stream = openEventStream(async () => {
    connections++
    return new Response('data: {"type":"hello"}\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }, {
    retryMs: 1,
    resync: async () => seen.push('snapshot and pending approvals'),
    onEvent: ({ type }) => {
      seen.push(type)
      if (connections === 2) done.resolve()
    },
    onError: done.reject
  })
  try {
    await done.promise
    assert.deepEqual(seen, ['hello', 'snapshot and pending approvals', 'hello'])
  } finally { stream.close() }
})
