// Settings: model providers (protocol → base URL → key → fetch models → test), defaults & permissions, appearance.
import { dismissUpdate, goHome, setFxQuality, setThemePreference, store, themePreference } from '../app.js'
import { api, del, fmtSize, put, post } from './api.js'
import { icon } from './icons.js'
import { md } from './markdown.js'
import { confirmDialog, esc, openModal, toast } from './modal.js'
import { openOnboarding } from './onboarding.js'

const TABS = [
  { id: 'models', label: '模型与密钥', icon: 'key' },
  { id: 'defaults', label: '默认与权限', icon: 'shield' },
  { id: 'appearance', label: '外观', icon: 'palette' },
  { id: 'about', label: '关于', icon: 'info' }
]
const PERMS = [
  ['ask', '询问', '写文件和执行前询问'],
  ['acceptEdits', '自动接受编辑', '自动写文件，执行前询问'],
  ['plan', '计划', '只读，先给计划'],
  ['bypass', '完全放行', '全部自动执行']
]
const AUTH = { bearer: 'Authorization: Bearer', 'x-api-key': 'x-api-key', 'api-key': 'api-key（Azure）', 'x-goog-api-key': 'x-goog-api-key（Gemini）' }

let tab = 'models'
let selected = null
let lastResult = null

export async function renderSettings (root, arg) {
  if (arg) tab = arg
  const m = await api('/api/models')
  root.innerHTML = `<div class="page glass dark">
    <div class="page-head"><h1>设置</h1></div>
    <div class="set-layout">
      <nav class="set-nav">${TABS.map((t) => `<button type="button" class="${tab === t.id ? 'on' : ''}" data-t="${t.id}">${icon(t.icon, 16)}<span>${t.label}</span></button>`).join('')}</nav>
      <div class="set-body" id="setBody"></div>
    </div></div>`
  root.querySelector('.set-nav').onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) { tab = b.dataset.t; renderSettings(root) } }
  const body = root.querySelector('#setBody')
  if (tab === 'models') return models(body, m, root)
  if (tab === 'defaults') return defaults(body, m, root)
  if (tab === 'appearance') return appearance(body)
  return about(body)
}

// ---------------------------------------------------------------- providers
function models (body, m, root) {
  const provs = m.providers
  if (!selected || !provs.some((p) => p.id === selected)) selected = (provs.find((p) => p.hasKey) || provs[0]).id
  const p = provs.find((x) => x.id === selected)
  const fetched = p.modelsSource === 'live'
  body.innerHTML = `<div class="prov-layout">
    <div class="prov-list">
      ${provs.map((x) => `<div class="prov-item ${x.id === selected ? 'on' : ''}" data-p="${esc(x.id)}">${esc(x.label)}${x.custom ? ' <span class="badge">自定义</span>' : ''}<i class="st ${x.hasKey ? 'on' : ''}"></i></div>`).join('')}
      <button class="btn ghost small" id="addCustom" type="button" style="margin-top:10px">${icon('plus', 14)}添加自定义厂商</button>
    </div>
    <div class="prov-detail">
      <div class="panel">
        <h3>${esc(p.label)}</h3>
        ${p.apiKeyUrl ? `<p><a href="${esc(p.apiKeyUrl)}" target="_blank" rel="noopener" class="muted">获取 API Key</a></p>` : ''}
        <div class="field"><span class="lbl">协议</span>
          <div class="proto-grid">${m.protocols.map((pr) => `<button type="button" class="proto ${p.protocol === pr.id ? 'on' : ''}" data-proto="${pr.id}">
            <span class="n">${esc(pr.label)}${p.custom ? '' : p.defaultProtocol === pr.id ? ' <span class="badge accent">官方默认</span>' : p.official.includes(pr.id) ? ' <span class="badge">官方支持</span>' : ''}</span>
            <span class="d">${esc(p.custom ? (p.protocol === pr.id ? p.baseUrl : '') : p.bases?.[pr.id] || '需要自行填写 URL')}</span></button>`).join('')}</div>
        </div>
        ${p.regions?.length ? `<div class="field"><span class="lbl">区域</span><div class="seg">${p.regions.map((r) => `<button type="button" class="${p.region === r.id ? 'on' : ''}" data-region="${esc(r.id)}">${esc(r.label)}</button>`).join('')}</div></div>` : ''}
        <div class="field"><span class="lbl">Base URL</span>
          <div class="inline"><input class="input" id="baseUrl" value="${esc(p.baseUrl.includes('<') ? '' : p.baseUrl)}" placeholder="${esc(p.defaultBaseUrl || 'https://…/v1')}" spellcheck="false">
          ${p.defaultBaseUrl && p.baseUrl !== p.defaultBaseUrl && !p.defaultBaseUrl.includes('<') ? '<button class="btn ghost small" id="resetUrl" type="button">恢复默认</button>' : ''}
          <button class="btn ghost small" id="saveUrl" type="button">保存</button></div>
          <div class="hint">请求地址：<code>${esc(endpointPreview(p))}</code></div>
        </div>
        <label class="faint"><input type="checkbox" id="privateGateway" ${p.gatewayPrivateAccess ? 'checked' : ''}> 允许此自定义网关访问内网地址</label>
        ${p.baseUrl && !p.gatewayApproved && !p.baseUrl.includes('<') ? '<p class="muted">请保存并确认当前网关地址，再填写 API Key。</p>' : ''}
        ${p.id === 'azure'
          ? `<div class="row2"><div class="field"><span class="lbl">认证请求头</span><select class="input" id="authHeader">${Object.entries(AUTH).map(([k, v]) => `<option value="${k}" ${p.authHeader === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
             <div class="field"><span class="lbl">API 版本</span><div class="inline"><input class="input" id="apiVersion" value="${esc(p.apiVersion || '')}" placeholder="2024-10-21" spellcheck="false"><button class="btn ghost small" id="saveApiVersion" type="button">保存</button></div></div></div>`
          : p.custom ? `<div class="field"><span class="lbl">认证请求头</span><select class="input" id="authHeader">${Object.entries(AUTH).map(([k, v]) => `<option value="${k}" ${p.authHeader === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>` : ''}
        <div class="field"><span class="lbl">API Key</span>
          <div class="inline"><input class="input" id="apiKey" type="password" autocomplete="off" placeholder="${p.hasKey ? '已保存，输入新值可替换' : '粘贴 API Key'}"><button class="btn ${p.hasKey ? 'ghost' : 'primary'} small" id="saveKey" type="button">保存</button>${p.hasKey ? '<button class="btn ghost small" id="clearKey" type="button">清除</button>' : ''}</div>
        </div>
        <div class="inline">
          <button class="btn primary small" id="fetchModels" type="button" ${p.hasKey ? '' : 'disabled'}>${icon('refresh', 14)}获取模型</button>
          <select class="input" id="testModel" style="max-width:260px" ${p.models.length ? '' : 'disabled'}>${p.models.map((x) => `<option>${esc(x.id)}</option>`).join('')}</select>
          <button class="btn ghost small" id="testConn" type="button" ${p.hasKey && p.models.length ? '' : 'disabled'}>测试连接</button>
          ${p.custom ? '<button class="btn danger small" id="delProv" type="button" style="margin-left:auto">删除厂商</button>' : ''}
        </div>
        ${lastResult?.p === p.id ? `<div class="result ${lastResult.ok ? 'ok' : 'bad'}">${esc(lastResult.text)}</div>` : ''}
      </div>
      <div class="panel">
        <h3>模型 <span class="faint" style="font-size:12px;font-weight:400">${p.models.length}</span></h3>
        ${p.models.length ? `<div class="table-wrap"><table class="mtable"><tr><th>模型 ID</th><th>上下文</th><th>最大输出</th><th>图片</th><th>思考程度 · <code>${esc(p.reasoningParam || '')}</code></th><th></th></tr>
          ${p.models.map((x) => { const ref = `${p.id}/${x.id}`; const isDef = m.defaults.model === ref; return `<tr><td class="mono">${esc(x.id)}</td><td>${x.contextWindow ? `${Math.round(x.contextWindow / 1000)}K` : '<span class="faint">—</span>'}</td><td>${x.maxOutputTokens ? `${Math.round(x.maxOutputTokens / 1000)}K` : '<span class="faint">—</span>'}</td><td>${x.vision ? '支持' : '<span class="faint">—</span>'}</td>
            <td>${x.reasoningEffort?.supported ? (x.reasoningEffort.values || []).map((v) => `<span class="badge">${esc(v)}</span>`).join(' ') || '支持' : '<span class="faint">不支持</span>'}</td>
            <td>${isDef ? '<span class="badge accent">默认</span>' : p.hasKey ? `<button class="btn ghost small" data-def="${esc(ref)}" type="button">设为默认</button>` : ''}</td></tr>` }).join('')}</table></div>` : '<p class="muted">还没有模型</p>'}
      </div>
    </div></div>`

  const rerender = () => renderSettings(root)
  const save = async (patch, msg) => {
    try { await put(`/api/providers/${p.id}`, patch); await store.refresh(); if (msg) toast(msg, 'ok'); rerender() } catch (err) { toast(err.message, 'err') }
  }
  body.querySelector('.prov-list').onclick = (e) => { const it = e.target.closest('[data-p]'); if (it) { selected = it.dataset.p; rerender() } }
  body.querySelector('#addCustom').onclick = () => customDialog(m, root)
  body.querySelectorAll('[data-proto]').forEach((b) => (b.onclick = () => save({ protocol: b.dataset.proto })))
  body.querySelectorAll('[data-region]').forEach((b) => (b.onclick = () => save({ region: b.dataset.region })))
  body.querySelector('#saveUrl').onclick = async () => {
    try {
      const raw = body.querySelector('#baseUrl').value.trim()
      if (!raw) return save({ baseUrl: '' }, '已恢复默认 URL')
      const base = new URL(raw).href.replace(/\/+$/, '')
      const privateGateway = body.querySelector('#privateGateway').checked
      if (base !== p.defaultBaseUrl && !(await confirmDialog({
        title: '确认网关地址', message: `允许连接 ${base}${privateGateway ? '（允许内网地址）' : ''}。更换来源后需重新填写该来源的 API Key。`, confirmText: '授权并保存'
      }))) return
      await save({ baseUrl: base, confirmGateway: base, privateGateway }, 'Base URL 已保存')
    } catch { toast('Base URL 格式不对', 'err') }
  }
  body.querySelector('#resetUrl')?.addEventListener('click', () => save({ baseUrl: '' }, '已恢复默认 URL'))
  body.querySelector('#authHeader')?.addEventListener('change', (e) => save({ authHeader: e.target.value }))
  body.querySelector('#saveApiVersion')?.addEventListener('click', () => {
    const v = body.querySelector('#apiVersion').value.trim()
    save({ apiVersion: v }, v ? 'API 版本已保存' : '已清除 API 版本')
  })
  body.querySelector('#saveKey').onclick = () => { const v = body.querySelector('#apiKey').value.trim(); if (v) save({ key: v }, 'API Key 已保存到本机 .env') }
  body.querySelector('#clearKey')?.addEventListener('click', async () => { if (await confirmDialog({ title: '清除 API Key', message: `从 .env 删除 ${p.apiKeyEnv}？`, confirmText: '清除', danger: true })) save({ key: '' }, '已清除') })
  body.querySelector('#delProv')?.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: '删除自定义厂商', message: `删除「${p.label}」的设置？`, confirmText: '删除', danger: true }))) return
    await del(`/api/providers/${p.id}`); selected = null; await store.refresh(); rerender()
  })
  body.querySelector('#fetchModels').onclick = async (e) => {
    e.target.disabled = true
    try {
      const r = await post(`/api/providers/${p.id}/models`)
      lastResult = { p: p.id, ok: true, text: `已从上游读取 ${r.count} 个模型` }
    } catch (err) { lastResult = { p: p.id, ok: false, text: `获取失败：${err.message}` } }
    await store.refresh(); rerender()
  }
  body.querySelector('#testConn').onclick = async (e) => {
    e.target.disabled = true
    e.target.textContent = '测试中…'
    const model = body.querySelector('#testModel').value
    try {
      const r = await post(`/api/providers/${p.id}/test`, { model })
      lastResult = { p: p.id, ok: true, text: `连接成功 · ${model} · ${r.latencyMs} ms · 回复「${r.text || '（空）'}」${r.usage ? ` · ${r.usage.inputTokens}+${r.usage.outputTokens} tokens` : ''}` }
    } catch (err) { lastResult = { p: p.id, ok: false, text: `连接失败：${err.message}` } }
    rerender()
  }
  body.querySelectorAll('[data-def]').forEach((b) => (b.onclick = async () => { await put('/api/settings/defaults', { model: b.dataset.def }); await store.refresh(); toast('已设为默认模型', 'ok'); rerender() }))
}

function endpointPreview (p) {
  const base = (p.baseUrl || p.defaultBaseUrl || '').replace(/\/+$/, '')
  if (!base || base.includes('<')) return '（先填写 Base URL）'
  const q = p.apiVersion ? `?api-version=${p.apiVersion}` : ''
  if (p.protocol === 'chat-completions') return `${base.endsWith('/chat/completions') ? base : `${base}/chat/completions`}${q}`
  if (p.protocol === 'responses') return `${base}/responses${q}`
  if (p.protocol === 'messages') return `${base.endsWith('/messages') ? base : /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`}${q}`
  return `${base}/models/{model}:streamGenerateContent`
}

function customDialog (m, root) {
  openModal({
    title: '添加自定义厂商',
    bodyHtml: `<form class="modal-form" id="cf">
      <div class="row2"><div class="field"><label class="lbl">标识（小写字母、数字、-）</label><input class="input" name="id" required pattern="[a-z0-9][a-z0-9-]{1,30}" placeholder="lab-gateway"></div>
      <div class="field"><label class="lbl">显示名</label><input class="input" name="label" placeholder="实验室网关"></div></div>
      <div class="field"><label class="lbl">协议</label><select class="input" name="protocol">${m.protocols.map((p) => `<option value="${p.id}">${p.label}</option>`).join('')}</select></div>
      <div class="field"><label class="lbl">Base URL</label><input class="input" name="baseUrl" required placeholder="https://example.com/v1" spellcheck="false"><label><input name="privateGateway" type="checkbox"> 允许访问内网地址</label></div>
      <div class="field"><label class="lbl">模型 ID</label><input class="input" name="models" placeholder="model-a, model-b"></div>
      <div class="field"><label class="lbl">API Key</label><input class="input" name="key" type="password" autocomplete="off"></div>
      <div class="modal-actions"><button class="btn primary" type="submit">授权并添加</button></div></form>`,
    onMount: (el, close) => {
      el.querySelector('#cf').onsubmit = async (e) => {
        e.preventDefault()
        const f = Object.fromEntries(new FormData(e.target))
        try {
          const base = new URL(f.baseUrl).href.replace(/\/+$/, '')
          await put(`/api/providers/${f.id}`, { custom: true, label: f.label || f.id, protocol: f.protocol, baseUrl: base, confirmGateway: base, privateGateway: f.privateGateway === 'on', models: f.models, ...(f.key ? { key: f.key } : {}) })
          selected = f.id
          close(); await store.refresh(); renderSettings(root)
        } catch (err) { toast(err.message, 'err') }
      }
    }
  })
}

// ---------------------------------------------------------------- defaults & permissions
function defaults (body, m, root) {
  const all = m.providers.filter((p) => p.hasKey).flatMap((p) => p.models.map((x) => ({ ref: `${p.id}/${x.id}`, label: `${p.label} · ${x.id}`, x })))
  const opt = (sel, emptyLabel) => `<option value="">${emptyLabel}</option>${all.map((a) => `<option value="${esc(a.ref)}" ${sel === a.ref ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}`
  const d = m.defaults
  const execution = m.execution
  body.innerHTML = `
    <div class="panel"><h3>默认模型</h3>
      ${all.length ? `<div class="row2">
        <div class="field"><label class="lbl">主模型</label><select class="input" data-k="model">${opt(d.model, '未设置（使用第一个可用模型）')}</select></div>
        <div class="field"><label class="lbl">轻量模型</label><select class="input" data-k="fast">${opt(d.fast, '跟随主模型')}</select></div>
        <div class="field"><label class="lbl">视觉模型</label><select class="input" data-k="vision">${opt(d.vision, '跟随主模型')}</select></div>
      </div>` : '<p class="muted">还没有可用模型</p>'}
    </div>
    <div class="panel"><h3>默认权限模式</h3>
      <div class="perm-grid">${PERMS.map(([id, label, desc]) => `<button type="button" class="proto ${(d.permission || 'ask') === id ? 'on' : ''}" data-perm="${id}"><span class="n">${label}</span><span class="d" style="font-family:var(--sans)">${desc}</span></button>`).join('')}</div>
    </div>
    <div class="panel"><h3>运行环境</h3>
      <div class="env-row"><span>Python</span><span class="muted" id="env-python">检测中…</span><button class="btn ghost small" data-setup="python" type="button">安装</button></div>
      <div class="env-row"><span>容器镜像</span><span class="muted" id="env-sandbox">检测中…</span><button class="btn ghost small" data-setup="sandbox" type="button">构建</button></div>
      <pre class="env-log" id="env-log" hidden></pre>
    </div>
    <div class="panel"><h3>代码执行</h3>
      <p class="muted" id="execution-status">检测中…</p>
      <form id="execution-settings" class="modal-form">
        <label class="field-label">容器命令<input class="input" name="engine" value="${esc(execution.engine)}" required></label>
        <label class="field-label">本地执行镜像<input class="input" name="image" value="${esc(execution.image)}" required></label>
        <label class="field-label"><input name="hostMode" type="checkbox" ${execution.hostMode ? 'checked' : ''}> 容器不可用时启用宿主模式</label>
        <p class="warn" id="hostWarn" style="color:var(--danger)" ${execution.hostMode ? '' : 'hidden'}>模型代码将以你的账户权限运行，可访问项目外的文件。</p>
        <button class="btn ghost small" type="submit">保存代码执行设置</button>
      </form>
    </div>`
  body.querySelector('[name="hostMode"]').onchange = (e) => { body.querySelector('#hostWarn').hidden = !e.target.checked }
  const statusLine = body.querySelector('#execution-status')
  // Runtime setup: install the Python environment or build the sandbox image without a terminal.
  const envLine = (id, text, button) => { body.querySelector(`#env-${id}`).textContent = text; const b = body.querySelector(`[data-setup="${id}"]`); if (button) b.textContent = button }
  const refreshEnv = async () => {
    if (!body.isConnected) return
    try {
      const [py, sb, ex] = await Promise.all([api('/api/setup/python'), api('/api/setup/sandbox'), api('/api/settings/execution/status')])
      envLine('python', py.running ? '安装中…' : py.ready ? '已就绪' : py.ok === false ? '安装失败' : '未安装', py.ready ? '重新安装' : '安装')
      envLine('sandbox', sb.running ? '构建中…' : ex.state === 'ready' ? '已就绪' : sb.ok === false ? '构建失败' : ex.state === 'engine' ? '未检测到 Docker' : '未构建', ex.state === 'ready' ? '重新构建' : '构建')
      const fallback = ex.hostMode ? '使用宿主模式' : '代码执行已停用'
      statusLine.textContent = ex.state === 'ready' ? '容器可用' : ex.state === 'image' ? `缺少执行镜像 · ${fallback}` : `未检测到 Docker · ${fallback}`
      const shown = [py, sb].find((j) => j.running) || [py, sb].find((j) => j.ok === false && j.log)
      const log = body.querySelector('#env-log')
      log.hidden = !shown
      if (shown) { log.textContent = shown.log.split('\n').slice(-12).join('\n'); log.scrollTop = log.scrollHeight }
      body.querySelectorAll('[data-setup]').forEach((b) => { b.disabled = py.running || sb.running })
      if (py.running || sb.running) setTimeout(refreshEnv, 1500)
    } catch { statusLine.textContent = '无法检测运行环境' }
  }
  body.querySelectorAll('[data-setup]').forEach((b) => (b.onclick = async () => {
    try { await post(`/api/setup/${b.dataset.setup}`); refreshEnv() } catch (err) { toast(err.message, 'err') }
  }))
  refreshEnv()
  body.querySelector('#execution-settings').onsubmit = async (event) => {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    const hostMode = fields.has('hostMode')
    if (hostMode && !execution.hostMode && !(await confirmDialog({
      title: '启用宿主模式', message: '模型代码将以你的账户权限运行，可读写项目外的文件。', danger: true, confirmText: '确认启用'
    }))) return
    try {
      await put('/api/settings/execution', { engine: fields.get('engine'), image: fields.get('image'), hostMode, confirmHostMode: hostMode })
      toast('已保存', 'ok')
      await renderSettings(root)
    } catch (error) { toast(error.message, 'err') }
  }
  body.querySelectorAll('select[data-k]').forEach((s) => (s.onchange = async () => { try { await put('/api/settings/defaults', { [s.dataset.k]: s.value }); await store.refresh(); toast('已保存', 'ok') } catch (err) { toast(err.message, 'err') } }))
  body.querySelectorAll('[data-perm]').forEach((b) => (b.onclick = async () => { await put('/api/settings/defaults', { permission: b.dataset.perm }); await store.refresh(); renderSettings(root) }))
}

// ---------------------------------------------------------------- appearance / about
function appearance (body) {
  let q = 'auto'
  try { q = localStorage.getItem('evoscholar.fxQuality') || 'auto' } catch {}
  const Q = [['auto', '自动', '按设备性能选择'], ['high', '高', '262,144 个粒子'], ['mid', '中', '65,536 个粒子'], ['low', '低', '16,384 个粒子'], ['off', '关闭', '纯色背景，最省电']]
  const theme = themePreference()
  const T = [['dark', '深色', '深色背景，适合暗光环境'], ['light', '浅色', '浅色背景，适合明亮环境和投影'], ['system', '跟随系统', '随操作系统的深色、浅色设置切换']]
  body.innerHTML = `<div class="panel"><h3>界面主题</h3>
    ${T.map(([id, l, d]) => `<div class="opt-row"><div class="t"><b>${l}</b><span>${d}</span></div><button class="switch ${theme === id ? 'on' : ''}" data-theme-pref="${id}" type="button" aria-label="${l}"></button></div>`).join('')}</div>
    <div class="panel"><h3>背景粒子</h3>
    ${Q.map(([id, l, d]) => `<div class="opt-row"><div class="t"><b>${l}</b><span>${d}</span></div><button class="switch ${q === id ? 'on' : ''}" data-q="${id}" type="button" aria-label="${l}"></button></div>`).join('')}</div>`
  body.querySelectorAll('[data-theme-pref]').forEach((b) => (b.onclick = async () => {
    const pref = b.dataset.themePref
    setThemePreference(pref)
    body.querySelectorAll('[data-theme-pref]').forEach((x) => x.classList.toggle('on', x === b))
    try { await put('/api/settings/ui', { theme: pref }); if (store.state) store.state.ui = { ...store.state.ui, theme: pref } } catch (err) { toast(err.message, 'err') }
  }))
  body.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => {
    setFxQuality(b.dataset.q)
    body.querySelectorAll('[data-q]').forEach((x) => x.classList.toggle('on', x === b))
  }))
}

function about (body) {
  const s = store.state
  const app = s.app || {}
  body.innerHTML = `<div class="panel"><h3>EvoScholar</h3>
    ${app.version ? `<div class="kv"><span>版本</span><span>${esc(app.version)}</span></div>` : ''}
    <div class="kv"><span>当前 genome</span><span><code>${esc(s.genome.id)}</code></span></div>
    ${app.workspace ? `<div class="kv"><span>工作区</span><span class="kv-path"><code title="${esc(app.workspace)}">${esc(app.workspace)}</code><button class="btn ghost small" id="revealWorkspace" type="button">在文件夹中显示</button></span></div>` : ''}
    <div class="kv"><span>项目文件</span><span><code>evoscholar-out/</code>、<code>evoscholar-in/</code></span></div>
    <div class="kv"><span>源代码</span><span><a href="https://github.com/Dylannn-7/EvoScholar" target="_blank" rel="noopener">github.com/Dylannn-7/EvoScholar</a></span></div>
    <button class="btn ghost small" id="reopenOnboarding" type="button">重新打开新手向导</button></div>
    <section class="panel" id="updatePanel"></section>`
  body.querySelector('#revealWorkspace')?.addEventListener('click', () => post('/api/workspace/reveal').catch((err) => toast(err.message, 'err')))
  body.querySelector('#reopenOnboarding').onclick = () => { goHome(); openOnboarding() }
  renderUpdates(body.querySelector('#updatePanel'))
}

document.addEventListener('evo:update-status', () => {
  const panel = document.querySelector('#updatePanel')
  if (panel) renderUpdates(panel)
})

function renderUpdates (panel) {
  const status = store.updateStatus
  const title = '<h3>版本与更新</h3>'
  if (!status?.supported) {
    panel.innerHTML = title + `<p class="muted">${status ? '打包版桌面应用可检查更新。' : '正在读取更新状态…'}</p>`
    return
  }
  const date = status.publishedAt ? new Date(status.publishedAt).toLocaleDateString('zh-CN') : ''
  const labels = {
    idle: `当前版本 v${status.currentVersion}`,
    checking: '正在检查…',
    'up-to-date': `已是最新版本（v${status.currentVersion}）`,
    available: `发现新版本 v${status.latestVersion}${date ? `（发布于 ${date}）` : ''}`,
    error: `检查失败：${status.error}`
  }
  const available = status.phase === 'available'
  const asset = status.asset
  const windows = asset ? asset.name.endsWith('.exe') : navigator.platform.startsWith('Win')
  panel.innerHTML = title + `
    <div class="opt-row"><div class="t"><b>启动时自动检查更新</b>
      <span>只向 GitHub 查询最新版本号和安装包地址，请求中只有当前版本号，不上传任何会话、密钥或项目数据。</span></div>
      <button class="switch ${status.autoCheck ? 'on' : ''}" data-auto-check type="button" role="switch" aria-label="启动时自动检查更新" aria-checked="${status.autoCheck}"></button></div>
    <div class="inline update-status"><span role="status">${esc(labels[status.phase])}</span>
      <button class="btn ghost small" data-check-update type="button" ${status.phase === 'checking' ? 'disabled' : ''}>检查更新</button></div>
    ${available ? `
      ${status.releaseNotes ? `<div class="update-notes" tabindex="0" aria-label="更新说明">${md(status.releaseNotes)}</div>` : ''}
      <div class="inline update-actions">
        ${asset ? `<a class="btn primary small" data-external-update href="${esc(asset.url)}" target="_blank" rel="noopener">下载安装包（${esc(asset.name)}，${fmtSize(asset.size)}）</a>` : '<span class="muted">此版本没有匹配的安装包。</span>'}
        <a class="btn ghost small" data-external-update href="${esc(status.releasePageUrl)}" target="_blank" rel="noopener">在 GitHub 查看</a>
        ${status.hasUnreadUpdate ? '<button class="btn ghost small" data-dismiss-update type="button">忽略此版本</button>' : '<span class="muted">已忽略此版本</span>'}
      </div>
      ${asset ? `<p class="muted update-install-hint">${windows ? '如出现 Windows 保护提示，点「更多信息」再点「仍要运行」。' : '在 macOS 上，将应用拖入「应用程序」并覆盖旧版本。若提示无法验证开发者，右键选择「打开」。'}</p>` : ''}
    ` : ''}`

  const bind = (selector, run) => {
    const button = panel.querySelector(selector)
    if (button) button.onclick = async () => {
      button.disabled = true
      try { await run() } catch (err) { toast(err.message, 'err') }
      finally { button.disabled = false }
    }
  }
  bind('[data-auto-check]', async () => store.applyUpdateStatus(await put('/api/settings/update', { autoCheck: !status.autoCheck })))
  bind('[data-check-update]', async () => {
    store.applyUpdateStatus({ ...status, phase: 'checking' })
    try { store.applyUpdateStatus(await post('/api/update/check')) }
    catch (err) { store.applyUpdateStatus(status); throw err }
  })
  bind('[data-dismiss-update]', () => dismissUpdate(status.latestVersion))
  panel.querySelectorAll('[data-external-update]').forEach((link) => {
    link.onclick = (event) => {
      event.preventDefault()
      const popup = window.open(link.href, 'evoscholar-update')
      if (popup) popup.opener = null
    }
  })
}
