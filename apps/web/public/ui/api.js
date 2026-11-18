// Fetch helpers. Mutations carry x-evoscholar so cross-site pages cannot forge them.
const H = { 'content-type': 'application/json', 'x-evoscholar': '1' }

async function call(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { ...H, ...(opts.headers || {}) } })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status })
  return j
}
export const api = (path) => call(path)
export const post = (path, body) => call(path, { method: 'POST', body: JSON.stringify(body || {}) })
export const put = (path, body) => call(path, { method: 'PUT', body: JSON.stringify(body || {}) })
export const patch = (path, body) => call(path, { method: 'PATCH', body: JSON.stringify(body || {}) })
export const del = (path) => call(path, { method: 'DELETE' })

export const fmtTokens = (n) => {
  n = Number(n || 0)
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'K'
  return n.toLocaleString('en-US')
}
export const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? (b / 1024).toFixed(1) + ' KB' : `${b} B`)
export function ago(ts) {
  if (!ts) return ''
  const s = (Date.now() - new Date(ts).getTime()) / 1000
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}
