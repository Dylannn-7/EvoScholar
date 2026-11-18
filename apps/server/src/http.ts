import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
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

export function serveFile(res: ServerResponse, file: string) {
  res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  createReadStream(file).pipe(res)
}

export async function body(req: IncomingMessage, limit = 30 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = []
  let n = 0
  for await (const c of req) {
    n += (c as Buffer).length
    if (n > limit) throw Object.assign(new Error('请求体过大'), { status: 413 })
    chunks.push(c as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}


export function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status })
}
