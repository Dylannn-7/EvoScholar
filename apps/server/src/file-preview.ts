import type { ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { pythonBin, runProcess, type Runtime, type ToolEnv } from '@evoscholar/core'
import { httpError, serveFile } from './http'

export async function serveProjectFile(rt: Runtime, res: ServerResponse, file: string, preview: boolean) {
  if (!preview || extname(file).toLowerCase() !== '.pdf') return serveFile(res, file, { projectFile: true })
  // Native PDF viewers can refuse sandboxed frames. Render a static first page with the bundled helper.
  const cwd = await mkdtemp(join(tmpdir(), 'evo-preview-'))
  const controller = new AbortController()
  const close = () => controller.abort()
  res.once('close', close)
  try {
    const env: ToolEnv = { ws: rt.ws, ledger: rt.ledger, category: () => 'usage', cwd }
    const png = join(cwd, 'preview.png')
    const result = await runProcess(pythonBin(env), [join(rt.ws.root, 'python', 'evoscholar_lit.py'), 'render', file, '1', png, '110'], env, 15, controller.signal)
    if (result.code !== 0) throw httpError(422, '无法渲染 PDF 首页，请下载原文件')
    const image = await readFile(png)
    if (res.destroyed) return
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    res.end(image)
  } finally {
    res.off('close', close)
    await rm(cwd, { recursive: true, force: true })
  }
}
