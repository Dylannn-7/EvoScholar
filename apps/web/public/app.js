// EvoScholar web workbench — no build step, no external requests.
const $ = (s, el = document) => el.querySelector(s)
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
  $('#genomeBadge').textContent = state.genome.id
  $('#genomeBadge').title = `当前 harness：${state.genome.id}\n${state.genome.note || ''}\n主力模型：${state.genome.roles.main}`
  renderSessions()
  renderBudget(state.budget)
  const ds = state.providers.find((p) => p.id === state.genome.roles.main.split('/')[0])
  if (ds && !ds.hasKey) banner(`还没有配置 ${ds.label} 的 API Key，请在「模型与密钥」里填写。`)
}
function banner(text) { const b = $('#banner'); b.hidden = !text; b.textContent = text || '' }

function renderSessions() {
  $('#sessions').innerHTML = state.sessions.length
    ? state.sessions.map((s) => `<a data-id="${esc(s.id)}" class="${s.id === current ? 'active' : ''}"><div class="t">${esc(s.title || s.id)}</div><div class="m">${s.turns} 轮 · ${yuan(s.cost)} · ${esc(s.genome_id)}</div></a>`).join('')
    : '<div class="muted" style="padding:8px 10px">还没有会话</div>'
}
$('#sessions').addEventListener('click', (e) => { const a = e.target.closest('a[data-id]'); if (a) openSession(a.dataset.id) })

function renderBudget(b) {
  const pct = Math.min(100, (b.totalCny / b.capCny) * 100)
  const cls = pct >= 80 ? 'bad' : pct >= 50 ? 'warn' : ''
  const names = { usage: '日常使用', evolution: '进化', dev: '开发测试', reserve: '预留' }
  $('#budget').innerHTML = `<div class="total">API 花费 <b>${yuan(b.totalCny)}</b> / ¥${b.capCny}</div>
    <div class="bar ${cls}"><i style="width:${pct}%"></i></div>
    ${Object.entries(b.byCategory).map(([k, v]) => `<div class="row"><span>${names[k] || k}</span><span>${yuan(v)} / ¥${b.categoryCaps[k]}</span></div>`).join('')}
    <div class="row" style="margin-top:4px"><span>今日使用</span><span>${yuan(b.usageTodayCny)} / ¥${b.dailyUsageSoftCny}</span></div>
    <div class="row"><span>今日联网</span><span>${b.webCallsToday} / ${b.webCallsPerDay} 次</span></div>`
}

// ---------- sessions ----------
$('#newSession').onclick = async () => {
  const title = prompt('会话名称（例如：光子神经网络综述）', '新会话')
  if (title === null) return
  const r = await post('/api/sessions', { title })
  await loadState()
  openSession(r.id)
}

async function openSession(id) {
  current = id
  renderSessions()
  const s = await api(`/api/sessions/${id}`)
  const meta = state.sessions.find((x) => x.id === id)
  $('#title').textContent = meta?.title || id
  $('#subtitle').textContent = `工作目录：${s.cwd} · genome ${s.genome}`
  $('#cwdHint').textContent = `文件会放在 inputs/`
  const el = inner()
  el.innerHTML = ''
  for (const m of s.messages) renderStored(m)
  if (!s.messages.length) el.innerHTML = '<div class="empty">问点什么吧<small>例如：检索 2024 年以来片上光学神经网络的综述，按年份列出 5 篇并附链接</small></div>'
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
document.querySelectorAll('[data-panel]').forEach((b) => (b.onclick = () => (panelKind === b.dataset.panel && !$('#panel').hidden ? closePanel() : showPanel(b.dataset.panel))))
$('#closePanel').onclick = closePanel
function closePanel() { $('#panel').hidden = true; panelKind = null }
async function showPanel(kind) {
  panelKind = kind
  $('#panel').hidden = false
  const body = $('#panelBody')
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

loadState().catch((e) => banner(e.message))
