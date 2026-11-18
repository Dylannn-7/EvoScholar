import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { TOOL_FACTORIES, type ToolEnv } from './tools'

const REPO = resolve(__dirname, '../../..')

test('figure_check measures a saved figure, applies the rule pack and returns a preview image', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fig-'))
  // A 6-inch-wide PDF: too wide for a Nature column; and a 150-dpi PNG: below IEEE's line-art 600 dpi.
  execFileSync('python3', ['-c', `
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(8, 3)); ax.plot([0, 1], [0, 1]); fig.savefig('wide.pdf'); fig.savefig('low.png', dpi=150)
`], { cwd })
  const events: Record<string, unknown>[] = []
  const env = { ws: { root: REPO, dataDir: join(cwd, 'nodata'), config: {} }, cwd, sessionId: 't', trace: (e: Record<string, unknown>) => events.push(e) } as unknown as ToolEnv
  const tool = TOOL_FACTORIES.figure_check(env)
  const signal = new AbortController().signal
  const r = (await tool.execute(tool.validate!({ path: 'wide.pdf', venue: 'nature' }) as never, { signal } as never)) as { content: { type: string; text?: string; mimeType?: string }[] }
  assert.match(r.content[0].text!, /✗ wide\.pdf（规则包 nature）· 203\.2×76\.2 mm/)
  assert.match(r.content[0].text!, /超过 183 mm/)
  assert.equal(r.content.at(-1)!.type, 'image')
  assert.equal(r.content.at(-1)!.mimeType, 'image/png')
  const low = (await tool.execute({ path: 'low.png', venue: 'ieee' } as never, { signal } as never)) as { content: { text?: string }[] }
  assert.match(low.content[0].text!, /低于要求 600 dpi/)
  assert.deepEqual(events.map((e) => e.kind), ['figure.check', 'figure.check'])
  assert.throws(() => tool.validate!({ path: 'x', venue: '../etc' }))
  await assert.rejects(tool.execute({ path: '../outside.pdf' } as never, { signal } as never))
})
