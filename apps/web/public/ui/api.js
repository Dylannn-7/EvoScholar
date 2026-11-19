// Fetch helpers. Mutations carry x-evoscholar so cross-site pages cannot forge them.
const H = { 'content-type': 'application/json', 'x-evoscholar': '1' }

// The token lives until the server restarts, so localStorage lets new tabs reuse it.
// File previews run in opaque-origin sandboxes and cannot read it.
const TOKEN_KEY = 'evoscholar.session'
const store = () => { try { return localStorage } catch { return sessionStorage } }
export const forgetToken = () => { try { store().removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY) } catch {} }
export const storeToken = (value) => { try { store().setItem(TOKEN_KEY, value) } catch {} }
const readToken = () => { try { return store().getItem(TOKEN_KEY) } catch { return null } }

export async function apiFetch(path, opts = {}) {
  const url = new URL(path, location.origin)
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) throw new Error('无效的工作台地址')
  const headers = new Headers({ ...H, ...(opts.headers || {}) })
  const token = readToken()
  if (token && url.pathname !== '/api/auth/pair') headers.set('authorization', `Bearer ${token}`)
  const r = await fetch(url, { ...opts, headers, redirect: 'error', cache: 'no-store' })
  if (r.status === 401 && url.pathname !== '/api/auth/pair') {
    forgetToken()
    dispatchEvent(new Event('evo:unpaired'))
  }
  return r
}

async function call(path, opts = {}) {
  const r = await apiFetch(path, opts)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status })
  return j
}

export function loadApiImages(root) {
  for (const img of root.querySelectorAll('img[data-api-image]')) {
    const path = img.dataset.apiImage
    delete img.dataset.apiImage
    void apiFetch(path).then(async (res) => {
      if (!res.ok || !res.headers.get('content-type')?.startsWith('image/')) return
      const blob = await res.blob()
      if (!img.isConnected) return
      const url = URL.createObjectURL(blob)
      const clear = () => {
        img.removeEventListener('load', clear)
        img.removeEventListener('error', clear)
        URL.revokeObjectURL(url)
      }
      img.addEventListener('load', clear)
      img.addEventListener('error', clear)
      img.src = url
    }).catch(() => {})
  }
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
