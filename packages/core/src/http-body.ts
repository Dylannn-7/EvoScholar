// Bounded response reads for third-party HTTP (literature sources, model lists, search tools).
// Response.text()/json() buffer the whole body; an unknown gateway or a huge metadata record
// should fail with a clear message instead of growing memory without limit.

export const MiB = 1024 * 1024

/** Read at most `limit` bytes of a response as UTF-8; cancels the stream and throws when exceeded. */
export async function readText(res: Response, limit: number, label = '响应'): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`${label}超过 ${Math.round(limit / MiB)} MB，已停止读取`)
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > limit) {
        await reader.cancel().catch(() => {})
        throw new Error(`${label}超过 ${Math.round(limit / MiB)} MB，已停止读取`)
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

export async function readJson(res: Response, limit: number, label = '响应'): Promise<unknown> {
  const text = await readText(res, limit, label)
  try { return JSON.parse(text) } catch { throw new Error(`${label}不是有效的 JSON`) }
}
