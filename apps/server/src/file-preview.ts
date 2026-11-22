import type { ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { pythonBin, runProcess, type Runtime, type ToolEnv } from '@evoscholar/core'
import { httpError, serveFile } from './http'

export async function serveProjectFile(rt: Runtime, res: ServerResponse, file: string, params: URLSearchParams) {
  const preview = params.get('preview')
  if (extname(file).toLowerCase() !== '.pdf' || (preview !== 'page' && preview !== 'first-page')) {
    return serveFile(res, file, { projectFile: true })
  }
  const page = preview === 'first-page' ? 1 : Number(params.get('page'))
  if (!Number.isSafeInteger(page) || page < 1) throw httpError(400, 'PDF 页码必须是正整数')
  // Serve the requested page as a static image inside the workbench.
  const cwd = await mkdtemp(join(tmpdir(), 'evo-preview-'))
  const controller = new AbortController()
  const close = () => controller.abort()
  res.once('close', close)
  try {
    const env: ToolEnv = { ws: rt.ws, ledger: rt.ledger, category: () => 'usage', cwd }
    const png = join(cwd, 'preview.png')
    const result = await runProcess(pythonBin(env), [join(rt.ws.root, 'python', 'evoscholar_lit.py'), 'render', file, String(page), png, '110'], env, 15, controller.signal)
    if (result.code !== 0) throw httpError(422, `无法渲染 PDF 第 ${page} 页，请打开原文件核对页码`)
    const image = await readFile(png)
    if (res.destroyed) return
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    res.end(image)
  } finally {
    res.off('close', close)
    await rm(cwd, { recursive: true, force: true })
  }
}
