// Settings: model providers (protocol → base URL → key → fetch models → test), defaults & permissions, appearance.
import { setFxQuality, store } from '../app.js'
import { api, del, put, post } from './api.js'
import { icon } from './icons.js'
import { confirmDialog, esc, openModal, toast } from './modal.js'

const TABS = [
  { id: 'models', label: '模型与密钥', icon: 'key' },
  { id: 'defaults', label: '默认与权限', icon: 'shield' },
  { id: 'appearance', label: '外观', icon: 'palette' },
  { id: 'about', label: '关于', icon: 'info' }
]
const PERMS = [
  ['ask', '询问', '写文件和执行命令前都先问你。最稳妥，适合刚开始用。'],
  ['acceptEdits', '自动接受编辑', '写文件自动进行，执行代码或命令前问你。'],
  ['plan', '计划', '只读：先分析并给出计划，你确认后再切换模式执行。'],
  ['bypass', '完全放行', '全部自动执行。仍然只能访问项目文件夹，进化确认仍需你点。']
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
        <p class="lede">选择协议，确认 Base URL，填写 API Key，然后获取模型并测试连接。${p.apiKeyUrl ? ` <a href="${esc(p.apiKeyUrl)}" target="_blank" rel="noopener" class="muted">获取 API Key</a>` : ''}</p>
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
        ${p.custom || p.id === 'azure' ? `<div class="field"><span class="lbl">认证请求头</span><select class="input" id="authHeader">${Object.entries(AUTH).map(([k, v]) => `<option value="${k}" ${p.authHeader === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>` : ''}
        <div class="field"><span class="lbl">API Key <span class="faint">· 只保存在本机 .env 的 ${esc(p.apiKeyEnv)}</span></span>
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
        <h3>模型 <span class="faint" style="font-size:12px;font-weight:400">${p.models.length} 个 · ${fetched ? `上游 /models 返回的原始名称 · 获取于 ${new Date(p.modelsFetchedAt).toLocaleString('zh-CN')}` : '预设列表，点「获取模型」读取上游的原始名称'}</span></h3>
        ${p.models.length ? `<div class="table-wrap"><table class="mtable"><tr><th>模型 ID</th><th>上下文</th><th>最大输出</th><th>图片</th><th>思考程度 · <code>${esc(p.reasoningParam || '')}</code></th><th></th></tr>
          ${p.models.map((x) => { const ref = `${p.id}/${x.id}`; const isDef = m.defaults.model === ref; return `<tr><td class="mono">${esc(x.id)}</td><td>${x.contextWindow ? `${Math.round(x.contextWindow / 1000)}K` : '<span class="faint">—</span>'}</td><td>${x.maxOutputTokens ? `${Math.round(x.maxOutputTokens / 1000)}K` : '<span class="faint">—</span>'}</td><td>${x.vision ? '支持' : '<span class="faint">—</span>'}</td>
            <td>${x.reasoningEffort?.supported ? (x.reasoningEffort.values || []).map((v) => `<span class="badge">${esc(v)}</span>`).join(' ') || '支持' : '<span class="faint">不支持</span>'}</td>
            <td>${isDef ? '<span class="badge accent">默认</span>' : p.hasKey ? `<button class="btn ghost small" data-def="${esc(ref)}" type="button">设为默认</button>` : ''}</td></tr>` }).join('')}</table></div>` : '<p class="muted">还没有模型。填写 API Key 后点「获取模型」。</p>'}
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
  body.querySelector('#saveUrl').onclick = () => save({ baseUrl: body.querySelector('#baseUrl').value.trim() }, 'Base URL 已保存')
  body.querySelector('#resetUrl')?.addEventListener('click', () => save({ baseUrl: '' }, '已恢复默认 URL'))
  body.querySelector('#authHeader')?.addEventListener('change', (e) => save({ authHeader: e.target.value }))
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
  if (p.protocol === 'chat-completions') return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
  if (p.protocol === 'responses') return `${base}/responses`
  if (p.protocol === 'messages') return base.endsWith('/messages') ? base : /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`
  return `${base}/models/{model}:streamGenerateContent`
}

function customDialog (m, root) {
  openModal({
    title: '添加自定义厂商',
    bodyHtml: `<form class="modal-form" id="cf">
      <div class="row2"><div class="field"><label class="lbl">标识（小写字母、数字、-）</label><input class="input" name="id" required pattern="[a-z0-9][a-z0-9-]{1,30}" placeholder="lab-gateway"></div>
      <div class="field"><label class="lbl">显示名</label><input class="input" name="label" placeholder="实验室网关"></div></div>
      <div class="field"><label class="lbl">协议</label><select class="input" name="protocol">${m.protocols.map((p) => `<option value="${p.id}">${p.label}</option>`).join('')}</select></div>
      <div class="field"><label class="lbl">Base URL</label><input class="input" name="baseUrl" required placeholder="https://example.com/v1" spellcheck="false"></div>
      <div class="field"><label class="lbl">模型 ID（可留空，保存后点「获取模型」）</label><input class="input" name="models" placeholder="model-a, model-b"></div>
      <div class="field"><label class="lbl">API Key</label><input class="input" name="key" type="password" autocomplete="off"></div>
      <div class="modal-actions"><button class="btn primary" type="submit">添加</button></div></form>`,
    onMount: (el, close) => {
      el.querySelector('#cf').onsubmit = async (e) => {
        e.preventDefault()
        const f = Object.fromEntries(new FormData(e.target))
        try {
          await put(`/api/providers/${f.id}`, { custom: true, label: f.label || f.id, protocol: f.protocol, baseUrl: f.baseUrl, models: f.models, ...(f.key ? { key: f.key } : {}) })
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
  body.innerHTML = `
    <div class="panel"><h3>默认模型</h3><p class="lede">新会话默认使用的模型；输入框里可以随时为单个会话换模型。轻量和视觉角色用于子任务（核对、读图），留空则跟随主模型。</p>
      ${all.length ? `<div class="row2">
        <div class="field"><label class="lbl">主模型</label><select class="input" data-k="model">${opt(d.model, '未设置（使用第一个可用模型）')}</select></div>
        <div class="field"><label class="lbl">轻量模型</label><select class="input" data-k="fast">${opt(d.fast, '跟随主模型')}</select></div>
        <div class="field"><label class="lbl">视觉模型</label><select class="input" data-k="vision">${opt(d.vision, '跟随主模型')}</select></div>
      </div>` : '<p class="muted">还没有可用模型。先到「模型与密钥」接入一个厂商。</p>'}
    </div>
    <div class="panel"><h3>默认权限模式</h3><p class="lede">新会话的权限模式。每个会话也可以在输入框里单独切换。</p>
      <div class="perm-grid">${PERMS.map(([id, label, desc]) => `<button type="button" class="proto ${(d.permission || 'ask') === id ? 'on' : ''}" data-perm="${id}"><span class="n">${label}</span><span class="d" style="font-family:var(--sans)">${desc}</span></button>`).join('')}</div>
    </div>`
  body.querySelectorAll('select[data-k]').forEach((s) => (s.onchange = async () => { try { await put('/api/settings/defaults', { [s.dataset.k]: s.value }); await store.refresh(); toast('已保存', 'ok') } catch (err) { toast(err.message, 'err') } }))
  body.querySelectorAll('[data-perm]').forEach((b) => (b.onclick = async () => { await put('/api/settings/defaults', { permission: b.dataset.perm }); await store.refresh(); renderSettings(root) }))
}

// ---------------------------------------------------------------- appearance / about
function appearance (body) {
  let q = 'auto'
  try { q = localStorage.getItem('evoscholar.fxQuality') || 'auto' } catch {}
  const Q = [['auto', '自动', '按设备性能选择'], ['high', '高', '262,144 个粒子'], ['mid', '中', '65,536 个粒子'], ['low', '低', '16,384 个粒子'], ['off', '关闭', '纯色背景，最省电']]
  body.innerHTML = `<div class="panel"><h3>背景粒子</h3><p class="lede">粒子会随智能体的思考、调用工具、等待确认和自我进化而变化。切换后立即生效。</p>
    ${Q.map(([id, l, d]) => `<div class="opt-row"><div class="t"><b>${l}</b><span>${d}</span></div><button class="switch ${q === id ? 'on' : ''}" data-q="${id}" type="button" aria-label="${l}"></button></div>`).join('')}</div>`
  body.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => {
    setFxQuality(b.dataset.q)
    body.querySelectorAll('[data-q]').forEach((x) => x.classList.toggle('on', x === b))
  }))
}

function about (body) {
  const s = store.state
  body.innerHTML = `<div class="panel"><h3>EvoScholar</h3><p class="lede">个人自进化科研工作台：文献检索、数据处理与出图、论文写作规范检查。进化的是 harness（提示词、技能、工具、路由、工作流），每一次持久修改都经你批准。</p>
    <div class="kv"><span>当前 genome</span><span><code>${esc(s.genome.id)}</code></span></div>
    <div class="kv"><span>数据</span><span>全部保存在本机：会话、轨迹和索引在 <code>data/</code>，API Key 在 <code>.env</code></span></div>
    <div class="kv"><span>项目文件</span><span>交付文件写在项目文件夹的 <code>evoscholar-out/</code>，上传文件在 <code>evoscholar-in/</code></span></div>
    <div class="kv"><span>源代码</span><span><a href="https://github.com/Dylannn-7/EvoScholar" target="_blank" rel="noopener">github.com/Dylannn-7/EvoScholar</a></span></div></div>`
}
