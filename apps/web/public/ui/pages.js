// Pages: plugins, library (资料空间), usage, trajectory.
import { go, store } from '../app.js'
import { ago, api, apiFetch, del, fmtSize, fmtTokens, loadApiImages, patch, post, put } from './api.js'
import { icon } from './icons.js'
import { confirmDialog, esc, openModal, promptDialog, toast } from './modal.js'
import { openFilePreviewModal } from './review.js'
import { chooseFolder } from './folder-picker.js'
import { md } from './markdown.js'

const shell = (root, title, desc, actions = '') => {
  root.innerHTML = `<div class="page glass dark"><div class="page-head"><h1>${title}</h1><div class="page-actions">${actions}</div>${desc ? `<div class="desc">${desc}</div>` : ''}</div><div class="page-body"></div></div>`
  return root.querySelector('.page-body')
}
const SOURCE = { builtin: ['内置', ''], evolved: ['进化产生', 'accent'], imported: ['导入', 'warn'] }
const srcBadge = (s) => { const [l, c] = SOURCE[s || 'builtin']; return `<span class="badge ${c}">${l}</span>` }

// ---------------------------------------------------------------- plugins
let pluginTab = 'skills'
export async function renderPlugins (root, arg) {
  if (typeof arg === 'string' && ['skills', 'tools', 'rules', 'styles'].includes(arg)) pluginTab = arg
  const body = shell(root, '插件', '',
    '<button class="btn primary small" id="importSkill" type="button">导入技能</button>')
  root.querySelector('#importSkill').onclick = () => importDialog(root)
  const [c, ur, st] = await Promise.all([api('/api/capabilities'), api('/api/plugins/rules'), api('/api/styles').catch(() => ({ styles: [], current: null }))])
  const counts = { skills: c.skills.length, tools: c.tools.length, rules: c.writingRulepacks.length + c.figureRulepacks.length + ur.rules.length, styles: st.styles.length }
  const sw = (on, attr) => `<button class="switch ${on ? 'on' : ''}" ${attr} type="button" aria-label="${on ? '停用' : '启用'}"></button>`
  const draw = () => {
    body.innerHTML = `<div class="toolbar"><div class="seg">${[['skills', '技能'], ['tools', '工具'], ['rules', '规则包'], ['styles', '出图风格']].map(([id, l]) => `<button type="button" class="${pluginTab === id ? 'on' : ''}" data-t="${id}">${l} ${counts[id]}</button>`).join('')}</div></div><div id="pl"></div>`
    const pl = body.querySelector('#pl')
    if (pluginTab === 'skills') {
      pl.innerHTML = `<div class="cards">${c.skills.map((s) => `<div class="pcard ${(s.kernel ? !s.disabled : s.enabled) ? '' : 'off'}" data-skill="${esc(s.name)}"><div class="top">${icon(s.kernel ? 'code' : 'plugins', 16)}<span class="nm">${esc(s.name)}</span>${srcBadge(s.source)}${s.source === 'imported' && s.trusted ? '<span class="badge ok">已信任</span>' : ''}${s.kernel ? `<span class="badge ${s.status === 'active' ? 'ok' : 'warn'}">${s.status === 'active' ? '已转正' : '试用'}</span>` : ''}</div>
        <div class="ds">${esc(s.description || '')}</div>
        <div class="ft"><span>v${s.activeVersion ?? s.version}</span>${s.kernel ? `<span>复用 ${s.reuses || 0} 次</span>` : ''}${s.license ? (/^https?:/.test(s.license) ? `<a class="muted" href="${esc(s.license)}" target="_blank" rel="noopener">许可证</a>` : `<span>${esc(s.license.replace(/ license$/i, ''))}</span>`) : ''}${s.origin && s.origin.startsWith('http') ? `<a class="muted" href="${esc(s.origin)}" target="_blank" rel="noopener">来源</a>` : ''}
          <span class="page-actions">${s.source !== 'builtin' ? `<button class="icon-btn" data-del="${esc(s.name)}" title="删除" type="button">${icon('trash', 14)}</button>` : ''}${s.kernel ? sw(!s.disabled, `data-ken="${esc(s.name)}"`) : sw(s.enabled, `data-en="${esc(s.name)}"`)}</span></div></div>`).join('')}</div>`
    } else if (pluginTab === 'tools') {
      pl.innerHTML = `<div class="cards">${c.tools.map((t) => `<div class="pcard ${t.enabled ? '' : 'off'}"><div class="top">${icon('code', 16)}<span class="nm"><code>${esc(t.name)}</code></span>${srcBadge(t.source)}</div>
        <div class="ds">${esc(t.description)}</div><div class="ft">${t.enabled ? '<span class="badge ok">已启用</span>' : '<span class="badge">未启用</span>'}</div></div>`).join('')}</div>`
    } else if (pluginTab === 'rules') {
      const fb = new Map((c.feedbackStats || []).map((x) => [x.rule, x]))
      pl.innerHTML = `<div class="section-t">我的规则 · 使用中沉淀</div>${ur.rules.length ? `<div class="cards">${ur.rules.map((r) => `<div class="pcard ${r.status === 'disabled' ? 'off' : ''}" data-rule="${esc(r.id)}"><div class="top">${icon('edit', 16)}<span class="nm"><code>${esc(r.id)}</code></span><span class="badge ${r.status === 'active' ? 'ok' : r.status === 'trial' ? 'warn' : ''}">${{ active: '生效', trial: '试用（以提示出现）', disabled: '已停用' }[r.status]}</span></div>
          <div class="ds" style="-webkit-line-clamp:6"><b style="color:#fff;font-weight:500">${esc(r.description)}</b><br>${esc(r.params?.message || '')}${r.params?.phrases ? `<br><span class="faint">短语：${esc(r.params.phrases.join('、'))}</span>` : ''}${r.params?.regex ? `<br><span class="faint">正则：<code>${esc(r.params.regex)}</code></span>` : ''}${r.note ? `<br><span class="faint">依据：${esc(r.note)}</span>` : ''}</div>
          <div class="ft">${r.source ? `<a class="muted" data-sess="${esc(r.source)}" style="cursor:pointer">来源会话</a>` : ''}<span class="page-actions">${r.status !== 'active' ? '<button class="btn primary small" data-rs="active" type="button">采纳</button>' : ''}${r.status !== 'disabled' ? '<button class="btn ghost small" data-rs="disabled" type="button">停用</button>' : ''}<button class="icon-btn" data-rdel="1" title="删除" type="button">${icon('trash', 14)}</button></span></div></div>`).join('')}</div>` : '<p class="muted">还没有。智能体发现稿件检查漏掉的问题或你反复纠正的写法时，会用 propose_rule 提出规则，先以提示出现，你采纳后生效。</p>'}
        <div class="section-t">写作规范</div><div class="cards">${c.writingRulepacks.map((r) => `<div class="pcard"><div class="top">${icon('file', 16)}<span class="nm">${esc(r.name)}</span>${r.status === 'verified' ? '<span class="badge ok">已核实</span>' : '<span class="badge warn">待完善</span>'}</div>
          <div class="ds">${esc(r.description || '')}</div><div class="ft"><code>${esc(r.id)}</code><span>${r.ruleCount} 条规则</span>${r.verifyCount ? `<span>${r.verifyCount} 条待人工核对</span>` : ''}${r.variants.length ? `<span>${r.variants.map((v) => esc(v.label)).join(' / ')}</span>` : ''}</div></div>`).join('')}</div>
        <div class="section-t">期刊出图</div><div class="cards">${c.figureRulepacks.map((r) => `<div class="pcard"><div class="top">${icon('image', 16)}<span class="nm">${esc(r.name)}</span></div>
          <div class="ds">${[r.widthMm?.single ? `单栏 ${r.widthMm.single} mm` : '', r.widthMm?.double ? `双栏 ${r.widthMm.double} mm` : '', r.fontPt?.min ? `字号 ${r.fontPt.min}–${r.fontPt.max ?? ''} pt` : '', r.rasterMinDpi ? `位图 ≥ ${r.rasterMinDpi} dpi` : '', r.formats?.length ? r.formats.join(' / ') : ''].filter(Boolean).join(' · ')}</div><div class="ft"><code>${esc(r.id)}</code></div></div>`).join('')}</div>
        ${fb.size ? `<div class="section-t">规则反馈（误报 / 有效）</div><div class="bars">${[...fb.values()].slice(0, 20).map((x) => `<div class="bar-row"><span class="l"><code>${esc(x.rule)}</code></span><span class="tr"><i class="c-out" style="width:${(100 * (x.valid || 0)) / Math.max(1, x.total || 1)}%"></i><i style="background:var(--danger);width:${(100 * (x.false_positive || 0)) / Math.max(1, x.total || 1)}%"></i></span><span class="n">${x.false_positive || 0} / ${x.valid || 0}</span></div>`).join('')}</div>` : ''}`
    } else {
      const groups = [...new Set(st.styles.map((x) => x.group))]
      pl.innerHTML = `
        ${groups.map((g) => `<div class="section-t">${esc(g)}</div><div class="cards style-cards">${st.styles.filter((x) => x.group === g).map((x) => `<div class="pcard style ${st.current === x.id ? 'cur' : ''}" data-style="${esc(x.id)}">
          <div class="sprev"><img loading="lazy" data-api-image="/api/styles/${esc(x.id)}/preview?v=2" alt="${esc(x.label)} 样图"></div>
          <div class="top"><span class="nm">${esc(x.label)}</span><span class="badge">${esc(x.library)}</span>${st.current === x.id ? '<span class="badge accent">默认</span>' : ''}</div>
          <div class="ds">${esc(x.description)}</div>
          ${styleFacts(x.meta)}
          <div class="ft"><code>${esc(x.id)}</code><span>${esc(x.license)}</span>${x.cite ? `<span title="${esc(x.cite)}">需引用</span>` : ''}<span class="page-actions"><button class="btn ghost small" data-copy="${esc(x.id)}" type="button">复制用法</button>${st.current === x.id ? '<button class="btn ghost small" data-def="" type="button">取消默认</button>' : `<button class="btn primary small" data-def="${esc(x.id)}" type="button">设为默认</button>`}</span></div></div>`).join('')}</div>`).join('')}`
    }
    loadApiImages(pl)
  }
  draw()
  body.onclick = async (e) => {
    const t = e.target.closest('[data-t]'); if (t) { pluginTab = t.dataset.t; return draw() }
    const sl = e.target.closest('[data-sess]'); if (sl) { go('workbench'); return document.dispatchEvent(new CustomEvent('evo:open-session', { detail: sl.dataset.sess })) }
    try {
      const ken = e.target.closest('[data-ken]')
      if (ken) { await patch(`/api/plugins/skills/${ken.dataset.ken}`, { kernelEnabled: !ken.classList.contains('on') }); return renderPlugins(root) }
      const en = e.target.closest('[data-en]')
      if (en) { await patch(`/api/plugins/skills/${en.dataset.en}`, { enabled: !en.classList.contains('on') }); await store.refresh(); toast('已更新，生成了新的 harness 版本', 'ok'); return renderPlugins(root) }
      const d = e.target.closest('[data-del]')
      if (d) { if (!(await confirmDialog({ title: '删除技能', message: `删除 ${d.dataset.del}？`, confirmText: '删除', danger: true }))) return; await del(`/api/plugins/skills/${d.dataset.del}`); return renderPlugins(root) }
      const rs = e.target.closest('[data-rs]')
      if (rs) { await patch(`/api/plugins/rules/${rs.closest('[data-rule]').dataset.rule}`, { status: rs.dataset.rs }); return renderPlugins(root) }
      const rd = e.target.closest('[data-rdel]')
      if (rd) { await del(`/api/plugins/rules/${rd.closest('[data-rule]').dataset.rule}`); return renderPlugins(root) }
      const card = e.target.closest('.pcard[data-skill]')
      if (card && !e.target.closest('button, a, input')) return openSkillDetail(root, card.dataset.skill)
      const df = e.target.closest('[data-def]')
      if (df) { await put('/api/settings/defaults', { figureStyle: df.dataset.def }); toast(df.dataset.def ? '已设为默认出图风格' : '已取消默认', 'ok'); return renderPlugins(root) }
      const cp = e.target.closest('[data-copy]')
      if (cp) { await navigator.clipboard.writeText(`import evoscholar_styles as S\nS.use('${cp.dataset.copy}', venue='nature')`); toast('已复制', 'ok') }
    } catch (err) { toast(err.message, 'err') }
  }
}

/** Palette swatches and the hard parameters that separate look-alike styles. */
function styleFacts (m) {
  if (!m || m.error) return ''
  const facts = [
    m.font ? `字体 ${m.font}` : '',
    m.font_pt ? `${m.font_pt} pt` : '',
    m.width_in ? `图宽 ${Math.round(m.width_in * 25.4)} mm` : '',
    m.grid ? '网格' : '无网格',
    m.ticks === 'in' ? '刻度朝内' : m.ticks === 'inout' ? '刻度内外' : '刻度朝外',
    m.linestyles ? '线型循环' : '',
    m.cmap && m.cmap !== 'viridis' ? `色图 ${m.cmap}` : ''
  ].filter(Boolean)
  return `<div class="sfacts"><span class="sw">${(m.colors || []).map((c) => `<i style="background:${esc(c)}" title="${esc(c)}"></i>`).join('')}</span><span class="sf">${facts.map(esc).join(' · ')}</span></div>`
}

/** Read-only view of one skill: body, revisions, bundled files, forged source; trust and on/off. */
async function openSkillDetail (root, name) {
  let d
  try { d = await api(`/api/plugins/skills/${encodeURIComponent(name)}`) } catch (err) { return toast(err.message, 'err') }
  const src = d.source || {}
  const imported = ['github', 'zip', 'folder'].includes(src.type)
  const kind = src.type === 'forged' ? '锻造' : src.bundled ? '随应用附带' : imported ? '导入' : '内置'
  openModal({
    title: name,
    wide: true,
    bodyHtml: `
      <div class="skd-meta"><span class="badge">${kind}</span>${d.versions.map((v) => `<span class="faint">v${v}</span>`).join('')}${src.origin && /^https:\/\//.test(src.origin) ? `<a class="muted" href="${esc(src.origin)}" target="_blank" rel="noopener">来源</a>` : ''}</div>
      ${d.description ? `<p class="skd-desc">${esc(d.description)}</p>` : ''}
      ${imported && !src.bundled ? `<label class="inline skd-opt"><input type="checkbox" id="skTrust" ${src.trusted ? 'checked' : ''}> 信任这个技能</label>` : ''}
      ${src.type === 'forged' ? `<label class="inline skd-opt"><input type="checkbox" id="skKernel" ${src.disabled ? '' : 'checked'}> 启用</label>` : ''}
      <div class="msg assistant skd-body">${md(d.body || '')}</div>
      ${d.kernel ? Object.entries(d.kernel).map(([file, code]) => `<h4 class="skd-h">${esc(file)}</h4><pre class="skd-code">${esc(code)}</pre>`).join('') : ''}
      ${d.files.length ? `<h4 class="skd-h">附带文件</h4><div class="skd-files">${d.files.map((f) => `<button type="button" class="skd-file" data-f="${esc(f.path)}" ${f.text ? '' : 'disabled'}><span>${esc(f.path)}</span><span class="faint">${fmtSize(f.size)}</span></button>`).join('')}</div><pre class="skd-code" id="skFile" hidden></pre>` : ''}`,
    onMount: (el) => {
      el.querySelector('#skTrust')?.addEventListener('change', async (e) => {
        try { await patch(`/api/plugins/skills/${name}`, { trusted: e.target.checked }); renderPlugins(root) } catch (err) { e.target.checked = !e.target.checked; toast(err.message, 'err') }
      })
      el.querySelector('#skKernel')?.addEventListener('change', async (e) => {
        try { await patch(`/api/plugins/skills/${name}`, { kernelEnabled: e.target.checked }); renderPlugins(root) } catch (err) { e.target.checked = !e.target.checked; toast(err.message, 'err') }
      })
      el.querySelector('.skd-files')?.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-f]')
        if (!b || b.disabled) return
        try {
          const r = await api(`/api/plugins/skills/${name}/file?path=${encodeURIComponent(b.dataset.f)}`)
          const pre = el.querySelector('#skFile')
          pre.hidden = false
          pre.textContent = r.text
          el.querySelectorAll('.skd-file').forEach((x) => x.classList.toggle('on', x === b))
        } catch (err) { toast(err.message, 'err') }
      })
    }
  })
}

function importDialog (root, preset = {}) {
  let mode = preset.mode || 'github'
  openModal({
    title: '导入技能',
    bodyHtml: `
      <div class="seg" id="im" style="margin:6px 0 14px"><button type="button" class="on" data-m="github">GitHub</button><button type="button" data-m="zip">zip 文件</button><button type="button" data-m="folder">本地文件夹</button></div>
      <div id="imBody"></div>
      <label class="inline" style="margin-top:6px;font-size:12px;color:var(--text-2)"><input type="checkbox" id="imReplace"> 已存在时覆盖更新</label>
      <div class="modal-actions"><button class="btn primary" id="imGo" type="button">导入</button></div>`,
    onMount: (el, close) => {
      const drawBody = () => {
        el.querySelectorAll('#im button').forEach((b) => b.classList.toggle('on', b.dataset.m === mode))
        el.querySelector('#imBody').innerHTML = mode === 'github'
          ? '<input class="input" id="imUrl" placeholder="https://github.com/<owner>/<repo>/tree/main/skills/<name>" spellcheck="false">'
          : mode === 'zip' ? '<input class="input" id="imZip" type="file" accept=".zip" style="padding-top:6px">'
            : `<div class="inline"><input class="input" id="imFolder" placeholder="技能文件夹路径" spellcheck="false" value="${esc(preset.folder || '')}"><button class="btn ghost small" id="imPick" type="button">选择…</button></div>`
      }
      el.querySelector('#im').onclick = (e) => { const b = e.target.closest('[data-m]'); if (b) { mode = b.dataset.m; drawBody() } }
      // Only one dialog shows at a time: close this one, pick, then reopen with the chosen folder.
      el.querySelector('#imBody').addEventListener('click', async (e) => {
        if (!e.target.closest('#imPick')) return
        const current = el.querySelector('#imFolder').value.trim()
        close()
        const folder = await chooseFolder({ title: '选择技能文件夹', start: current || null })
        importDialog(root, { mode: 'folder', folder: folder || current })
      })
      drawBody()
      el.querySelector('#imGo').onclick = async (e) => {
        const btn = e.target
        btn.disabled = true; btn.textContent = '导入中…'
        try {
          const payload = { replace: el.querySelector('#imReplace').checked }
          if (mode === 'github') payload.github = el.querySelector('#imUrl').value.trim()
          if (mode === 'folder') payload.folder = el.querySelector('#imFolder').value.trim()
          if (mode === 'zip') {
            const f = el.querySelector('#imZip').files[0]
            if (!f) throw new Error('请选择 zip 文件')
            payload.zip = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(f) })
          }
          const r = await post('/api/plugins/skills/import', payload)
          close(); toast(`已导入并启用 ${r.name}${r.warnings.length ? `（${r.warnings.join('；')}）` : ''}`, 'ok', 6000)
          await store.refresh(); pluginTab = 'skills'; renderPlugins(root)
        } catch (err) { toast(err.message, 'err', 6000); btn.disabled = false; btn.textContent = '导入' }
      }
    }
  })
}

// ---------------------------------------------------------------- library
// Three panes: scopes (all, deliverables, uploads, projects), files grouped by session, preview.
const lib = { scope: 'all', session: '', type: '', q: '', selected: 0, view: (() => { try { return localStorage.getItem('evo.libView') || 'grid' } catch { return 'grid' } })() }
const IMG_FILE = /\.(png|jpe?g|gif|webp|svg)$/i
const typeIcon = (t) => (t === 'data' ? 'data' : t === 'code' ? 'code' : t === 'figure' ? 'image' : 'file')
const baseName = (p) => p.split('/').pop()
async function downloadLibraryFile (f) {
  const res = await apiFetch(`/api/library/${f.id}/file`)
  if (!res.ok) throw new Error('下载失败')
  const url = URL.createObjectURL(await res.blob())
  const a = Object.assign(document.createElement('a'), { href: url, download: baseName(f.path) })
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export async function renderLibrary (root, arg) {
  if (arg) Object.assign(lib, { scope: arg.project ? (arg.project === 'drafts' ? 'drafts' : `p:${arg.project}`) : 'all', session: arg.session || '', type: '', q: '', selected: 0 })
  const body = shell(root, '资料空间', '')
  body.classList.add('lib-body')
  const limit = 60
  let offset = 0
  let hasMore = false
  let files = []
  let sessions = []
  let counts = { total: 0, deliverable: 0, upload: 0, drafts: 0, projects: {} }
  let generation = 0
  let loading = false
  let searchTimer
  let searchText = lib.q
  const project = () => lib.scope.startsWith('p:') ? lib.scope.slice(2) : lib.scope === 'drafts' ? 'drafts' : ''
  const load = async (nextOffset = 0) => {
    clearTimeout(searchTimer)
    searchTimer = undefined
    const request = ++generation
    loading = true
    const q = new URLSearchParams({ limit, offset: nextOffset, includeSessions: '1' })
    if (project()) q.set('project', project())
    if (lib.session) q.set('session', lib.session)
    if (lib.type) q.set('type', lib.type)
    if (lib.q) q.set('q', lib.q)
    if (lib.scope === 'deliverable') q.set('deliverable', '1')
    if (lib.scope === 'upload') q.set('kind', 'upload')
    try {
      const result = await api(`/api/library?${q}`)
      if (request !== generation || !body.isConnected) return
      if (nextOffset && !result.files.length) return load(Math.max(0, nextOffset - limit))
      files = result.files
      counts = result.counts
      sessions = result.sessions
      hasMore = result.hasMore
      offset = nextOffset
      if (!files.some((f) => f.id === lib.selected)) lib.selected = 0
      draw({ resetScroll: true })
    } catch (err) {
      if (request === generation && body.isConnected) toast(err.message, 'err')
    } finally {
      if (request === generation) loading = false
    }
  }
  const draw = ({ resetScroll = false } = {}) => {
    const oldSearch = body.querySelector('#lq')
    const searchFocused = oldSearch && document.activeElement === oldSearch
    const cursor = searchFocused ? [oldSearch.selectionStart, oldSearch.selectionEnd] : null
    const scrollTop = resetScroll ? 0 : body.querySelector('.lib-main')?.scrollTop || 0
    const S = store.state
    const count = (scope) => scope === 'all' ? counts.total : scope === 'deliverable' ? counts.deliverable
      : scope === 'upload' ? counts.upload : scope === 'drafts' ? counts.drafts : counts.projects[scope.slice(2)] ?? 0
    const scopes = [['all', '全部', 'library'], ['deliverable', '交付物', 'star'], ['upload', '上传', 'upload']]
    const projects = [...S.projects.map((p) => [`p:${p.id}`, p.name]), ['drafts', '草稿']].filter(([id]) => count(id))
    const projectId = project()
    const sessionOptions = sessions.filter((s) => !projectId || (s.project_id || 'drafts') === projectId)
    if (lib.session && !sessionOptions.some((s) => s.id === lib.session)) {
      sessionOptions.unshift({ id: lib.session, title: S.sessions.find((s) => s.id === lib.session)?.title })
    }
    const groups = new Map()
    for (const f of files) {
      const key = f.session_id || `project:${f.project_id || ''}`
      if (!groups.has(key)) groups.set(key, { title: f.session_title || (f.kind === 'upload' ? '上传' : '未归属会话'), project: f.project_name || '草稿', session: f.session_id, latest: f.updated_at, files: [] })
      const g = groups.get(key); g.files.push(f); if (f.updated_at > g.latest) g.latest = f.updated_at
    }
    const ordered = [...groups.values()].sort((a, b) => (a.latest < b.latest ? 1 : -1))
    const sel = files.find((f) => f.id === lib.selected)
    const thumb = (f, size) => f.exists && IMG_FILE.test(f.path)
      ? `<img data-api-image="/api/library/${f.id}/file" loading="lazy" alt="">` : icon(typeIcon(f.type), size)
    const card = (f) => `<button type="button" class="lcard ${f.id === lib.selected ? 'on' : ''} ${f.exists ? '' : 'missing'}" data-id="${f.id}" title="${esc(f.path)}">
        <span class="lthumb">${thumb(f, 26)}${f.deliverable ? `<i class="lstar">${icon('star', 12)}</i>` : ''}</span>
        <span class="lname">${esc(baseName(f.path))}</span><span class="lsub">${fmtSize(f.size)}</span></button>`
    const row = (f) => `<button type="button" class="lrow ${f.id === lib.selected ? 'on' : ''} ${f.exists ? '' : 'missing'}" data-id="${f.id}" title="${esc(f.path)}">
        <span class="lfi">${thumb(f, 16)}</span><span class="lname">${esc(baseName(f.path))}</span>
        <span class="lsub">${f.deliverable ? icon('star', 12) : ''}</span><span class="lsub">${fmtSize(f.size)}</span><span class="lsub">${esc(ago(f.updated_at))}</span></button>`
    body.innerHTML = `<div class="lib">
      <nav class="lib-nav">
        ${scopes.map(([id, label, ic]) => `<button type="button" class="lnav ${lib.scope === id ? 'on' : ''}" data-scope="${id}">${icon(ic, 15)}<span>${label}</span><i>${count(id)}</i></button>`).join('')}
        ${projects.length ? `<div class="lnav-h">项目</div>${projects.map(([id, label]) => `<button type="button" class="lnav ${lib.scope === id ? 'on' : ''}" data-scope="${esc(id)}">${icon('folder', 15)}<span>${esc(label)}</span><i>${count(id)}</i></button>`).join('')}` : ''}
      </nav>
      <section class="lib-main">
        <div class="lib-bar">
          <label class="lib-search">${icon('search', 14)}<input id="lq" placeholder="搜索文件" value="${esc(searchText)}"></label>
          <div class="seg">${[['', '全部'], ['figure', '图'], ['document', '文档'], ['data', '数据'], ['code', '代码']].map(([id, l]) => `<button type="button" class="${lib.type === id ? 'on' : ''}" data-type="${id}">${l}</button>`).join('')}</div>
          <div class="seg lib-view">${[['grid', '网格'], ['list', '列表']].map(([id, l]) => `<button type="button" class="${lib.view === id ? 'on' : ''}" data-view="${id}" aria-label="${l}" title="${l}">${icon(id, 14)}</button>`).join('')}</div>
        </div>
        <div class="lib-filters">
          <label>会话<select id="libSession"><option value="">全部会话</option>${sessionOptions.map((s) => `<option value="${esc(s.id)}" ${s.id === lib.session ? 'selected' : ''}>${esc(s.title || s.id)}</option>`).join('')}</select></label>
        </div>
        ${ordered.length ? ordered.map((g) => `<div class="lgroup">
            <div class="lgroup-h">${g.session ? `<a data-sess="${esc(g.session)}">${esc(g.title)}</a>` : `<span>${esc(g.title)}</span>`}<span class="faint"> · ${esc(g.project)}</span><span class="lgroup-t">${esc(ago(g.latest))}</span></div>
            <div class="${lib.view === 'grid' ? 'lgrid' : 'llist'}">${g.files.map(lib.view === 'grid' ? card : row).join('')}</div>
          </div>`).join('') : `<div class="empty-state"><b>${lib.q || lib.type || lib.session ? '没有匹配的文件' : '还没有文件'}</b></div>`}
        ${offset || hasMore ? `<div class="lib-pagination">
          <button type="button" class="btn ghost small" data-page="prev" ${offset ? '' : 'disabled'}>上一页</button>
          <span>第 ${offset / limit + 1} 页</span>
          <button type="button" class="btn ghost small" data-page="next" ${hasMore ? '' : 'disabled'}>下一页</button>
        </div>` : ''}
      </section>
      <aside class="lib-prev">${sel ? `
        <button type="button" class="lprev-media" data-open="${sel.id}" ${sel.exists ? '' : 'disabled'}>${thumb(sel, 40)}</button>
        <div class="lprev-name">${esc(baseName(sel.path))}</div>
        <div class="lkv"><span>大小</span><span>${fmtSize(sel.size)}</span></div>
        <div class="lkv"><span>修改</span><span>${esc(new Date(sel.updated_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span></div>
        ${sel.session_id ? `<div class="lkv"><span>会话</span><a data-sess="${esc(sel.session_id)}">${esc(sel.session_title || sel.session_id)}</a></div>` : ''}
        <div class="lkv"><span>项目</span><span>${esc(sel.project_name || '草稿')}</span></div>
        <div class="lkv"><span>路径</span><span class="lpath" title="${esc(sel.root)}/${esc(sel.path)}">${esc(sel.path)}</span></div>
        ${sel.exists ? `<div class="lprev-acts">
          <button type="button" class="btn ghost small" data-open="${sel.id}">${icon('eye', 14)}预览</button>
          <button type="button" class="btn ghost small" data-star="${sel.id}">${icon('star', 14)}${sel.deliverable ? '取消交付物' : '标为交付物'}</button>
          <button type="button" class="btn ghost small" data-reveal="${sel.id}">${icon('folder', 14)}在文件夹中显示</button>
          <button type="button" class="btn ghost small" data-download="${sel.id}">${icon('download', 14)}下载</button>
        </div>` : '<p class="faint">文件已移动或删除</p>'}` : ''}</aside>
    </div>`
    loadApiImages(body)
    const qi = body.querySelector('#lq')
    if (cursor) { qi.focus({ preventScroll: true }); qi.setSelectionRange(...cursor) }
    body.querySelector('.lib-main').scrollTop = scrollTop
    qi.oninput = () => {
      searchText = qi.value
      lib.q = searchText.trim()
      generation++
      clearTimeout(searchTimer)
      searchTimer = setTimeout(() => load(), 250)
    }
    body.querySelector('#libSession').onchange = (e) => { lib.session = e.target.value; void load() }
  }
  body.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-scope],[data-type],[data-view],[data-id],[data-sess],[data-open],[data-star],[data-reveal],[data-download],[data-page]')
    if (!el) return
    const byId = (v) => files.find((f) => f.id === Number(v))
    try {
      if (el.dataset.scope !== undefined) { lib.scope = el.dataset.scope; lib.session = ''; return load() }
      if (el.dataset.type !== undefined) { lib.type = el.dataset.type; return load() }
      if (el.dataset.page && !loading && !searchTimer) return load(offset + (el.dataset.page === 'next' ? limit : -limit))
      if (el.dataset.view) { lib.view = el.dataset.view; try { localStorage.setItem('evo.libView', lib.view) } catch {} return draw() }
      if (el.dataset.sess) { go('workbench'); return document.dispatchEvent(new CustomEvent('evo:open-session', { detail: el.dataset.sess })) }
      const f = byId(el.dataset.id ?? el.dataset.open ?? el.dataset.star ?? el.dataset.reveal ?? el.dataset.download)
      if (!f) return
      // Narrow windows hide the preview pane; open the file straight away instead.
      const paneHidden = !body.querySelector('.lib-prev')?.offsetParent
      if (el.dataset.id) { lib.selected = f.id; if (paneHidden && f.exists) return openFilePreviewModal(null, f.path, `/api/library/${f.id}/file`); return draw() }
      if (el.dataset.open) return openFilePreviewModal(null, f.path, `/api/library/${f.id}/file`)
      if (el.dataset.star) {
        const request = generation
        await patch(`/api/library/${f.id}`, { deliverable: !f.deliverable })
        if (request === generation && body.isConnected) return load(offset)
      }
      if (el.dataset.reveal) return await post(`/api/library/${f.id}/reveal`)
      if (el.dataset.download) return await downloadLibraryFile(f)
    } catch (err) { toast(err.message, 'err') }
  })
  draw()
  await load()
}

// ---------------------------------------------------------------- usage
const use = { days: 30, group: 'model' }
export async function renderUsage (root) {
  const body = shell(root, '用量', '',
    `<div class="seg" id="ur">${[[7, '7 天'], [30, '30 天'], [90, '90 天'], [0, '全部']].map(([d, l]) => `<button type="button" class="${use.days === d ? 'on' : ''}" data-d="${d}">${l}</button>`).join('')}</div>`)
  root.querySelector('#ur').onclick = (e) => { const b = e.target.closest('[data-d]'); if (b) { use.days = Number(b.dataset.d); renderUsage(root) } }
  const q = (group) => api(`/api/usage?group=${group}&days=${use.days || ''}`)
  const [daily, grouped] = await Promise.all([q('day'), q(use.group)])
  const t = daily.totals
  // Agents resend the whole context every step; most of it is a cache hit, so show it apart.
  const fresh = Math.max(0, t.inputTokens - t.cacheReadTokens)
  body.innerHTML = `<div class="stats">
      ${[['新增输入', fmtTokens(fresh)], ['缓存命中', `${fmtTokens(t.cacheReadTokens)} <span class="faint" style="font-size:12px">${(t.cacheHitRate * 100).toFixed(0)}%</span>`], ['输出', fmtTokens(t.outputTokens)], ['模型请求', fmtTokens(t.requests)], ['对话回合', fmtTokens(t.turns)], ['工具调用', `${fmtTokens(t.toolCalls)}${t.toolErrors ? ` <span class="faint" style="font-size:12px">失败 ${t.toolErrors}</span>` : ''}`]]
        .map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}
    </div>
    <div class="panel"><h3>每日用量</h3>${chart(daily.rows)}<div class="legend"><span><i class="c-in"></i>输入（未命中缓存）</span><span><i class="c-cache"></i>输入（缓存命中）</span><span><i class="c-out"></i>输出</span></div></div>
    <div class="panel"><div class="inline" style="margin-bottom:14px"><h3 style="flex:1">分布</h3><div class="seg" id="ug">${[['model', '按模型'], ['project', '按项目'], ['session', '按会话']].map(([g, l]) => `<button type="button" class="${use.group === g ? 'on' : ''}" data-g="${g}">${l}</button>`).join('')}</div></div>
      ${grouped.rows.length ? `<div class="bars">${grouped.rows.slice(0, 30).map((r) => {
        const sum = r.inputTokens + r.outputTokens
        const max = Math.max(...grouped.rows.map((x) => x.inputTokens + x.outputTokens), 1)
        return `<div class="bar-row"><span class="l" title="${esc(r.label)}">${esc(r.label)}</span><span class="tr" style="width:${Math.max(2, (100 * sum) / max)}%"><i class="c-cache" style="width:${(100 * r.cacheReadTokens) / Math.max(1, sum)}%"></i><i class="c-in" style="width:${(100 * (r.inputTokens - r.cacheReadTokens)) / Math.max(1, sum)}%"></i><i class="c-out" style="width:${(100 * r.outputTokens) / Math.max(1, sum)}%"></i></span><span class="n">${fmtTokens(sum)} · ${r.requests} 次</span></div>`
      }).join('')}</div>` : '<p class="muted">这段时间没有用量。</p>'}</div>`
  body.querySelector('#ug').onclick = (e) => { const b = e.target.closest('[data-g]'); if (b) { use.group = b.dataset.g; renderUsage(root) } }
}

function chart (rows) {
  if (!rows.length) return '<p class="muted">这段时间没有用量。</p>'
  const W = 900; const H = 200; const pad = { l: 44, r: 8, t: 10, b: 22 }
  const max = Math.max(...rows.map((r) => r.inputTokens + r.outputTokens), 1)
  const bw = Math.max(3, Math.min(28, (W - pad.l - pad.r) / rows.length - 4))
  const step = (W - pad.l - pad.r) / rows.length
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max)
  const ticks = [0, 0.5, 1].map((f) => `<line class="ax" x1="${pad.l}" x2="${W - pad.r}" y1="${y(max * f)}" y2="${y(max * f)}"/><text x="${pad.l - 6}" y="${y(max * f) + 3}" text-anchor="end">${fmtTokens(max * f)}</text>`).join('')
  const bars = rows.map((r, i) => {
    const x = pad.l + i * step + (step - bw) / 2
    const cache = r.cacheReadTokens; const miss = r.inputTokens - cache; const out = r.outputTokens
    let top = H - pad.b
    const seg = (v, fill) => { const h = (H - pad.t - pad.b) * (v / max); top -= h; return h > 0 ? `<rect x="${x}" y="${top}" width="${bw}" height="${h}" rx="2" fill="${fill}"/>` : '' }
    const label = rows.length <= 16 || i % Math.ceil(rows.length / 12) === 0 ? `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(r.key.slice(5))}</text>` : ''
    return `<g><title>${esc(r.key)}：输入 ${fmtTokens(r.inputTokens)}（缓存 ${fmtTokens(cache)}）· 输出 ${fmtTokens(out)}</title>${seg(cache, 'rgba(185,162,255,.35)')}${seg(miss, '#b9a2ff')}${seg(out, '#8be0b4')}${label}</g>`
  }).join('')
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${ticks}${bars}</svg>`
}

// ---------------------------------------------------------------- trajectory
const KIND = { recall: '回忆', reflect: '反思', adjust: '调整', selfcheck: '自检', learned: '学到', preference: '偏好', observe: '观察', credit: '归因', revert: '撤销', choice: '选择' }
const STATUS = { trial: ['试用', 'warn'], active: ['生效', 'ok'], retired: ['已淘汰', ''] }
let trajTab = 'timeline'
let memFilter = 'live'
const pick = new Set()
export async function renderTrajectory (root, arg) {
  if (typeof arg === 'string' && ['timeline', 'memory', 'overlays', 'versions'].includes(arg)) trajTab = arg
  const body = shell(root, '轨迹', '')
  const [ev, evo] = await Promise.all([api('/api/evolve'), api('/api/evolution')])
  const pending = evo.candidates.filter((c) => c.status === 'pending')
  const live = ev.memory.filter((m) => m.status !== 'retired')
  const overlays = ev.overlays.filter((o) => o.status === 'trial' || o.status === 'kept')
  for (const id of [...pick]) if (!ev.memory.some((m) => m.id === id) && !ev.overlays.some((o) => o.id === id)) pick.delete(id)
  const tabs = [['timeline', `时间线 ${ev.log.length}`], ['memory', `记忆 ${live.length}`], ['overlays', `会话调整 ${overlays.length}`], ['versions', `版本${pending.length ? ` · 待批准 ${pending.length}` : ''}`]]
  const score = (m) => (m.wins + 1) / (m.wins + m.losses + 2)
  const sessLink = (id, title) => id ? `<a class="muted" data-sess="${esc(id)}" style="cursor:pointer">${esc(title || id)}</a>` : ''
  const draw = () => {
    let html = `<div class="toolbar"><div class="seg">${tabs.map(([id, l]) => `<button type="button" class="${trajTab === id ? 'on' : ''}" data-t="${id}">${l}</button>`).join('')}</div>
      ${pick.size ? `<button class="btn primary small" id="consol" type="button">沉淀为 genome 候选（${pick.size}）</button>` : ''}
      ${trajTab === 'memory' ? `<div class="seg">${[['live', '在用'], ['trial', '试用'], ['active', '生效'], ['retired', '已淘汰']].map(([id, l]) => `<button type="button" class="${memFilter === id ? 'on' : ''}" data-mf="${id}">${l}</button>`).join('')}</div><button class="btn ghost small" id="addPref" type="button">${icon('plus', 14)}添加偏好</button>` : ''}</div>`
    if (trajTab === 'timeline') {
      html += ev.log.length ? `<div class="timeline">${ev.log.map((e) => `<div class="tl-item"><i class="rail-dot ${['adjust', 'learned', 'preference'].includes(e.kind) ? '' : 'dim'}"></i><div class="c">
          <div class="h"><span class="badge ${['adjust', 'learned', 'preference'].includes(e.kind) ? 'accent' : e.kind === 'selfcheck' ? 'warn' : ''}">${KIND[e.kind] || esc(e.kind)}</span>${(e.refs || []).slice(0, 5).map((r) => `<code>${esc(r)}</code>`).join(' ')}<span class="faint">${esc(ago(e.ts))}</span><span class="page-actions">${sessLink(e.session_id, e.session_title)}</span></div>
          <p>${esc(e.text)}</p></div></div>`).join('')}</div>` : '<div class="empty-state"><b>还没有自进化记录</b></div>'
    } else if (trajTab === 'memory') {
      const list = ev.memory.filter((m) => memFilter === 'live' ? m.status !== 'retired' : m.status === memFilter)
      html += list.length ? `<div class="cards">${list.map((m) => { const [sl, sc] = STATUS[m.status]; return `<div class="pcard" data-mem="${esc(m.id)}">
          <div class="top">${m.status === 'active' && m.trust === 'trusted' ? `<input type="checkbox" data-pick="${esc(m.id)}" ${pick.has(m.id) ? 'checked' : ''} title="选入 genome 候选">` : ''}<code>${esc(m.id)}</code><span class="badge">${m.kind === 'lesson' ? '经验' : '偏好'}</span><span class="badge ${sc}">${sl}</span>${m.pinned ? '<span class="badge accent">置顶</span>' : ''}${m.trust === 'untrusted' ? '<span class="badge warn">来源含外部内容</span>' : ''}</div>
          <div class="ds" style="-webkit-line-clamp:5"><b style="color:#fff;font-weight:500">${esc(m.trigger)}</b> → ${esc(m.content)}</div>
          <div class="ft"><span>得分 ${score(m).toFixed(2)}</span><span>用过 ${m.uses} 次</span><span>${{ model: '模型提炼', user: '你给的', choice: '你的选择', edit: '你的修改', host: '系统' }[m.source] || ''}</span><span>${m.scope === 'project' ? '项目内' : m.scope === 'stage' ? `阶段 ${esc(m.stage || '')}` : '全局'}</span>
            <span class="page-actions"><button class="icon-btn" data-act="pin" title="${m.pinned ? '取消置顶' : '置顶（总是注入）'}" type="button">${icon('pin', 14)}</button><button class="icon-btn" data-act="edit" title="编辑" type="button">${icon('edit', 14)}</button>
            ${m.status === 'retired' ? `<button class="icon-btn" data-act="restore" title="恢复" type="button">${icon('refresh', 14)}</button>` : `<button class="icon-btn" data-act="retire" title="淘汰（不再注入）" type="button">${icon('archive', 14)}</button>`}<button class="icon-btn" data-act="del" title="删除" type="button">${icon('trash', 14)}</button></span></div></div>` }).join('')}</div>` : '<div class="empty-state"><b>这里还没有条目</b></div>'
    } else if (trajTab === 'overlays') {
      html += ev.overlays.length ? `<div class="timeline">${ev.overlays.slice().reverse().map((o) => `<div class="tl-item"><i class="rail-dot ${o.status === 'reverted' ? 'dim' : ''}"></i><div class="c">
          <div class="h">${o.status === 'trial' || o.status === 'kept' ? `<input type="checkbox" data-pick="${esc(o.id)}" ${pick.has(o.id) ? 'checked' : ''} title="选入 genome 候选">` : ''}<code>${esc(o.id)}</code><span class="badge">${esc(o.op)}${o.target ? ` · ${esc(o.target)}` : ''}</span><span class="badge ${o.status === 'reverted' ? '' : o.status === 'kept' ? 'ok' : 'warn'}">${{ trial: '试用中', kept: '保留', reverted: '已撤销', promoted: '已沉淀' }[o.status] || esc(o.status)}</span>
          ${o.before_score !== null && o.after_score !== null ? `<span class="faint">回合得分 ${Number(o.before_score).toFixed(2)} → ${Number(o.after_score).toFixed(2)}</span>` : ''}<span class="page-actions">${sessLink(o.session_id)}${o.status === 'trial' || o.status === 'kept' ? `<button class="btn ghost small" data-rev="${esc(o.id)}" type="button">撤销</button>` : ''}</span></div>
          <p>${esc(o.value || '')}${o.reason ? `<br><span class="faint">原因：${esc(o.reason)}</span>` : ''}</p></div></div>`).join('')}</div>` : '<div class="empty-state"><b>还没有会话调整</b></div>'
    } else {
      html += `<div class="section-t">待你批准</div>${pending.length ? `<div class="timeline">${pending.map((c) => {
          const v = c.verification || {}
          const badge = v.verified
            ? `<span class="badge ok">已验证 ${esc(String(v.pass))}/${esc(String(v.total))}</span>`
            : '<span class="badge warn">未验证</span>'
          const evidenceLine = v.verified
            ? `验证运行：<code>${esc(v.runId || '')}</code> · 通过 ${esc(String(v.pass))}/${esc(String(v.total))}`
            : ''
          const scopeLine = `适用范围：${esc(v.scope || '全局 harness')}`
          // change is stored as a JSON array of bullet strings.
          let change = c.change || c.diagnosis || ''
          try { const list = JSON.parse(change); if (Array.isArray(list)) change = list.join('；') } catch {}
          return `<div class="tl-item"><i class="rail-dot"></i><div class="c">
          <div class="h"><code>${esc(c.genome_id)}</code><span class="badge warn">待批准</span>${badge}<span class="faint">${esc(c.target || '')}</span><span class="page-actions"><button class="btn ghost small" data-rej="${esc(c.genome_id)}" type="button">拒绝</button><button class="btn primary small" data-pro="${esc(c.genome_id)}" type="button">批准上线</button></span></div>
          <p>${esc(change)}</p>
          <p class="faint">${evidenceLine ? `${evidenceLine} · ` : ''}${scopeLine}</p></div></div>`
        }).join('')}</div>` : '<p class="muted">没有待批准的候选</p>'}
        <div class="section-t">harness 版本</div><div class="timeline">${evo.lineage.slice().reverse().slice(0, 40).map((g) => `<div class="tl-item"><i class="rail-dot ${g.status === 'active' ? '' : 'dim'}"></i><div class="c">
          <div class="h"><code>${esc(g.id)}</code>${g.status === 'active' ? '<span class="badge ok">当前</span>' : `<span class="badge">${esc({ archived: '历史', rejected: '已拒绝', candidate: '候选' }[g.status] || g.status)}</span>`}<span class="faint">${esc(g.createdBy?.startsWith('evolution') ? '进化生成' : '手动')}</span>
          ${g.status === 'archived' ? `<span class="page-actions"><button class="btn ghost small" data-rb="${esc(g.id)}" type="button">回滚到此版本</button></span>` : ''}</div><p>${esc(g.note || '')}</p></div></div>`).join('')}</div>`
    }
    body.innerHTML = html
  }
  draw()
  body.onclick = async (e) => {
    const pk = e.target.closest('[data-pick]')
    if (pk) { pk.checked ? pick.add(pk.dataset.pick) : pick.delete(pk.dataset.pick); return draw() }
    if (e.target.closest('#consol')) {
      const ids = [...pick]
      if (!(await confirmDialog({ title: '沉淀为 genome 候选', message: `用选中的 ${ids.length} 项生成一个 harness 候选？`, confirmText: '生成候选' }))) return
      try {
        const r = await post('/api/evolve/consolidate', { overlayIds: ids.filter((x) => x.startsWith('O-')), memoryIds: ids.filter((x) => /^[LP]-/.test(x)) })
        pick.clear(); trajTab = 'versions'; await store.refresh(); toast(`已生成候选 ${r.genome}`, 'ok', 6000); return renderTrajectory(root)
      } catch (err) { return toast(err.message, 'err') }
    }
    const t = e.target.closest('[data-t]'); if (t) { trajTab = t.dataset.t; return draw() }
    const mf = e.target.closest('[data-mf]'); if (mf) { memFilter = mf.dataset.mf; return draw() }
    const sl = e.target.closest('[data-sess]'); if (sl) { go('workbench'); return document.dispatchEvent(new CustomEvent('evo:open-session', { detail: sl.dataset.sess })) }
    try {
      if (e.target.closest('#addPref')) {
        const text = await promptDialog({ title: '添加偏好', message: '', multiline: true })
        if (!text) return
        await post('/api/memory', { kind: 'preference', trigger: '用户设定', content: text, pinned: true })
        return renderTrajectory(root)
      }
      const act = e.target.closest('[data-act]')
      if (act) {
        const id = act.closest('[data-mem]').dataset.mem
        const m = ev.memory.find((x) => x.id === id)
        if (act.dataset.act === 'pin') await patch(`/api/memory/${id}`, { pinned: !m.pinned })
        if (act.dataset.act === 'retire') await patch(`/api/memory/${id}`, { status: 'retired' })
        if (act.dataset.act === 'restore') await patch(`/api/memory/${id}`, { status: 'active' })
        if (act.dataset.act === 'edit') { const c = await promptDialog({ title: `编辑 ${id}`, message: m.trigger, defaultValue: m.content, multiline: true }); if (!c) return; await patch(`/api/memory/${id}`, { content: c }) }
        if (act.dataset.act === 'del') { if (!(await confirmDialog({ title: '删除条目', message: `删除 ${id}？`, confirmText: '删除', danger: true }))) return; await del(`/api/memory/${id}`) }
        return renderTrajectory(root)
      }
      const rev = e.target.closest('[data-rev]'); if (rev) { await post(`/api/overlays/${rev.dataset.rev}/revert`); return renderTrajectory(root) }
      const b = e.target.closest('[data-pro],[data-rej],[data-rb]')
      if (!b) return
      if (b.dataset.pro) {
        const cand = pending.find((x) => x.genome_id === b.dataset.pro)
        const v = cand?.verification
        if (v?.verified) {
          if (!(await confirmDialog({ title: '批准上线', message: `上线 ${b.dataset.pro}？验证 ${v.pass}/${v.total}，范围：${v.scope}`, confirmText: '批准' }))) return
          await post(`/api/evolution/${b.dataset.pro}/promote`, {})
        } else {
          if (!(await confirmDialog({ title: '批准未验证候选', message: `${b.dataset.pro} 未经验证，范围：${v?.scope || '全局 harness'}`, confirmText: '继续确认', danger: true }))) return
          if (!(await confirmDialog({ title: '二次确认：上线未验证候选', message: `确认上线未验证的 ${b.dataset.pro}？可以随时回滚。`, confirmText: '确认批准上线', danger: true }))) return
          await post(`/api/evolution/${b.dataset.pro}/promote`, { confirmUnverified: true })
        }
      }
      if (b.dataset.rej) await post(`/api/evolution/${b.dataset.rej}/reject`, {})
      if (b.dataset.rb) { if (!(await confirmDialog({ title: '回滚', message: `回滚到 ${b.dataset.rb}？`, confirmText: '回滚' }))) return; await post('/api/genome/rollback', { to: b.dataset.rb }) }
      await store.refresh(); toast('已更新', 'ok'); renderTrajectory(root)
    } catch (err) { toast(err.message, 'err') }
  }
}
