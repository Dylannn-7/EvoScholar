import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'

const digest = (value: string) => createHash('sha256').update(value).digest()
const token = () => randomBytes(32).toString('base64url')

export function createLocalAuth(now = Date.now) {
  let auto = '', manual = '', started = 0, used = false, failed = 0, retryAt = 0
  const issue = () => {
    auto = token()
    manual = String(randomInt(100_000, 1_000_000))
    started = now()
    used = false
    failed = 0
    retryAt = 0
  }
  issue()
  const active = new Map<string, Set<ServerResponse>>()

  return {
    get pairing() { return { auto, manual } },
    /** New one-time codes, issued only from the server's own terminal. Existing tokens stay valid. */
    renew: issue,
    exchange(code: unknown): { status: number; token?: string; error?: string } {
      if (used || typeof code !== 'string' || code.length > 64)
        return { status: 401, error: '配对码无效或已使用' }
      const elapsed = now() - started
      const candidate = digest(code)
      const automatic = timingSafeEqual(candidate, digest(auto))
      if (automatic ? elapsed >= 60_000 : elapsed >= 600_000)
        return { status: 401, error: '配对码已过期，请重启工作台' }
      if (!automatic && (failed >= 5 || now() < retryAt))
        return { status: 429, error: failed >= 5 ? '手动配对已锁定，请重启工作台' : '配对过于频繁，请稍后重试' }
      if (!automatic && !timingSafeEqual(candidate, digest(manual))) {
        failed++
        retryAt = now() + 1_000
        return { status: 401, error: '配对码无效' }
      }
      used = true
      const bearer = token()
      active.set(digest(bearer).toString('hex'), new Set())
      return { status: 200, token: bearer }
    },
    verify(header: string | undefined): string | undefined {
      const value = /^Bearer ([\w-]{43})$/i.exec(header ?? '')?.[1]
      const presented = digest(value ?? '')
      for (const known of active.keys()) if (timingSafeEqual(presented, Buffer.from(known, 'hex'))) return known
    },
    watch(id: string, res: ServerResponse) {
      const streams = active.get(id)
      if (!streams) { res.end(); return false }
      streams.add(res)
      res.once('close', () => streams.delete(res))
      return true
    },
    revoke(id: string) {
      for (const res of active.get(id) ?? []) res.end()
      active.delete(id)
    }
  }
}

export function announcePairing(port: number, auth: ReturnType<typeof createLocalAuth>) {
  const base = `http://127.0.0.1:${port}/`
  console.log(`EvoScholar 工作台：${base}`)
  if (process.stdout.isTTY) {
    console.log(`手动配对码（10 分钟有效）：${auth.pairing.manual}`)
    if (process.stdin.isTTY) console.log('需要重新配对时，在此终端按回车，会生成新的配对码并打开浏览器。')
  }
  const url = `${base}#pair=${auth.pairing.auto}`
  const [file, args] = process.platform === 'darwin' ? ['open', [url]] :
    process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]]
  const child = spawn(file, args, { stdio: 'ignore', windowsHide: true })
  child.on('error', () => console.log('无法打开浏览器，请使用终端配对码。'))
  child.unref()
}
