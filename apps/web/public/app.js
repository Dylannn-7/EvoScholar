// EvoScholar web workbench — no build step, no external requests.
const $ = (s, el = document) => el.querySelector(s)
let fx = { setState () {}, setDim () {}, setBudgetLevel () {}, reform () {}, setQuality () {}, setMouseStrength () {}, quality: 'off' }
import('./fx/index.js').then((m) => { try { fx = m.initFx(document.getElementById('bg')); syncFx() } catch (e) { console.warn('fx disabled:', e) } }).catch((e) => console.warn('fx disabled:', e))
function syncFx () {
  fx.setDim(current ? 0.4 : 1)
  if (state?.budget) fx.setBudgetLevel(state.budget.usageTodayCny / Math.max(0.01, state.budget.dailyUsageSoftCny))
}
const H = { 'content-type': 'application/json', 'x-evoscholar': '1' }
const api = async (path, opts = {}) => {
  const r = await fetch(path, { ...opts, headers: { ...H, ...(opts.headers || {}) } })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || r.statusText)
  return j
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) })
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const yuan = (n) => '¥' + (n ?? 0).toFixed(n >= 10 ? 1 : n >= 1 ? 2 : 4)

// ---------- minimal, escaping markdown ----------
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(（])(https?:\/\/[^\s<)）]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
}
function md(src) {
  const out = []
  const lines = String(src || '').split('\n')
  let i = 0
  while (i < lines.length) {
    const l = lines[i]
    if (/^```/.test(l)) {
      const buf = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++])
      i++
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`)
      continue
    }
    const h = /^(#{1,4})\s+(.*)/.exec(l)
    if (h) { out.push(`<h${Math.min(3, h[1].length)}>${inline(h[2])}</h${Math.min(3, h[1].length)}>`); i++; continue }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const row = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const head = row(l)
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(row(lines[i++]))
      out.push(`<table><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</table>`)
      continue
    }
    if (/^\s*([-*]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d/.test(l)
      const items = []
      while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+[.)])\s+/, ''))
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`)
      continue
    }
    if (!l.trim()) { i++; continue }
    const para = []
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*]|\d+[.)])\s+)/.test(lines[i])) para.push(lines[i++])
    out.push(`<p>${para.map(inline).join('<br>')}</p>`)
  }
  return out.join('')
}

// ---------- state ----------
let state = null
let current = null // session id
let es = null
let pendingImages = []
let liveMsg = null // { el, text, reasoningEl, reasoning }
const thread = $('#thread')

function inner() {
  let el = $('.thread-inner', thread)
  if (!el) { el = document.createElement('div'); el.className = 'thread-inner'; thread.replaceChildren(el) }
  return el
}
const scroll = () => (thread.scrollTop = thread.scrollHeight)

async function loadState() {
  state = await api('/api/state')
  const gen = (/(\d+)$/.exec(state.genome.id) || [, '0'])[1]
  $('#counter').textContent = gen.slice(-2).padStart(2, '0')
  $('#counter').title = `当前 harness：${state.genome.id}\n${state.genome.note || ''}\n点击查看进化`
  try {
    const seen = localStorage.getItem('evoscholar.genome')
    if (seen && seen !== state.genome.id) fx.reform()
    localStorage.setItem('evoscholar.genome', state.genome.id)
  } catch {}
  renderSessions()
  renderBudget(state.budget)
  renderStatus()
  syncFx()
  const ds = state.providers.find((p) => p.id === state.genome.roles.main.split('/')[0])
  if (ds && !ds.hasKey) banner(`还没有配置 ${ds.label} 的 API Key，请在「模型与密钥」里填写。`)
}
function banner(text) { const b = $('#banner'); b.hidden = !text; b.textContent = text || '' }

const MODES = { literature: '文献', data: '数据', figure: '出图', writing: '写作', chat: '对话' }
let modeFilter = 'all'
function ago(ts) {
  if (!ts) return ''
  const s = (Date.now() - new Date(ts.replace(' ', 'T') + (ts.endsWith('Z') ? '' : 'Z')).getTime()) / 1000
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} 分钟前`
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`
  return `${Math.round(s / 86400)} 天前`
}
// Deterministic generative thumbnail (same id → same image), drawn in the particle style:
// grey dots on black with a few lavender accents; the motif follows the session mode.
const artCache = new Map()
function artFor(s) {
  const key = `${s.id}|${s.mode}`
  if (artCache.has(key)) return artCache.get(key)
  let h = 2166136261
  for (const ch of s.id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) }
  const rnd = () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const W = 640, H = 300
  const cv = document.createElement('canvas')
  cv.width = W; cv.height = H
  const g = cv.getContext('2d')
  g.fillStyle = '#0a0a0a'; g.fillRect(0, 0, W, H)
  const dot = (x, y, r = 1, a = 0.7, accent = false) => { g.fillStyle = accent ? `rgba(170,136,255,${a})` : `rgba(225,225,225,${a})`; g.fillRect(x, y, r, r) }
  const mode = s.mode || 'chat'
  if (mode === 'literature') {            // a page of references: dashed lines, one highlighted citation
    const rows = 14, hi = Math.floor(rnd() * rows)
    for (let i = 0; i < rows; i++) {
      const y = 28 + i * 18, len = 220 + rnd() * 340
      for (let x = 40; x < 40 + len; x += 3) if (rnd() > 0.18) dot(x, y + rnd() * 2, 1.4, i === hi ? 0.95 : 0.25 + rnd() * 0.35, i === hi)
      dot(24, y, 3, 0.6, i === hi)
    }
  } else if (mode === 'data') {           // scatter with a fitted curve
    const a = 0.5 + rnd(), b = rnd() * 3
    for (let i = 0; i < 1400; i++) { const x = rnd(); const y = 0.5 + 0.32 * Math.sin(a * 6 * x + b) + (rnd() - 0.5) * 0.22; dot(30 + x * (W - 60), y * H, 1.6, 0.2 + rnd() * 0.5) }
    for (let x = 0; x < 1; x += 0.002) dot(30 + x * (W - 60), (0.5 + 0.32 * Math.sin(a * 6 * x + b)) * H, 2, 0.9, true)
  } else if (mode === 'figure') {         // spectra: a few resonance dips / peaks
    for (let c = 0; c < 3; c++) {
      const x0 = 0.2 + rnd() * 0.6, w = 0.01 + rnd() * 0.04, base = 0.25 + c * 0.25
      for (let x = 0; x < 1; x += 0.0012) { const y = base + 0.18 * (w * w) / ((x - x0) ** 2 + w * w); dot(20 + x * (W - 40), H - y * H, 1.6, 0.35 + 0.4 * (c === 1), c === 1) }
    }
    for (let i = 0; i < 300; i++) dot(rnd() * W, rnd() * H, 1, 0.12)
  } else if (mode === 'writing') {        // paragraphs of text blocks, one flagged span
    let y = 30
    for (let p = 0; p < 3; p++) {
      const lines = 3 + Math.floor(rnd() * 3)
      for (let l = 0; l < lines; l++) {
        const len = l === lines - 1 ? 180 + rnd() * 200 : 520 + rnd() * 60, flag = rnd() < 0.12
        for (let x = 40; x < 40 + len; x += 2.5) if (rnd() > 0.08) dot(x, y, 1.6, flag ? 0.9 : 0.32, flag)
        y += 13
      }
      y += 14
    }
  } else {                                 // conversation: concentric rings of dots
    const cx = W * (0.35 + rnd() * 0.3), cy = H * 0.5
    for (let r = 12; r < 280; r += 9 + rnd() * 6) for (let t = 0; t < Math.PI * 2; t += 0.04 + rnd() * 0.05) dot(cx + Math.cos(t) * r * 1.4, cy + Math.sin(t) * r * 0.75, 1.4, Math.max(0.05, 0.75 - r / 320), rnd() < 0.02)
  }
  const url = cv.toDataURL('image/png')
  artCache.set(key, url)
  return url
}
function renderSessions() {
  const counts = state.sessions.reduce((m, s) => ((m[s.mode] = (m[s.mode] || 0) + 1), m), {})
  document.querySelectorAll('#tags .chip').forEach((c) => {
    const n = c.dataset.mode === 'all' ? state.sessions.length : counts[c.dataset.mode] || 0
    c.innerHTML = `${c.textContent.replace(/\s*\d+$/, '')}<span class="n">${n}</span>`
  })
  const list = state.sessions.filter((s) => modeFilter === 'all' || s.mode === modeFilter)
  const card = (s) => `<a class="card ${s.id === current ? 'active' : ''}" data-id="${esc(s.id)}">
      <div class="thumb"><img src="${s.thumb ? `/api/sessions/${encodeURIComponent(s.id)}/file?path=${encodeURIComponent(s.thumb)}` : artFor(s)}" alt="" loading="lazy"><span class="tag">${esc(MODES[s.mode] || '对话')}</span></div>
      <div class="meta"><div class="l">${esc(s.title || s.id)}</div><div class="r">${s.turns} 轮 · ${esc(yuan(s.cost))}\n${esc(ago(s.last || s.created_at))}</div></div></a>`
  $('#sessions').innerHTML = `<a class="newrow" data-new="1"><span><span class="plus">＋</span>新建会话</span><span class="r">NEW SESSION</span></a>`
    + (list.length ? list.map(card).join('') : `<div class="none">${state.sessions.length ? '这一类还没有会话' : '还没有会话。新建一个，问点什么吧。'}</div>`)
}
$('#sessions').addEventListener('click', (e) => {
  const a = e.target.closest('.card, .newrow')
  if (!a) return
  if (a.dataset.new) return newSession()
  openSession(a.dataset.id)
})
$('#tags').addEventListener('click', (e) => {
  const b = e.target.closest('.chip')
  if (!b) return
  modeFilter = b.dataset.mode
  document.querySelectorAll('#tags .chip').forEach((x) => x.classList.toggle('on', x === b))
  renderSessions()
})
function renderStatus() {
  const g = state.genome
  $('#genomeInfo').innerHTML = `<div class="row"><span>${esc(g.id)}</span><span>已上线</span></div>
    <div class="row"><span>父版本</span><span>${esc(g.parent || '—')}</span></div>
    <div class="row"><span>待审批</span><span id="pendingCount">${state.pending ?? 0} 个</span></div>`
  $('#modelInfo').innerHTML = Object.entries({ main: '主力', fast: '轻量', vision: '视觉', reflector: '反思' })
    .map(([k, n]) => `<div class="row"><span>${n}</span><span>${esc((g.roles[k] || '').split('/').pop())}</span></div>`).join('')
  $('#exploring').textContent = `${g.id} · ${(g.note || '').slice(0, 90)}`
  $('#counter').classList.toggle('attn', (state.pending ?? 0) > 0)
  $('#evoBtn').classList.toggle('attn', (state.pending ?? 0) > 0)
}

function renderBudget(b) {
  const day = b.usageTodayCny / Math.max(0.01, b.dailyUsageSoftCny)
  const cls = day >= 1 ? 'bad' : day >= 0.8 ? 'warn' : ''
  $('#budget').innerHTML = `<div class="row"><span>今日</span><span>${yuan(b.usageTodayCny)} / ¥${b.dailyUsageSoftCny}</span></div>
    <div class="bar ${cls}"><i style="width:${Math.min(100, day * 100)}%"></i></div>
    <div class="row"><span>联网</span><span>${b.webCallsToday} / ${b.webCallsPerDay} 次</span></div>
    <div class="row"><span>累计</span><span>${yuan(b.totalCny)} / ¥${b.capCny}</span></div>`
  fx.setBudgetLevel(day)
}

// ---------- sessions ----------
async function newSession() {
  const title = prompt('会话名称（例如：光子神经网络综述）', '新会话')
  if (title === null) return
  const r = await post('/api/sessions', { title })
  await loadState()
  openSession(r.id)
}
$('#newSession').onclick = (e) => { e.preventDefault(); newSession() }
$('#counter').onclick = () => showPanel('evolution')
$('#backHome').onclick = () => {
  current = null
  es?.close()
  document.body.classList.remove('has-session')
  $('#title').textContent = '欢迎使用 EvoScholar'
  renderSessions()
  syncFx()
}

async function openSession(id) {
  current = id
  document.body.classList.add('has-session')
  syncFx()
  renderSessions()
  const s = await api(`/api/sessions/${id}`)
  const meta = state.sessions.find((x) => x.id === id)
  $('#title').textContent = meta?.title || id
  $('#subtitle').textContent = `…/${s.cwd.split(/[\\/]/).slice(-2).join('/')} · ${s.genome}`
  $('#subtitle').title = `工作目录：${s.cwd}`
  $('#cwdHint').textContent = `文件会放在 inputs/`
  const el = inner()
  el.innerHTML = ''
  for (const m of s.messages) renderStored(m)
  if (!s.messages.length) {
    const ex = ['检索 2024 年以来片上光学神经网络的综述，按年份列出 5 篇并附链接', '把 inputs/ 里的透射谱拟合成洛伦兹线型，给出中心波长、FWHM 和 Q 值，按 Optica 规范出图', '按华科博士论文规范检查 inputs/ 里的 main.tex，列出问题和依据']
    el.innerHTML = `<div class="empty"><b>[开始]</b> 问点什么吧。也可以点一个例子：${ex.map((x) => `<span class="ex">→ ${esc(x)}</span>`).join('')}<small>文件会放在会话的 inputs/ 目录；需要执行代码时会先请你确认。</small></div>`
    el.querySelectorAll('.ex').forEach((n) => (n.onclick = () => { $('#input').value = n.textContent.slice(2); $('#input').focus() }))
  }
  setBusy(s.busy)
  connect(id)
  scroll()
  if (!$('#panel').hidden && panelKind === 'files') showPanel('files')
}

function renderStored(m) {
  const el = inner()
  if (m.role === 'user') return el.insertAdjacentHTML('beforeend', `<div class="msg user">${esc(m.text)}${m.images ? ` <span class="muted">[${m.images} 张图片]</span>` : ''}</div>`)
  if (m.role === 'assistant') {
    if (m.text.trim()) el.insertAdjacentHTML('beforeend', `<div class="msg assistant">${md(m.text)}</div>`)
    for (const c of m.calls) el.appendChild(toolEl(c.name, c.arguments, c.id))
    return
  }
  if (m.role === 'tool') {
    const t = [...el.querySelectorAll('.tool:not([data-done])')].at(0)
    if (t) fillTool(t, m.text, m.isError)
  }
}

function toolEl(name, args, id) {
  const d = document.createElement('details')
  d.className = 'tool'
  if (id) d.dataset.id = id
  const brief = typeof args === 'object' && args ? Object.values(args).map((v) => String(typeof v === 'string' ? v : JSON.stringify(v))).join(' · ').slice(0, 120) : ''
  d.innerHTML = `<summary><span class="name">${esc(name)}</span> ${esc(brief)} <span class="state">…</span></summary><pre class="args">${esc(JSON.stringify(args, null, 2))}</pre><pre class="result"></pre>`
  return d
}
function fillTool(t, text, isError) {
  t.dataset.done = '1'
  $('.state', t).textContent = isError ? '✗ 出错' : '✓'
  $('.result', t).textContent = text
  if (isError) t.classList.add('err')
}

// ---------- live events ----------
function connect(id) {
  es?.close()
  es = new EventSource(`/api/sessions/${id}/events`)
  es.onmessage = (ev) => handle(JSON.parse(ev.data))
}
function ensureLive() {
  if (liveMsg) return liveMsg
  const el = document.createElement('div')
  el.className = 'msg assistant'
  inner().appendChild(el)
  liveMsg = { el, text: '', reasoning: '' }
  return liveMsg
}
function handle(e) {
  const el = inner()
  if (e.type === 'reasoning' || e.type === 'text') fx.setState('thinking')
  else if (e.type === 'tool-call') fx.setState('tool')
  else if (e.type === 'tool-result' || e.type === 'approval-resolved') fx.setState('thinking')
  else if (e.type === 'approval') fx.setState('approval')
  else if (e.type === 'done' || e.type === 'error') fx.setState('idle')
  switch (e.type) {
    case 'hello': setBusy(e.busy); break
    case 'reasoning': {
      const lm = ensureLive()
      lm.reasoning += e.text
      if (!lm.reasoningEl) { lm.reasoningEl = document.createElement('div'); lm.reasoningEl.className = 'reasoning'; lm.el.prepend(lm.reasoningEl) }
      lm.reasoningEl.textContent = lm.reasoning
      break
    }
    case 'text': {
      const lm = ensureLive()
      lm.text += e.text
      lm.el.innerHTML = (lm.reasoningEl ? lm.reasoningEl.outerHTML : '') + md(lm.text)
      lm.reasoningEl = lm.el.querySelector('.reasoning')
      break
    }
    case 'tool-call':
      if (liveMsg && !liveMsg.text.trim() && !liveMsg.reasoning) liveMsg.el.remove()
      liveMsg = null
      el.appendChild(toolEl(e.name, e.arguments, e.id))
      break
    case 'tool-result': {
      const t = [...el.querySelectorAll('.tool:not([data-done])')].at(0)
      if (t) fillTool(t, e.preview, e.isError)
      break
    }
    case 'approval': {
      const node = $('#tplApproval').content.firstElementChild.cloneNode(true)
      node.dataset.id = e.id
      $('.tool', node).textContent = e.tool
      $('.summary', node).textContent = e.summary
      $('.allow', node).onclick = () => decide(e.id, true, node)
      $('.deny', node).onclick = () => decide(e.id, false, node)
      el.appendChild(node)
      break
    }
    case 'approval-resolved': {
      const n = el.querySelector(`.approval[data-id="${e.id}"]`)
      if (n) { n.classList.add('done'); $('.approval-head', n).textContent = e.allow ? '已允许' : '已拒绝' }
      break
    }
    case 'warning': banner(e.message); break
    case 'error': el.insertAdjacentHTML('beforeend', `<div class="error">${esc(e.message)}</div>`); break
    case 'status': if (e.status === 'running') setBusy(true); break
    case 'done': {
      setBusy(false)
      if (liveMsg) addFeedback(liveMsg.el)
      liveMsg = null
      renderBudget(e.budget)
      api('/api/state').then((s) => { state = s; renderSessions() })
      if (!$('#panel').hidden && panelKind === 'files') showPanel('files')
      break
    }
  }
  scroll()
}
async function decide(id, allow, node) {
  await post(`/api/sessions/${current}/approve/${id}`, { allow })
  node.classList.add('done')
}
function addFeedback(msgEl) {
  const f = document.createElement('div')
  f.className = 'feedback'
  f.innerHTML = '<button data-v="1" title="有用">👍</button><button data-v="-1" title="不好">👎</button><button data-c title="写一句评价">评价</button>'
  f.onclick = async (e) => {
    const b = e.target.closest('button')
    if (!b) return
    if (b.dataset.c !== undefined) {
      const note = prompt('这次回答哪里好、哪里不好？（会作为进化信号）')
      if (note) await post(`/api/sessions/${current}/feedback`, { kind: 'comment', note })
    } else {
      await post(`/api/sessions/${current}/feedback`, { kind: 'thumb', value: Number(b.dataset.v) })
      f.querySelectorAll('button[data-v]').forEach((x) => x.classList.toggle('on', x === b))
    }
  }
  msgEl.appendChild(f)
}
function setBusy(b) {
  $('#sendBtn').disabled = b
  $('#stopBtn').hidden = !b
}
$('#stopBtn').onclick = () => post(`/api/sessions/${current}/cancel`)

// ---------- composer ----------
$('#input').addEventListener('focus', () => fx.setMouseStrength(0.15))
$('#input').addEventListener('blur', () => fx.setMouseStrength())
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit() }
})
$('#input').addEventListener('paste', (e) => {
  for (const item of e.clipboardData?.items || []) if (item.type.startsWith('image/')) { addImage(item.getAsFile()); e.preventDefault() }
})
function addImage(file) {
  const r = new FileReader()
  r.onload = () => {
    const [, mimeType, data] = /^data:([^;]+);base64,(.*)$/.exec(r.result)
    pendingImages.push({ mimeType, data })
    $('#attachments').insertAdjacentHTML('beforeend', `<img src="${r.result}" alt="">`)
  }
  r.readAsDataURL(file)
}
$('#fileInput').onchange = async (e) => {
  if (!current) return alert('请先新建或打开一个会话')
  for (const f of e.target.files) {
    if (f.type.startsWith('image/') && confirm(`把 ${f.name} 作为图片发给模型看？（取消则作为文件上传到 inputs/）`)) { addImage(f); continue }
    const data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(f) })
    const r = await post(`/api/sessions/${current}/upload`, { name: f.name, data })
    $('#input').value += (($('#input').value ? '\n' : '') + `（已上传 ${r.path}）`)
  }
  e.target.value = ''
  if (!$('#panel').hidden && panelKind === 'files') showPanel('files')
}
$('#composer').onsubmit = async (e) => {
  e.preventDefault()
  const text = $('#input').value.trim()
  if (!text && !pendingImages.length) return
  if (!current) {
    const r = await post('/api/sessions', { title: text.slice(0, 30) || '新会话' })
    await loadState()
    await openSession(r.id)
  }
  $('.empty', thread)?.remove()
  inner().insertAdjacentHTML('beforeend', `<div class="msg user">${esc(text)}${pendingImages.length ? ` <span class="muted">[${pendingImages.length} 张图片]</span>` : ''}</div>`)
  const images = pendingImages
  pendingImages = []
  $('#attachments').innerHTML = ''
  $('#input').value = ''
  setBusy(true)
  try { await post(`/api/sessions/${current}/ask`, { text, images }) } catch (err) { setBusy(false); handle({ type: 'error', message: err.message }) }
  scroll()
}

// ---------- side panel ----------
let panelKind = null
document.querySelectorAll('[data-panel]').forEach((b) => (b.onclick = (e) => { e.preventDefault(); panelKind === b.dataset.panel && !$('#panel').hidden ? closePanel() : showPanel(b.dataset.panel) }))
$('#closePanel').onclick = closePanel
function closePanel() { $('#panel').hidden = true; panelKind = null; $('#panel').classList.remove('wide-panel'); clearTimeout(evoTimer) }
async function showPanel(kind) {
  panelKind = kind
  $('#panel').hidden = false
  $('#panel').classList.toggle('wide-panel', kind === 'evolution')
  clearTimeout(evoTimer)
  const body = $('#panelBody')
  if (kind === 'evolution') return renderEvolution(body)
  if (kind === 'files') {
    $('#panelTitle').textContent = '会话文件'
    if (!current) return (body.innerHTML = '<p class="muted">先打开一个会话。</p>')
    const r = await api(`/api/sessions/${current}/files`)
    const link = (p) => `/api/sessions/${current}/file?path=${encodeURIComponent(p)}`
    const imgs = r.files.filter((f) => /\.(png|jpe?g|svg|gif|webp)$/i.test(f.path))
    body.innerHTML = `<p class="muted" style="word-break:break-all">${esc(r.cwd)}</p>
      ${imgs.length ? `<h3>图片</h3><div class="thumbs">${imgs.map((f) => `<a href="${link(f.path)}" target="_blank"><img src="${link(f.path)}" title="${esc(f.path)}"></a>`).join('')}</div>` : ''}
      <h3>全部文件</h3><div class="files">${r.files.map((f) => `<a href="${link(f.path)}" target="_blank">${esc(f.path)} <span class="size">${(f.size / 1024).toFixed(1)} KB</span></a>`).join('') || '<span class="muted">（空）</span>'}</div>`
  } else if (kind === 'settings') {
    $('#panelTitle').textContent = '模型与密钥'
    state = await api('/api/state')
    const allModels = state.providers.flatMap((p) => p.models.map((m) => ({ ref: `${p.id}/${m.id}`, label: `${p.label} · ${m.id}${m.vision ? ' 👁' : ''}`, ok: p.hasKey })))
    const roleNames = { main: '主力', fast: '轻量', vision: '视觉', reflector: '进化·反思', judge: '进化·评委' }
    body.innerHTML = `
      <h3>角色分配（修改会生成新的 genome 版本）</h3>
      <form id="rolesForm">${Object.entries(roleNames).map(([k, n]) => `<div class="field"><label>${n}</label><select name="${k}">${allModels.map((m) => `<option value="${esc(m.ref)}" ${state.genome.roles[k] === m.ref ? 'selected' : ''}>${esc(m.label)}${m.ok ? '' : '（缺 Key）'}</option>`).join('')}</select></div>`).join('')}
        <button class="primary small">保存角色</button></form>
      <h3>背景粒子画质</h3>
      <div class="field"><select id="fxQuality">${['auto', 'high', 'mid', 'low', 'off'].map((q) => `<option value="${q}" ${(localStorage.getItem('evoscholar.fxQuality') || 'auto') === q ? 'selected' : ''}>${{ auto: '自动', high: '高（262,144 点）', mid: '中（65,536 点）', low: '低（16,384 点）', off: '关' }[q]}</option>`).join('')}</select></div>
      <h3>厂商与 API Key</h3>
      <p class="muted">Key 只写入本机项目目录下的 .env，不会上传。</p>
      ${state.providers.map((p) => `<div class="prov"><div class="h"><span><i class="dot ${p.hasKey ? 'on' : ''}"></i><b>${esc(p.label)}</b> <span class="muted">${esc(p.protocols.join(' / '))}</span></span>${p.apiKeyUrl ? `<a class="muted" href="${esc(p.apiKeyUrl)}" target="_blank">获取 Key</a>` : ''}</div>
        <form data-prov="${esc(p.id)}"><input type="password" placeholder="${p.hasKey ? '已配置，输入新值以替换' : esc(p.apiKeyEnv)}" autocomplete="off"><button class="ghost small">保存</button></form></div>`).join('')}
      <h3>添加自定义网关（URL + Key）</h3>
      <form id="customForm">
        <div class="field"><label>标识（小写字母）</label><input name="id" placeholder="my-gateway" required></div>
        <div class="field"><label>显示名</label><input name="label" placeholder="我的网关"></div>
        <div class="field"><label>完整端点 URL</label><input name="endpoint" placeholder="https://example.com/v1/chat/completions" required></div>
        <div class="field"><label>协议</label><select name="protocol"><option value="chat-completions">Chat Completions（OpenAI 兼容）</option><option value="messages">Messages（Anthropic 兼容）</option><option value="responses">Responses</option></select></div>
        <div class="field"><label>模型 ID（逗号分隔）</label><input name="models" placeholder="model-a, model-b" required></div>
        <div class="field"><label>API Key</label><input name="key" type="password" autocomplete="off"></div>
        <button class="primary small">添加</button></form>`
    body.querySelectorAll('form[data-prov]').forEach((f) => (f.onsubmit = async (e) => {
      e.preventDefault()
      await post('/api/keys', { provider: f.dataset.prov, key: $('input', f).value })
      await loadState(); showPanel('settings')
    }))
    $('#fxQuality').onchange = (e) => { try { localStorage.setItem('evoscholar.fxQuality', e.target.value) } catch {} ; location.reload() }
    $('#rolesForm').onsubmit = async (e) => {
      e.preventDefault()
      const roles = Object.fromEntries(new FormData(e.target))
      try { const r = await post('/api/genome/roles', { roles }); alert(`已生成并启用 ${r.genome}`); await loadState() } catch (err) { alert(err.message) }
    }
    $('#customForm').onsubmit = async (e) => {
      e.preventDefault()
      try { await post('/api/providers/custom', Object.fromEntries(new FormData(e.target))); await loadState(); showPanel('settings') } catch (err) { alert(err.message) }
    }
  } else if (kind === 'ledger') {
    $('#panelTitle').textContent = 'API 账单'
    const r = await api('/api/budget')
    renderBudget(r.summary)
    body.innerHTML = `<p class="muted">最近 50 笔。高峰时段单价是非高峰的 2 倍。</p><table class="ledger">${r.recent.map((x) => `<tr><td>${esc(x.ts.slice(5, 16).replace('T', ' '))}</td><td>${esc(x.kind)}${x.peak ? ' ⏫' : ''}</td><td>${esc(x.category)}</td><td class="muted">${x.input_tokens ? `${x.input_tokens}/${x.cache_read_tokens}/${x.output_tokens}` : ''}</td><td>${yuan(x.cost_cny)}</td></tr>`).join('')}</table>`
  }
}

// ---------- evolution panel ----------
let evoTimer = null
let evoOpen = null // expanded candidate id
const STATUS = { evaluating: '评测中', pending: '待审批', approved: '已上线', rejected: '已拒绝', discarded: '自动淘汰' }
const mark = (v) => (v === undefined || v === null ? '<span class="muted">—</span>' : v ? '<span class="ok">✓</span>' : '<span class="no">✗</span>')
const diffHtml = (lines) => `<pre class="diff">${lines.map((l) => `<span class="${l.op === '+' ? 'add' : l.op === '-' ? 'del' : 'ctx'}">${esc(l.op)} ${esc(l.text)}</span>`).join('\n')}</pre>`

async function renderEvolution(body) {
  $('#panelTitle').textContent = '进化'
  const r = await api('/api/evolution')
  if (panelKind !== 'evolution') return
  const pending = r.candidates.filter((c) => c.status === 'pending')
  $('#evoBtn').classList.toggle('attn', pending.length > 0)
  const byParent = {}
  for (const g of r.lineage) (byParent[g.parent ?? ''] ||= []).push(g)
  const tree = (pid, depth) => (byParent[pid] || []).map((g) => `<div class="lin" style="padding-left:${depth * 14}px"><code>${esc(g.id)}</code> <span class="chip ${esc(g.status)}">${esc(g.status)}</span> <span class="muted">${esc(g.createdBy)}</span><div class="muted note">${esc(g.note)}</div></div>${tree(g.id, depth + 1)}`).join('')
  body.innerHTML = `
    <div class="evo-head">
      <div>当前上线 <code>${esc(r.active.id)}</code>${r.active.parent ? ` <span class="muted">← ${esc(r.active.parent)}</span>` : ''}</div>
      <div class="evo-actions">
        ${r.active.parent ? '<button class="ghost small" id="evoRollback">回滚到父版本</button>' : ''}
        <button class="primary small" id="evoRun" ${r.running.active ? 'disabled' : ''}>${r.running.active ? '运行中…' : '跑一轮进化'}</button>
      </div>
    </div>
    <p class="muted">流程：基线评测 → 反思归因 → 生成候选（每个只改一处）→ 开发集比较 → 验收集关卡 → <b>由你审批</b>上线。每轮 ≤ ¥2。</p>
    ${r.running.log.length ? `<h3>本轮日志</h3><pre class="evo-log">${esc(r.running.log.join('\n'))}</pre>` : ''}
    <h3>候选版本</h3>
    ${r.candidates.length ? r.candidates.map((c) => `<div class="cand ${c.status === 'pending' ? 'pending' : ''}" data-id="${esc(c.genome_id)}">
        <div class="cand-h"><code>${esc(c.genome_id)}</code> <span class="chip ${esc(c.status)}">${STATUS[c.status] || esc(c.status)}</span> <span class="muted">${esc(c.target)}</span>
          <span class="nums">开发 ${c.base_dev_pass ?? '?'}→${c.dev_pass ?? '?'}/${c.dev_total ?? '?'}${c.acc_total ? ` · 验收 ${c.base_acc_pass}→${c.acc_pass}/${c.acc_total}` : ''} · ${yuan(c.cost_cny)}</span></div>
        <div class="muted">${esc(c.diagnosis || '')}</div>
        <div class="cand-body" ${evoOpen === c.genome_id ? '' : 'hidden'}></div>
      </div>`).join('') : '<p class="muted">还没有候选。点「跑一轮进化」开始。</p>'}
    <h3>谱系</h3><div class="lineage">${tree('', 0)}</div>
    <h3>最近几轮</h3><table class="ledger">${r.runs.map((x) => `<tr><td>${esc(x.id)}</td><td>${esc(x.base_genome)}</td><td>${esc(x.status)}</td><td>${yuan(x.cost_cny)}</td></tr>`).join('')}</table>`
  $('#evoRun').onclick = async () => {
    const force = confirm('现在可能是 DeepSeek 高峰时段（价格 ×2）。\n确定：忽略高峰与每日轮数限制直接跑\n取消：按规则检查（高峰时会拒绝）')
    try { await post('/api/evolution/run', { force }) } catch (e) { alert(e.message) }
    renderEvolution(body)
  }
  const rb = $('#evoRollback')
  if (rb) rb.onclick = async () => {
    if (!confirm(`把上线版本从 ${r.active.id} 回滚到 ${r.active.parent}？`)) return
    try { await post('/api/genome/rollback'); await loadState(); renderEvolution(body) } catch (e) { alert(e.message) }
  }
  body.querySelectorAll('.cand').forEach((el) => {
    $('.cand-h', el).onclick = () => { evoOpen = evoOpen === el.dataset.id ? null : el.dataset.id; renderEvolution(body) }
  })
  if (evoOpen) {
    const el = body.querySelector(`.cand[data-id="${evoOpen}"] .cand-body`)
    if (el) await renderCandidate(el, evoOpen, body)
  }
  if (r.running.active) evoTimer = setTimeout(() => panelKind === 'evolution' && renderEvolution(body), 3000)
}

async function renderCandidate(el, id, body) {
  const d = await api(`/api/evolution/${id}`)
  const c = d.candidate || {}
  const changes = d.cases.filter((x) => x.base !== x.cand)
  el.innerHTML = `
    ${c.reason ? `<p><b>结论：</b>${esc(c.reason)}</p>` : ''}
    ${d.promptDiffs.map((p) => `<h4>${esc(p.key)} <span class="muted">${esc(p.from || '（默认描述）')} → ${esc(p.to)}</span></h4>${diffHtml(p.diff)}`).join('')}
    <h4>逐题变化 <span class="muted">${changes.length ? `${changes.length} 题有变化` : '无变化'}</span></h4>
    <table class="cases"><tr><th>任务</th><th>集</th><th>父版本</th><th>候选</th><th>花费</th></tr>
      ${d.cases.map((x) => `<tr class="${x.base !== x.cand ? (x.cand ? 'fix' : 'reg') : ''}" title="${esc((x.failures || []).join('\n'))}"><td>${esc(x.caseId)}</td><td class="muted">${x.split === 'acceptance' ? '验收' : '开发'}</td><td>${mark(x.base)}</td><td>${mark(x.cand)}</td><td class="muted">${x.candCost !== undefined ? yuan(x.candCost) : ''}</td></tr>`).join('')}</table>
    <details><summary class="muted">genome YAML diff</summary>${diffHtml(d.genomeDiff)}</details>
    ${c.status === 'pending' ? `<div class="evo-actions end"><button class="ghost small" data-act="reject">拒绝</button><button class="primary small" data-act="promote">批准上线</button></div>` : ''}`
  el.querySelectorAll('button[data-act]').forEach((b) => (b.onclick = async () => {
    try {
      if (b.dataset.act === 'promote') {
        if (!confirm(`上线 ${id}？之后新会话会使用它；可以随时回滚。`)) return
        await post(`/api/evolution/${id}/promote`)
        fx.reform()
      } else {
        const reason = prompt('拒绝原因（可选，会记录在谱系里）', '')
        if (reason === null) return
        await post(`/api/evolution/${id}/reject`, { reason })
      }
      await loadState()
      renderEvolution(body)
    } catch (e) { alert(e.message) }
  }))
}

loadState().then(() => {
  const sid = new URLSearchParams(location.search).get('s')
  if (sid && state.sessions.some((x) => x.id === sid)) openSession(sid)
}).catch((e) => banner(e.message))
api('/api/evolution').then((r) => {
  const n = r.candidates.filter((c) => c.status === 'pending').length
  if (state) { state.pending = n; renderStatus() }
}).catch(() => {})
