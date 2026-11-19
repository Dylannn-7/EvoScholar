import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream'
import { extname } from 'node:path'

export const IMG = /\.(png|jpe?g|gif|webp|svg)$/i
export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.tex': 'text/plain; charset=utf-8',
  '.bib': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8'
}

export function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export function serveFile(res: ServerResponse, file: string, opts: { projectFile?: boolean } = {}) {
  const ext = extname(file).toLowerCase()
  const headers: Record<string, string> = {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  }
  if (opts.projectFile) {
    headers['content-security-policy'] = "sandbox; default-src 'none'"
    if (ext === '.html' || ext === '.js') headers['content-disposition'] = 'attachment'
  }
  const stream = createReadStream(file)
  stream.once('error', () => {
    if (!res.headersSent) send(res, 404, { error: '无法读取文件' })
  })
  stream.once('open', () => {
    if (res.destroyed) return stream.destroy()
    res.writeHead(200, headers)
    pipeline(stream, res, () => {})
  })
}

export async function body(req: IncomingMessage, limit = 30 * 1024 * 1024): Promise<any> {
  if (Number(req.headers['content-length']) > limit) throw httpError(413, '请求体过大')
  const chunks: Buffer[] = []
  let n = 0
  for await (const c of req.iterator({ destroyOnReturn: false })) {
    n += (c as Buffer).length
    if (n > limit) throw httpError(413, '请求体过大')
    chunks.push(c as Buffer)
  }
  if (!n) return {}
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.concat(chunks, n).toString('utf8')) }
  catch { throw httpError(400, '请求体必须为有效的 JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw httpError(400, '请求体必须为 JSON 对象')
  return parsed
}


export function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status })
}
