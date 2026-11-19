import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { Readable } from 'node:stream'
import type { ProviderOverride } from './config'

const blocked = new BlockList()
for (const [address, bits] of [['0.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(address, bits)
for (const [address, bits] of [['::', 128], ['fe80::', 10], ['ff00::', 8]] as const) blocked.addSubnet(address, bits, 'ipv6')
const privateIps = new BlockList()
for (const [address, bits] of [['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) privateIps.addSubnet(address, bits)
privateIps.addSubnet('fc00::', 7, 'ipv6')
privateIps.addAddress('::1', 'ipv6')
const loopbacks = new BlockList()
loopbacks.addSubnet('127.0.0.0', 8)
loopbacks.addAddress('::1', 'ipv6')
const fakeIps = new BlockList()
fakeIps.addSubnet('198.18.0.0', 15)

const ipHost = (url: URL) => url.hostname.replace(/^\[|\]$/g, '')
const family = (address: string) => isIP(address) === 6 ? 'ipv6' : 'ipv4'
export const localGatewayHost = (url: URL) =>
  url.hostname === 'localhost' || (isIP(ipHost(url)) !== 0 && loopbacks.check(ipHost(url), family(ipHost(url))))

export function normalizeGatewayBase(raw: string): string {
  const url = new URL(raw)
  if (url.username || url.password || url.search || url.hash || /%2f|%5c/i.test(url.pathname) ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && localGatewayHost(url))))
    throw new Error('网关须使用 HTTPS 或回环 HTTP，且地址不能包含账号、查询参数或锚点')
  return url.href.replace(/\/+$/, '')
}

export function checkGatewayIp(url: URL, address: string, localPort: number, allowPrivate: boolean) {
  const scope = family(address)
  const loopback = loopbacks.check(address, scope)
  if (!isIP(address) || blocked.check(address, scope) ||
    (loopback && Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === localPort))
    throw new Error('网关不能连接链路本地地址、保留地址或工作台自身')
  if (url.protocol === 'http:' && !loopback)
    throw new Error('HTTP 网关必须连接回环地址')
  // TUN fake-IP is valid for an approved HTTPS hostname, with TLS still checking that hostname.
  if (fakeIps.check(address, scope)) {
    if (url.protocol === 'https:' && !isIP(ipHost(url))) return
    throw new Error('保留地址仅支持公网 HTTPS 域名的代理解析')
  }
  if (privateIps.check(address, scope) && !allowPrivate && !(loopback && localGatewayHost(url)))
    throw new Error('请在厂商设置中授权访问内网地址')
}

type GatewayOptions = { base: string; approval?: ProviderOverride['gatewayApproval']; localPort: number; fetch?: typeof fetch }
export function gatewayTransport(options: GatewayOptions): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const base = new URL(normalizeGatewayBase(options.base))
    const root = base.pathname.replace(/\/+$/, '')
    if (options.approval?.base !== normalizeGatewayBase(options.base) || url.origin !== base.origin ||
      (url.pathname !== root && !url.pathname.startsWith(root + '/')) ||
      url.username || url.password || /%2f|%5c/i.test(url.pathname))
      throw new Error('请在厂商设置中确认网关地址和 API 根路径')
    const hostname = ipHost(url)
    const literal = isIP(hostname)
    const allowPrivate = options.approval.privateAccess
    if (literal) checkGatewayIp(url, hostname, options.localPort, allowPrivate)
    if (localGatewayHost(url)) checkGatewayIp(url, '127.0.0.1', options.localPort, allowPrivate)
    if (options.fetch) return options.fetch(input, { ...init, redirect: 'error' })
    const signal = init?.signal
    signal?.throwIfAborted()
    const records = literal ? [{ address: hostname, family: literal }] :
      hostname === 'localhost' ? [{ address: '127.0.0.1', family: 4 }] : await lookup(hostname, { all: true })
    signal?.throwIfAborted()
    for (const record of records) checkGatewayIp(url, record.address, options.localPort, allowPrivate)
    const pinned = records[0]
    if (!pinned) throw new Error('网关域名没有可用地址')
    const headers = new Headers(init?.headers)
    headers.set('accept-encoding', 'identity')
    const body = init?.body
    if (body != null && typeof body !== 'string') throw new Error('网关请求体格式无效')
    if (typeof body === 'string') headers.set('content-length', String(Buffer.byteLength(body)))
    return new Promise<Response>((resolve, reject) => {
      const request = url.protocol === 'https:' ? httpsRequest : httpRequest
      const req = request(url, {
        method: init?.method, headers: Object.fromEntries(headers), signal: signal ?? undefined, agent: false,
        family: pinned.family,
        lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family)
      }, (incoming) => {
        const status = incoming.statusCode ?? 502
        if (status >= 300 && status < 400) {
          incoming.destroy()
          return reject(new Error('网关重定向已拒绝'))
        }
        const responseHeaders = new Headers()
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value)
        }
        const stream = status === 204 || status === 205 ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>
        if (!stream) incoming.resume()
        resolve(new Response(stream, { status, headers: responseHeaders }))
      })
      req.once('error', reject)
      req.end(body ?? undefined)
    })
  }
}
