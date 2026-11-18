// EvoScholar web workbench — modular ES modules, zero build step, no external requests.
import { formatToolSummary, md } from './ui/markdown.js'
import { confirmDialog, esc, openLightbox, promptDialog, toast, yuan } from './ui/modal.js'
import {
  openFilePreviewModal,
  openReportReviewModal,
  openSettingsModal,
  renderCapabilitiesView,
  renderEvolutionView,
  renderLedgerView
} from './ui/views.js'

const $ = (s, el = document) => el.querySelector(s)
const $$ = (s, el = document) => [...el.querySelectorAll(s)]

// ---------- FX background integration ----------
let fx = {
  setState() {},
  setDim() {},
  setBudgetLevel() {},
  reform() {},
  setQuality() {},
  setMouseStrength() {},
  setPaused() {},
  quality: 'off'
}
import('./fx/index.js')
  .then((m) => {
    try {
      fx = m.initFx(document.getElementById('bg'))
      syncFx()
    } catch (e) {
      console.warn('fx disabled:', e)
    }
  })
  .catch((e) => console.warn('fx disabled:', e))

// ---------- Preferences ----------
const PREFS_KEY = 'evoscholar.prefs'
function loadPrefs() {
  const defaults = {
    fxMode: 'home', // 'home' | 'ambient' | 'off'
    transcriptWidth: 'standard', // 'standard' | 'wide'
    expandReasoning: false,
    sidebarCollapsed: innerWidth <= 900
  }
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')
    return { ...defaults, ...raw, fxQuality: localStorage.getItem('evoscholar.fxQuality') || 'auto' }
  } catch {
    return { ...defaults, fxQuality: 'auto' }
  }
}
let prefs = loadPrefs()

function applyPrefs() {
  document.documentElement.style.setProperty('--col', prefs.transcriptWidth === 'wide' ? '960px' : '740px')
  const sb = $('#sidebar')
  if (sb) sb.classList.toggle('collapsed', !!prefs.sidebarCollapsed || view !== 'workbench')
  const bd = $('#sidebarBackdrop')
  if (bd) bd.hidden = prefs.sidebarCollapsed || innerWidth > 900 || view !== 'workbench'
  syncFx()
}

function updatePrefs(patch) {
  prefs = { ...prefs, ...patch }
  try {
    const { fxQuality: _q, ...save } = prefs
    localStorage.setItem(PREFS_KEY, JSON.stringify(save))
  } catch {}
  applyPrefs()
}

// ---------- API helpers ----------
const H = { 'content-type': 'application/json', 'x-evoscholar': '1' }
const api = async (path, opts = {}) => {
  const r = await fetch(path, { ...opts, headers: { ...H, ...(opts.headers || {}) } })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || r.statusText)
  return j
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) })
const patch = (path, body) => api(path, { method: 'PATCH', body: JSON.stringify(body || {}) })
const del = (path) => api(path, { method: 'DELETE' })

// ---------- Application state ----------
let state = null
let view = 'workbench' // 'workbench' | 'evolution' | 'capabilities' | 'ledger'
let current = null // active session id
let es = null
let pendingImages = []
let uploadedRefs = []
let liveMsg = null
let modeFilter = 'all'
let searchQuery = ''
let inspectorOpen = false
let evoTimer = null
let pinnedShut = false
let recentShut = false
let autoRefreshedOnce = false
let effortOpen = false

// Codex-style Back / Forward navigation history
const navStack = []
let navIdx = -1

function syncNavButtons() {
  $('#navBackBtn').disabled = navIdx <= 0
  $('#navFwdBtn').disabled = navIdx < 0 || navIdx >= navStack.length - 1
}

function pushNav(nextView, nextSessionId = null) {
  const top = navStack[navIdx]
  if (top && top.view === nextView && top.sessionId === nextSessionId) {
    syncNavButtons()
    return
  }
  navStack.splice(navIdx + 1)
  navStack.push({ view: nextView, sessionId: nextSessionId })
  if (navStack.length > 50) navStack.shift()
  navIdx = navStack.length - 1
  syncNavButtons()
}

async function applyNavEntry(entry) {
  if (!entry) return
  if (entry.view !== 'workbench') {
    setView(entry.view, { push: false })
  } else if (entry.sessionId) {
    setView('workbench', { push: false })
    await openSession(entry.sessionId, { push: false })
  } else {
    setView('workbench', { push: false })
    goHome({ push: false })
  }
  syncNavButtons()
}

$('#navBackBtn').onclick = () => {
  if (navIdx > 0) {
    navIdx--
    applyNavEntry(navStack[navIdx])
  }
}
$('#navFwdBtn').onclick = () => {
  if (navIdx < navStack.length - 1) {
    navIdx++
    applyNavEntry(navStack[navIdx])
  }
}

const thread = $('#thread')
const threadInner = $('#threadInner')
const scrollBottom = () => {
  thread.scrollTop = thread.scrollHeight
}

function syncFx() {
  const isHome = view === 'workbench' && !current
  const mode = prefs.fxMode || 'home'
  document.body.classList.toggle('fx-home-visible', isHome && mode !== 'off')
  document.body.classList.toggle('fx-ambient-visible', view === 'workbench' && !!current && mode === 'ambient')

  if (mode === 'off') {
    fx.setDim?.(0)
    fx.setPaused?.(true)
  } else if (isHome) {
    fx.setPaused?.(false)
    fx.setDim?.(1)
  } else if (view === 'workbench' && current && mode === 'ambient') {
    fx.setPaused?.(false)
    fx.setDim?.(0.22)
  } else {
    fx.setDim?.(0)
    fx.setPaused?.(true)
  }

  if (state?.budget) {
    fx.setBudgetLevel?.(state.budget.usageTodayCny / Math.max(0.01, state.budget.dailyUsageSoftCny))
  }
}

// ---------- Effort metadata & helpers ----------
const EFFORT_META = {
  none: { label: '关闭' },
  minimal: { label: '极简' },
  low: { label: '低' },
  medium: { label: '中', pill: '推荐' },
  high: { label: '高' },
  xhigh: { label: '极高' },
  max: { label: '最高', pill: '⚠ 耗时更长', warn: true },
  ultra: { label: '极致', pill: '⚠ 耗时更长', warn: true }
}

function activeModelMeta() {
  if (!state) return { ref: '', prov: null, model: null, effort: '', cap: { supported: false } }
  const ref = state.genome.roles.main || ''
  const [pid, ...rest] = ref.split('/')
  const mid = rest.join('/')
  const prov = state.providers.find((p) => p.id === pid) || null
  const model = prov?.models.find((m) => m.id === mid) || null
  const cap = model?.reasoningEffort ?? prov?.reasoningEffort ?? { supported: false }
  const effort = state.reasoningEffort?.[ref] || ''
  return { ref, pid, mid, prov, model, effort, cap }
}

function renderModelButtonLabel() {
  const info = activeModelMeta()
  $('#modelName').textContent = info.mid || '—'
  const tag = $('#effortTag')
  if (info.cap?.supported && info.cap?.values?.length) {
    const effText = info.effort ? EFFORT_META[info.effort]?.label || info.effort : '默认'
    tag.hidden = false
    tag.textContent = effText
    tag.title = `思考程度：${effText}（由 ${info.prov?.label || info.pid} 提供，点击调节）`
  } else {
    tag.hidden = true
    tag.textContent = ''
  }
}

// ---------- Modes & Utilities ----------
const MODES = { literature: '文献', data: '数据', figure: '出图', writing: '写作', chat: '对话' }

function ago(ts) {
  if (!ts) return ''
  const s = (Date.now() - new Date(ts.replace(' ', 'T') + (ts.endsWith('Z') ? '' : 'Z')).getTime()) / 1000
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

function banner(text) {
  const b = $('#banner')
  b.hidden = !text
  b.textContent = text || ''
}

function setPendingBadge(n) {
  if (state) state.pending = n
  const badge = $('#evoBadge')
  badge.hidden = !n
  badge.textContent = String(n)
}

function updateSidebarBudget(b) {
  if (!b) return
  if (state) state.budget = { ...state.budget, ...b }
  $('#sfToday').textContent = `今日 ${yuan(b.usageTodayCny)}`
  $('#sfWeb').textContent = `联网 ${b.webCallsToday} 次`
  fx.setBudgetLevel?.(b.usageTodayCny / Math.max(0.01, b.dailyUsageSoftCny || 15))
}

// ---------- State Loading ----------
async function loadState() {
  state = await api('/api/state')
  renderModelButtonLabel()

  try {
    const seen = localStorage.getItem('evoscholar.genome')
    if (seen && seen !== state.genome.id) fx.reform?.()
    localStorage.setItem('evoscholar.genome', state.genome.id)
  } catch {}

  setPendingBadge(state.pending ?? 0)
  updateSidebarBudget(state.budget)
  renderSessions()
  syncFx()

  const provId = (state.genome.roles.main || '').split('/')[0]
  const prov = state.providers.find((p) => p.id === provId)
  if (prov && !prov.hasKey) {
    banner(`尚未配置 ${prov.label} 的 API Key，请点击左下角「设置 → 模型」填写。`)
  } else {
    banner('')
  }

  // Silently fetch live models once for connected vendors that expose /models
  if (!autoRefreshedOnce && state.providers.some((p) => p.hasKey && p.modelsListUrl)) {
    autoRefreshedOnce = true
    post('/api/providers/refresh', {})
      .then((res) => {
        if (state && Array.isArray(res.providers)) {
          state.providers = res.providers
          renderModelButtonLabel()
        }
      })
      .catch(() => {})
  }
}

// ---------- Claude-style Left Session Sidebar ----------
let openMenuSessionId = null
function closeRowMenu() {
  $('#rowMenu').hidden = true
  openMenuSessionId = null
  $$('.sess-row.menu-open').forEach((x) => x.classList.remove('menu-open'))
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('#rowMenu') && !e.target.closest('.sess-more-btn')) closeRowMenu()
})

function renderSessions() {
  if (!state) return
  const q = searchQuery.trim().toLowerCase()
  const list = state.sessions.filter((s) => {
    if (modeFilter !== 'all' && s.mode !== modeFilter) return false
    if (!q) return true
    return (
      String(s.title || '').toLowerCase().includes(q) ||
      String(s.preview || '').toLowerCase().includes(q) ||
      String(s.id).toLowerCase().includes(q)
    )
  })

  const pinned = list.filter((s) => s.pinned)
  const recent = list.filter((s) => !s.pinned)

  const rowHtml = (s) => {
    let statusGlyph = ''
    if (s.pendingApprovals > 0) statusGlyph = '<i class="sess-wait-dot" title="等待审批"></i>'
    else if (s.running) statusGlyph = '<i class="sess-spin" title="运行中"></i>'

    return `
      <div class="sess-row ${s.id === current ? 'active' : ''} ${openMenuSessionId === s.id ? 'menu-open' : ''}" data-id="${esc(s.id)}" role="button" tabindex="0">
        ${statusGlyph}
        <span class="sess-title">${esc(s.title || s.id)}</span>
        <span class="sess-time">${esc(ago(s.last || s.created_at))}</span>
        <button type="button" class="sess-more-btn" data-more="${esc(s.id)}" title="更多操作" aria-label="更多操作">···</button>
      </div>`
  }

  const chevron = '<svg viewBox="0 0 12 12" width="10" height="10"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'

  if (!list.length) {
    $('#sessions').innerHTML = `<div class="sess-empty">${state.sessions.length ? '没有匹配的会话' : '暂无会话记录'}</div>`
    return
  }

  let html = ''
  if (pinned.length) {
    html += `<button type="button" class="sess-group-btn ${pinnedShut ? 'shut' : ''}" data-grp="pinned">${chevron}<span>置顶</span></button>`
    if (!pinnedShut) html += pinned.map(rowHtml).join('')
  }
  if (recent.length) {
    html += `<button type="button" class="sess-group-btn ${recentShut ? 'shut' : ''}" data-grp="recent">${chevron}<span>${pinned.length ? '最近' : '会话'}</span></button>`
    if (!recentShut) html += recent.map(rowHtml).join('')
  }
  $('#sessions').innerHTML = html
}

$('#sessions').addEventListener('click', (e) => {
  const grpBtn = e.target.closest('[data-grp]')
  if (grpBtn) {
    if (grpBtn.dataset.grp === 'pinned') pinnedShut = !pinnedShut
    else recentShut = !recentShut
    renderSessions()
    return
  }

  const moreBtn = e.target.closest('[data-more]')
  if (moreBtn) {
    e.stopPropagation()
    const id = moreBtn.dataset.more
    if (openMenuSessionId === id) {
      closeRowMenu()
      return
    }
    const sess = state.sessions.find((x) => x.id === id)
    if (!sess) return
    openMenuSessionId = id
    $$('.sess-row.menu-open').forEach((x) => x.classList.remove('menu-open'))
    moreBtn.closest('.sess-row')?.classList.add('menu-open')

    const menu = $('#rowMenu')
    menu.innerHTML = `
      <button type="button" data-menu-act="pin">${sess.pinned ? '取消置顶' : '置顶会话'}</button>
      <button type="button" data-menu-act="rename">重命名</button>
      <button type="button" data-menu-act="fork">分支对话</button>
      <div class="rm-sep"></div>
      <button type="button" data-menu-act="archive">归档</button>
      <button type="button" class="del" data-menu-act="delete">删除</button>`
    const rect = moreBtn.getBoundingClientRect()
    menu.style.top = `${Math.min(innerHeight - 210, rect.bottom + 4)}px`
    menu.style.left = `${Math.min(innerWidth - 160, rect.right - 130)}px`
    menu.hidden = false
    return
  }

  const row = e.target.closest('.sess-row')
  if (!row) return
  closeRowMenu()
  setView('workbench', { push: false })
  openSession(row.dataset.id)
  if (innerWidth <= 900) updatePrefs({ sidebarCollapsed: true })
})

$('#rowMenu').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-menu-act]')
  if (!b || !openMenuSessionId) return
  const id = openMenuSessionId
  const sess = state.sessions.find((x) => x.id === id)
  closeRowMenu()
  const act = b.dataset.menuAct
  if (act === 'pin') {
    try {
      await patch(`/api/sessions/${id}`, { pinned: !sess?.pinned })
      await loadState()
    } catch (err) {
      toast(err.message, 'err')
    }
  } else if (act === 'rename') {
    await renameSessionFlow(id, sess?.title || id)
  } else if (act === 'fork') {
    try {
      const r = await post(`/api/sessions/${id}/fork`, {})
      await loadState()
      setView('workbench', { push: false })
      await openSession(r.id)
      toast('已创建分支对话', 'ok')
    } catch (err) {
      toast(err.message, 'err')
    }
  } else if (act === 'archive') {
    try {
      await patch(`/api/sessions/${id}`, { archived: true })
      if (id === current) goHome()
      await loadState()
      toast('已归档对话（可在 设置 → 已归档对话 恢复）', 'info')
    } catch (err) {
      toast(err.message, 'err')
    }
  } else if (act === 'delete') {
    await deleteSessionFlow(id, sess?.title || id)
  }
})

$('#toggleFilterBtn').onclick = () => {
  const t = $('#sidebarTools')
  t.hidden = !t.hidden
  if (!t.hidden) $('#sessionSearch').focus()
}

async function renameSessionFlow(id, currentTitle) {
  const next = await promptDialog({
    title: '重命名会话',
    label: '会话标题',
    defaultValue: currentTitle,
    confirmText: '保存'
  })
  if (!next || !next.trim()) return
  try {
    await patch(`/api/sessions/${id}`, { title: next.trim() })
    if (id === current) $('#title').textContent = next.trim()
    await loadState()
    toast('已重命名会话', 'ok')
  } catch (err) {
    toast(err.message, 'err')
  }
}

async function deleteSessionFlow(id, title) {
  const ok = await confirmDialog({
    title: '删除会话',
    message: `确定永久删除「${title}」？该会话的对话记录及工作目录文件将被清理（API 花费账本会保留）。`,
    confirmText: '确认删除',
    danger: true
  })
  if (!ok) return
  try {
    await del(`/api/sessions/${id}`)
    if (id === current) goHome()
    await loadState()
    toast('已删除会话', 'info')
  } catch (err) {
    toast(err.message, 'err')
  }
}

$('#sessionSearch').addEventListener('input', (e) => {
  searchQuery = e.target.value
  renderSessions()
})

$('#tags').addEventListener('click', (e) => {
  const b = e.target.closest('.mchip')
  if (!b) return
  modeFilter = b.dataset.mode
  $$('#tags .mchip').forEach((x) => x.classList.toggle('on', x === b))
  renderSessions()
})

// ---------- View Router ----------
const ctx = {
  api,
  post,
  patch,
  del,
  fx,
  getView: () => view,
  getState: () => state,
  setState: (s) => (state = s),
  getPrefs: () => prefs,
  updatePrefs,
  loadState,
  loadSessions: loadState,
  syncBudget: updateSidebarBudget,
  setPending: setPendingBadge,
  setEvoTimer: (fn, ms) => {
    clearTimeout(evoTimer)
    evoTimer = setTimeout(fn, ms)
  }
}

const VIEW_TITLES = {
  evolution: '进化实验室',
  capabilities: '技能与规则库',
  ledger: '用量与账本'
}

function setView(nextView, { push = true } = {}) {
  view = nextView
  clearTimeout(evoTimer)
  closeRowMenu()
  $$('.rail-btn[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === nextView))
  $('#viewWorkbench').hidden = nextView !== 'workbench'
  $('#viewEvolution').hidden = nextView !== 'evolution'
  $('#viewCapabilities').hidden = nextView !== 'capabilities'
  $('#viewLedger').hidden = nextView !== 'ledger'

  const inWb = nextView === 'workbench'
  const showSidebar = inWb && !prefs.sidebarCollapsed
  $('#sidebar').hidden = !inWb
  $('#sidebar').classList.toggle('collapsed', !showSidebar)
  $('#sidebarBackdrop').hidden = !showSidebar || innerWidth > 900
  $('#sidebarToggleBtn').hidden = !inWb
  $('#inspector').hidden = !(inWb && current && inspectorOpen)
  $('#inspectorBtn').hidden = !(inWb && current)

  if (!inWb) {
    document.body.classList.remove('home-stage')
    $('#topModeBadge').hidden = true
    $('#title').textContent = VIEW_TITLES[nextView] || ''
    $('#subtitle').textContent = ''
  } else {
    document.body.classList.toggle('home-stage', !current)
    if (!current) {
      $('#topModeBadge').hidden = true
      $('#title').textContent = ''
      $('#subtitle').textContent = ''
    } else {
      const meta = state?.sessions?.find((x) => x.id === current)
      $('#topModeBadge').hidden = false
      $('#topModeBadge').textContent = MODES[meta?.mode || 'chat'] || '对话'
      $('#title').textContent = meta?.title || current
    }
  }

  syncFx()
  if (push) pushNav(nextView, nextView === 'workbench' ? current : null)

  if (nextView === 'evolution') renderEvolutionView($('#viewEvolution'), ctx)
  else if (nextView === 'capabilities') renderCapabilitiesView($('#viewCapabilities'), ctx)
  else if (nextView === 'ledger') renderLedgerView($('#viewLedger'), ctx)
}

$$('.rail-btn[data-view]').forEach((b) => {
  b.onclick = () => setView(b.dataset.view)
})
$('#brandHomeBtn').onclick = () => {
  setView('workbench', { push: false })
  goHome()
}
$('#sidebarFoot').onclick = () => setView('ledger')
$('#settingsBtn').onclick = () => openSettingsModal(ctx)
$('#sidebarToggleBtn').onclick = () => updatePrefs({ sidebarCollapsed: !prefs.sidebarCollapsed })
$('#sidebarBackdrop').onclick = () => updatePrefs({ sidebarCollapsed: true })

const startFreshHome = () => {
  setView('workbench', { push: false })
  goHome()
  $('#input').focus()
}
$('#newSessionBtn').onclick = startFreshHome
$('#newChatRow').onclick = startFreshHome

// ---------- Home & Session Opening ----------
function setUrlSession(id) {
  try {
    const u = new URL(location.href)
    if (id) u.searchParams.set('s', id)
    else u.searchParams.delete('s')
    history.replaceState(null, '', u)
  } catch {}
}

function goHome({ push = true } = {}) {
  current = null
  es?.close()
  liveMsg = null
  setBusy(false)
  setUrlSession(null)
  document.body.classList.remove('has-session')
  document.body.classList.add('home-stage')
  $('#topModeBadge').hidden = true
  $('#title').textContent = ''
  $('#subtitle').textContent = ''
  $('#inspectorBtn').hidden = true
  $('#inspector').hidden = true
  $('#sessionPill').hidden = true
  uploadedRefs = []
  pendingImages = []
  renderAttachments()
  renderSessions()
  syncFx()
  if (push) pushNav('workbench', null)

  threadInner.innerHTML = `<div class="home-hero"><h2>今天想研究什么？</h2></div>`
}

async function openSession(id, { push = true } = {}) {
  current = id
  liveMsg = null
  uploadedRefs = []
  pendingImages = []
  renderAttachments()
  setUrlSession(id)
  document.body.classList.add('has-session')
  document.body.classList.remove('home-stage')
  renderSessions()
  syncFx()
  if (push) pushNav('workbench', id)

  const s = await api(`/api/sessions/${id}`)
  const meta = state.sessions.find((x) => x.id === id)
  const mode = meta?.mode || 'chat'
  $('#topModeBadge').hidden = false
  $('#topModeBadge').textContent = MODES[mode] || '对话'
  $('#title').textContent = s.title || meta?.title || id
  $('#subtitle').textContent = `…/${s.cwd.split(/[\\/]/).slice(-2).join('/')}`
  $('#subtitle').title = `工作目录：${s.cwd}`
  $('#inspectorBtn').hidden = false
  $('#inspector').hidden = !inspectorOpen

  threadInner.innerHTML = ''
  for (const m of s.messages) renderStored(m)
  for (const ap of s.pendingApprovals || []) appendApprovalCard(ap.id, ap.tool, ap.summary)

  if (!s.messages.length && !(s.pendingApprovals || []).length) {
    renderFreshSessionEmpty()
  }

  setBusy(s.busy)
  connect(id)
  scrollBottom()
  refreshInspectorAndPill()
}

function renderFreshSessionEmpty() {
  threadInner.innerHTML = `
    <div class="empty-session">
      <h2>今天想研究什么？</h2>
      <p>可将数据、PDF、TeX 或 Word 稿件拖入下方输入框，会自动保存到工作目录 <code>inputs/</code>。</p>
    </div>`
}

$('#title').onclick = async () => {
  if (!current || view !== 'workbench') return
  await renameSessionFlow(current, $('#title').textContent)
}

// ---------- Thread Rendering & Tool Trace ----------
function toolEl(name, args, id) {
  const d = document.createElement('details')
  d.className = 'tool'
  if (id) d.dataset.id = id
  const { label, codeName, detail } = formatToolSummary(name, args)
  d.innerHTML = `
    <summary>
      <i class="dot"></i>
      <span class="t-label">${esc(label)}</span>
      <span class="t-detail">${esc(detail)}</span>
      <span class="t-code">${esc(codeName)}</span>
      <span class="state">运行中</span>
    </summary>
    <div class="tool-body">
      <pre class="args">${esc(JSON.stringify(args, null, 2))}</pre>
      <pre class="result"></pre>
    </div>`
  return d
}

function fillTool(t, text, isError) {
  t.dataset.done = '1'
  $('.state', t).textContent = isError ? '✗ 出错' : '✓'
  $('.result', t).textContent = text
  if (isError) t.classList.add('err')
}

function appendAssistantActions(msgEl, rawText) {
  if ($('.msg-actions', msgEl)) return
  const bar = document.createElement('div')
  bar.className = 'msg-actions'
  bar.innerHTML = `
    <button type="button" data-copy="1" title="复制 Markdown 原文">复制</button>
    <button type="button" data-v="1" title="有用">👍</button>
    <button type="button" data-v="-1" title="不好">👎</button>
    <button type="button" data-c="1" title="写一条评价（作为进化信号）">评价</button>`
  bar.onclick = async (e) => {
    const b = e.target.closest('button')
    if (!b) return
    if (b.dataset.copy) {
      await navigator.clipboard.writeText(rawText ?? msgEl.innerText)
      toast('已复制回复内容', 'ok')
      return
    }
    if (b.dataset.c) {
      const note = await promptDialog({
        title: '记录评价（用于自我进化）',
        label: '这次回答哪里做得好、或者哪里需要改进？',
        placeholder: '例如：引用全部正确 / 图表字号太小 / 漏了某一步…',
        multiline: true,
        confirmText: '提交评价'
      })
      if (note && note.trim()) {
        await post(`/api/sessions/${current}/feedback`, { kind: 'comment', note: note.trim() })
        toast('感谢反馈，已记入轨迹库', 'ok')
      }
    } else if (b.dataset.v) {
      await post(`/api/sessions/${current}/feedback`, { kind: 'thumb', value: Number(b.dataset.v) })
      $$('button[data-v]', bar).forEach((x) => x.classList.toggle('on', x === b))
      toast('已记录反馈', 'ok')
    }
  }
  msgEl.appendChild(bar)
}

function renderStored(m) {
  if (m.role === 'user') {
    const imgBadge = m.images ? ` <span class="muted">[附 ${m.images} 张图片]</span>` : ''
    threadInner.insertAdjacentHTML('beforeend', `<div class="msg user">${esc(m.text)}${imgBadge}</div>`)
    return
  }
  if (m.role === 'assistant') {
    if (m.text.trim()) {
      const wrap = document.createElement('div')
      wrap.className = 'msg assistant'
      wrap.innerHTML = md(m.text)
      appendAssistantActions(wrap, m.text)
      threadInner.appendChild(wrap)
    }
    for (const c of m.calls) threadInner.appendChild(toolEl(c.name, c.arguments, c.id))
    return
  }
  if (m.role === 'tool') {
    const t = [...threadInner.querySelectorAll('.tool:not([data-done])')].at(0)
    if (t) fillTool(t, m.text, m.isError)
  }
}

function appendApprovalCard(id, tool, summary) {
  const node = $('#tplApproval').content.firstElementChild.cloneNode(true)
  node.dataset.id = id
  $('.tool', node).textContent = tool
  $('.summary', node).textContent = summary
  $('.allow', node).onclick = () => decide(id, true, node)
  $('.deny', node).onclick = () => decide(id, false, node)
  threadInner.appendChild(node)
}

async function decide(id, allow, node) {
  await post(`/api/sessions/${current}/approve/${id}`, { allow })
  node.classList.add('done')
}

threadInner.addEventListener('click', async (e) => {
  const btn = e.target.closest('.copy-code-btn')
  if (!btn) return
  const code = btn.closest('.code-block')?.querySelector('pre code')?.textContent ?? ''
  await navigator.clipboard.writeText(code)
  btn.textContent = '已复制'
  setTimeout(() => (btn.textContent = '复制'), 1500)
})

// ---------- Live SSE Events ----------
function connect(id) {
  es?.close()
  es = new EventSource(`/api/sessions/${id}/events`)
  es.onmessage = (ev) => handle(JSON.parse(ev.data))
}

function ensureLive() {
  if (liveMsg) return liveMsg
  const el = document.createElement('div')
  el.className = 'msg assistant'
  const bodyEl = document.createElement('div')
  bodyEl.className = 'msg-body'
  el.appendChild(bodyEl)
  threadInner.appendChild(el)
  liveMsg = { el, bodyEl, reasoningWrap: null, reasoningBody: null, text: '', reasoning: '' }
  return liveMsg
}

function handle(e) {
  if (e.type === 'reasoning' || e.type === 'text') fx.setState('thinking')
  else if (e.type === 'tool-call') fx.setState('tool')
  else if (e.type === 'tool-result' || e.type === 'approval-resolved') fx.setState('thinking')
  else if (e.type === 'approval') fx.setState('approval')
  else if (e.type === 'done' || e.type === 'error') fx.setState('idle')

  switch (e.type) {
    case 'hello':
      if (e.busy) setBusy(true)
      break
    case 'reasoning': {
      const lm = ensureLive()
      lm.reasoning += e.text
      if (!lm.reasoningWrap) {
        const d = document.createElement('details')
        d.className = 'reasoning-wrap'
        if (prefs.expandReasoning) d.open = true
        d.innerHTML = `<summary>思考过程</summary><div class="reasoning-body"></div>`
        lm.el.prepend(d)
        lm.reasoningWrap = d
        lm.reasoningBody = $('.reasoning-body', d)
      }
      lm.reasoningBody.textContent = lm.reasoning
      break
    }
    case 'text': {
      const lm = ensureLive()
      lm.text += e.text
      lm.bodyEl.innerHTML = md(lm.text)
      break
    }
    case 'tool-call':
      if (liveMsg && !liveMsg.text.trim() && !liveMsg.reasoning) liveMsg.el.remove()
      liveMsg = null
      threadInner.appendChild(toolEl(e.name, e.arguments, e.id))
      break
    case 'tool-result': {
      const t = [...threadInner.querySelectorAll('.tool:not([data-done])')].at(0)
      if (t) fillTool(t, e.preview, e.isError)
      break
    }
    case 'approval':
      appendApprovalCard(e.id, e.tool, e.summary)
      refreshSessionPillOnly()
      break
    case 'approval-resolved': {
      const n = threadInner.querySelector(`.approval[data-id="${e.id}"]`)
      if (n) {
        n.classList.add('done')
        $('.approval-head', n).textContent = e.allow ? '已允许执行' : '已拒绝执行'
      }
      refreshSessionPillOnly()
      break
    }
    case 'warning':
      banner(e.message)
      break
    case 'error':
      threadInner.insertAdjacentHTML('beforeend', `<div class="error-box">${esc(e.message)}</div>`)
      break
    case 'status':
      if (e.status === 'running') setBusy(true)
      break
    case 'done': {
      setBusy(false)
      if (liveMsg && liveMsg.text.trim()) appendAssistantActions(liveMsg.el, liveMsg.text)
      liveMsg = null
      updateSidebarBudget(e.budget)
      api('/api/state').then((s) => {
        state = s
        renderSessions()
      })
      refreshInspectorAndPill()
      break
    }
  }
  scrollBottom()
}

function setBusy(b) {
  $('#sendBtn').disabled = b
  $('#stopBtn').hidden = !b
}
$('#stopBtn').onclick = () => current && post(`/api/sessions/${current}/cancel`)

// ---------- Right Inspector & Floating Session Pill ----------
function refreshSessionPillOnly() {
  const pendingApproval = threadInner.querySelector('.approval:not(.done)')
  if (pendingApproval) {
    const pill = $('#sessionPill')
    pill.hidden = false
    pill.classList.add('attn')
    pill.textContent = '⚡ 有工具调用等待你确认执行 · 点击定位'
    pill.onclick = () => pendingApproval.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return true
  }
  return false
}

async function refreshInspectorAndPill() {
  if (!current) {
    $('#sessionPill').hidden = true
    return
  }
  const sid = current
  const [summary, filesRes] = await Promise.all([
    api(`/api/sessions/${sid}/summary`).catch(() => null),
    api(`/api/sessions/${sid}/files`).catch(() => null)
  ])
  if (current !== sid) return

  const files = filesRes?.files || []
  const isImg = (p) => /\.(png|jpe?g|svg|gif|webp)$/i.test(p)
  const outputFiles = files.filter((f) => !f.path.startsWith('inputs/') && !f.path.startsWith('inputs\\'))
  const inputFiles = files.filter((f) => f.path.startsWith('inputs/') || f.path.startsWith('inputs\\'))
  const outputImgs = outputFiles.filter((f) => isImg(f.path))
  const reports = summary?.reports || []

  $('#inspectorCount').hidden = files.length === 0 && reports.length === 0
  $('#inspectorCount').textContent = String(files.length + reports.length)

  if (!refreshSessionPillOnly()) {
    const pill = $('#sessionPill')
    const parts = []
    if (outputImgs.length) parts.push(`${outputImgs.length} 张图表`)
    if (reports.length) parts.push(`${reports.length} 份检查报告`)
    if (files.length) parts.push(`${files.length} 个工作区文件`)
    if (summary?.stats?.costCny > 0) parts.push(`本会话 ${yuan(summary.stats.costCny)}`)
    if (parts.length) {
      pill.hidden = false
      pill.classList.remove('attn')
      pill.textContent = `📎 ${parts.join(' · ')} · 查看检查器`
      pill.onclick = () => toggleInspector(true)
    } else {
      pill.hidden = true
    }
  }

  if (inspectorOpen) renderInspectorBody(sid, summary, { files, outputFiles, inputFiles, outputImgs })
}

function renderInspectorBody(sid, summary, { outputFiles, inputFiles, outputImgs }) {
  const st = summary?.stats || {}
  const reports = summary?.reports || []
  const skills = summary?.usedSkills || []
  const link = (p) => `/api/sessions/${encodeURIComponent(sid)}/file?path=${encodeURIComponent(p)}`

  const fileRow = (f) => `
    <button type="button" class="file-row" data-fpath="${esc(f.path)}">
      <span class="file-path">${esc(f.path)}</span>
      <span class="file-size">${(f.size / 1024).toFixed(1)} KB</span>
    </button>`

  const body = $('#inspectorBody')
  body.innerHTML = `
    <div class="ins-sec">
      <h4><span>进度与统计</span></h4>
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-k">对话轮次</div><div class="stat-v">${st.turns ?? 0} 轮 · ${st.steps ?? 0} 步</div></div>
        <div class="stat-card"><div class="stat-k">本会话花费</div><div class="stat-v">${yuan(st.costCny ?? 0)}</div></div>
        <div class="stat-card"><div class="stat-k">工具调用</div><div class="stat-v">${st.toolCalls ?? 0} 次${st.toolErrors ? ` (${st.toolErrors} 错)` : ''}</div></div>
        <div class="stat-card"><div class="stat-k">Tokens</div><div class="stat-v">${((st.inputTokens || 0) + (st.outputTokens || 0)).toLocaleString()}</div></div>
      </div>
    </div>

    ${
      reports.length
        ? `<div class="ins-sec">
            <h4><span>稿件检查报告 (${reports.length})</span></h4>
            ${reports
              .map(
                (rep, idx) => `
              <div class="report-card">
                <div class="report-card-h"><span>${esc(rep.summary?.file || rep.dir)}</span><code>${esc(rep.summary?.stage || '')}</code></div>
                <div class="report-card-sub">${esc((rep.summary?.packs || []).join(', '))}${rep.summary?.variant ? ` · ${esc(rep.summary.variant)}` : ''}</div>
                <div class="report-counts">
                  <span class="sev-pill err">错误 ${rep.counts?.error ?? 0}</span>
                  <span class="sev-pill warn">提醒 ${rep.counts?.warning ?? 0}</span>
                  <span class="sev-pill info">提示 ${rep.counts?.info ?? 0}</span>
                </div>
                <button type="button" class="btn ghost small" data-open-report="${idx}">审阅问题并标误报</button>
              </div>`
              )
              .join('')}
          </div>`
        : ''
    }

    <div class="ins-sec">
      <h4><span>Outputs 产物 (${outputFiles.length})</span></h4>
      ${
        outputImgs.length
          ? `<div class="thumb-grid">${outputImgs
              .map(
                (f) => `<button type="button" class="thumb-btn" data-img="${esc(f.path)}"><img src="${link(f.path)}" loading="lazy" alt=""><span>${esc(f.path.split(/[\\/]/).pop())}</span></button>`
              )
              .join('')}</div>`
          : ''
      }
      <div class="file-list">${outputFiles.length ? outputFiles.map(fileRow).join('') : '<span class="muted">尚无输出产物。</span>'}</div>
    </div>

    <div class="ins-sec">
      <h4><span>输入目录 inputs/ (${inputFiles.length})</span></h4>
      <div class="file-list">${inputFiles.length ? inputFiles.map(fileRow).join('') : '<span class="muted">暂无上传文件。</span>'}</div>
    </div>

    <div class="ins-sec">
      <h4><span>本会话使用</span></h4>
      <div class="skill-chips">${skills.length ? skills.map((sk) => `<span class="skill-chip">${esc(sk.name)} v${sk.version ?? 1}</span>`).join('') : '<span class="muted">尚未触发专用技能</span>'}</div>
      ${
        summary?.cwd
          ? `<div class="cwd-box"><code title="${esc(summary.cwd)}">${esc(summary.cwd)}</code><button type="button" class="btn ghost small" id="copyCwdBtn">复制</button></div>`
          : ''
      }
    </div>`

  $$('[data-open-report]', body).forEach((b) => {
    b.onclick = () => {
      const rep = reports[Number(b.dataset.openReport)]
      if (rep) openReportReviewModal(sid, rep, () => refreshInspectorAndPill(), ctx)
    }
  })

  $$('[data-img]', body).forEach((b) => {
    b.onclick = () => {
      const p = b.dataset.img
      openLightbox({ src: link(p), title: p, downloadHref: link(p) })
    }
  })

  $$('[data-fpath]', body).forEach((b) => {
    b.onclick = () => openFilePreviewModal(sid, b.dataset.fpath)
  })

  const copyCwd = $('#copyCwdBtn', body)
  if (copyCwd) {
    copyCwd.onclick = async () => {
      await navigator.clipboard.writeText(summary.cwd)
      toast('已复制工作目录路径', 'ok')
    }
  }
}

function toggleInspector(force) {
  inspectorOpen = force !== undefined ? force : !inspectorOpen
  $('#inspectorBtn').classList.toggle('on', inspectorOpen)
  $('#inspector').hidden = !(view === 'workbench' && current && inspectorOpen)
  if (inspectorOpen && current) refreshInspectorAndPill()
}
$('#inspectorBtn').onclick = () => toggleInspector()
$('#closeInspectorBtn').onclick = () => toggleInspector(false)
$('#refreshInspectorBtn').onclick = () => refreshInspectorAndPill()

// ---------- Composer: Attachments, Drag-Drop, Slash Commands, Model + Effort Picker ----------
function renderAttachments() {
  const box = $('#attachments')
  const imgHtml = pendingImages
    .map(
      (img) =>
        `<div class="att-item"><img src="${img.dataUrl}" alt=""><span>图片</span><button type="button" class="att-rm" data-rm-img="${img.id}" title="移除">×</button></div>`
    )
    .join('')
  const fileHtml = uploadedRefs
    .map(
      (p, i) =>
        `<div class="att-item"><span>📎 ${esc(p)}</span><button type="button" class="att-rm" data-rm-ref="${i}" title="从提示移除">×</button></div>`
    )
    .join('')
  box.innerHTML = imgHtml + fileHtml
}

$('#attachments').addEventListener('click', (e) => {
  const rImg = e.target.closest('[data-rm-img]')
  if (rImg) {
    pendingImages = pendingImages.filter((x) => String(x.id) !== rImg.dataset.rmImg)
    renderAttachments()
    return
  }
  const rRef = e.target.closest('[data-rm-ref]')
  if (rRef) {
    uploadedRefs.splice(Number(rRef.dataset.rmRef), 1)
    renderAttachments()
  }
})

function addImage(file) {
  const r = new FileReader()
  r.onload = () => {
    const [, mimeType, data] = /^data:([^;]+);base64,(.*)$/.exec(r.result)
    pendingImages.push({ id: Date.now() + Math.random(), mimeType, data, dataUrl: r.result })
    renderAttachments()
  }
  r.readAsDataURL(file)
}

async function ensureSessionForUpload(seedTitle) {
  if (current) return current
  const r = await post('/api/sessions', { title: seedTitle || '新会话' })
  await loadState()
  await openSession(r.id)
  return r.id
}

async function uploadToInputs(files) {
  if (!files?.length) return
  try {
    const sid = await ensureSessionForUpload(files[0].name.slice(0, 30))
    for (const f of files) {
      const data = await new Promise((res) => {
        const r = new FileReader()
        r.onload = () => res(String(r.result).split(',')[1])
        r.readAsDataURL(f)
      })
      const r = await post(`/api/sessions/${sid}/upload`, { name: f.name, data })
      uploadedRefs.push(r.path)
      toast(`已上传到 ${r.path}`, 'ok')
    }
    renderAttachments()
    refreshInspectorAndPill()
  } catch (err) {
    toast(err.message, 'err')
  }
}

$('#fileInput').onchange = async (e) => {
  await uploadToInputs([...e.target.files])
  e.target.value = ''
}
$('#imageInput').onchange = (e) => {
  for (const f of e.target.files) addImage(f)
  e.target.value = ''
}

const composerEl = $('#composer')
let dragDepth = 0
composerEl.addEventListener('dragenter', (e) => {
  if (e.dataTransfer?.types?.includes('Files')) {
    e.preventDefault()
    dragDepth++
    $('#dropOverlay').hidden = false
  }
})
composerEl.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types?.includes('Files')) e.preventDefault()
})
composerEl.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1)
  if (!dragDepth) $('#dropOverlay').hidden = true
})
composerEl.addEventListener('drop', async (e) => {
  e.preventDefault()
  dragDepth = 0
  $('#dropOverlay').hidden = true
  const files = [...(e.dataTransfer?.files || [])]
  if (files.length) await uploadToInputs(files)
})

function closePopovers() {
  clearTimeout(effortCloseTimer)
  $('#attachMenu').hidden = true
  $('#slashMenu').hidden = true
  $('#modelMenu').hidden = true
  $('#effortSubPanel').hidden = true
  effortOpen = false
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.composer-wrap')) closePopovers()
})

$('#attachBtn').onclick = (e) => {
  e.stopPropagation()
  const was = $('#attachMenu').hidden
  closePopovers()
  $('#attachMenu').hidden = !was
}
$('#attachMenu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-attach]')
  if (!b) return
  closePopovers()
  if (b.dataset.attach === 'file') $('#fileInput').click()
  else $('#imageInput').click()
})

const SLASH_TEMPLATES = [
  ['/文献', '文献检索与核验', '检索近两年关于【主题】的代表性文献，按年份整理并逐一核验 DOI/arXiv 链接。'],
  ['/数据', '实验统计 / 光谱拟合', '分析 inputs/ 中的数据文件，计算统计指标并给出汇总表或拟合参数。'],
  ['/出图', '期刊规范科研作图', '使用 inputs/ 中的数据按 Optica / Nature / IEEE 规范出图，并调用 figure_check 预览检查。'],
  ['/华科', '华科硕博论文规范检查', '按 hust-thesis（doctor/master）与 gbt7714 规范检查 inputs/ 中的论文，生成问题报告与批注副本。'],
  ['/顶会', '顶会论文投稿检查', '按 ml-conference（neurips2026/icml2026/iclr2026）规范检查 inputs/ 中的投稿稿件。']
]

function showSlashMenu(show) {
  const m = $('#slashMenu')
  if (!show) {
    m.hidden = true
    return
  }
  m.innerHTML = SLASH_TEMPLATES.map(
    ([cmd, desc, tpl], i) => `<button type="button" data-slash="${i}"><span class="pm-title">${cmd} · ${desc}</span><span class="pm-desc">${esc(tpl.slice(0, 48))}…</span></button>`
  ).join('')
  m.hidden = false
}

$('#slashBtn').onclick = (e) => {
  e.stopPropagation()
  const was = $('#slashMenu').hidden
  closePopovers()
  showSlashMenu(was)
}
$('#slashMenu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-slash]')
  if (!b) return
  const tpl = SLASH_TEMPLATES[Number(b.dataset.slash)][2]
  $('#input').value = tpl
  closePopovers()
  autosize()
  $('#input').focus()
})

// ---------- Claude-style Model + Cascading Effort Popover (ONLY connected API providers) ----------
const CHECK_SVG = `<svg viewBox="0 0 14 14" width="13" height="13" aria-hidden="true"><path d="M2.5 7.5 5.6 10.5 11.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`

let effortCloseTimer = null

function positionEffortPanel() {
  const sub = $('#effortSubPanel')
  const mainEl = $('#modelMainList')
  const trig = $('#effortTriggerBtn')
  if (sub.hidden || $('#modelMenu').hidden || !mainEl) return
  if (window.innerWidth <= 640) {
    sub.classList.remove('flip-left')
    sub.style.bottom = ''
    return
  }
  const mr = mainEl.getBoundingClientRect()
  const sw = sub.offsetWidth || 218
  const sh = sub.offsetHeight || 180
  const fitsRight = window.innerWidth - mr.right >= sw + 14
  const fitsLeft = mr.left >= sw + 14
  sub.classList.toggle('flip-left', !fitsRight && fitsLeft)
  if (trig && mr.height > 0) {
    const tr = trig.getBoundingClientRect()
    const idealBottom = mr.bottom - tr.bottom - Math.max(0, (sh - tr.height) / 2)
    sub.style.bottom = `${Math.max(0, Math.min(mr.height - 40, Math.round(idealBottom)))}px`
  }
}

function setEffortSubmenu(open) {
  clearTimeout(effortCloseTimer)
  effortOpen = !!open
  $('#effortTriggerBtn')?.classList.toggle('open-hover', effortOpen)
  if (effortOpen) renderEffortPanel()
  else $('#effortSubPanel').hidden = true
}

function renderEffortPanel() {
  const info = activeModelMeta()
  const sub = $('#effortSubPanel')
  if (!info.cap?.supported || !info.cap?.values?.length) {
    sub.hidden = true
    return
  }
  const values = info.cap.values
  sub.innerHTML = `
    <button type="button" class="mp-item" data-eff="default">
      <span class="mp-item-l"><span class="mp-item-t">默认</span></span>
      ${!info.effort ? `<span class="mp-check">${CHECK_SVG}</span>` : ''}
    </button>
    ${values
      .map((val) => {
        const meta = EFFORT_META[val] || { label: val }
        const on = info.effort === val
        const badge = meta.pill ? `<span class="mp-pill${meta.warn ? ' warn' : ''}">${esc(meta.pill)}</span>` : ''
        return `
        <button type="button" class="mp-item" data-eff="${esc(val)}">
          <span class="mp-item-l"><span class="mp-item-t">${esc(meta.label)}</span>${badge}</span>
          ${on ? `<span class="mp-check">${CHECK_SVG}</span>` : ''}
        </button>`
      })
      .join('')}`
  sub.hidden = false
  positionEffortPanel()
}

async function applyEffortChoice(effort) {
  const ref = activeModelMeta().ref
  try {
    const res = await post('/api/providers/effort', { model: ref, effort })
    state.reasoningEffort = res.reasoningEffort
    renderModelButtonLabel()
    renderModelPopover()
    toast(`思考程度已设为 ${effort === 'default' ? '默认' : EFFORT_META[effort]?.label || effort}`, 'ok')
  } catch (err) {
    toast(err.message, 'err')
  }
}

function renderModelPopover() {
  if (!state) return
  const info = activeModelMeta()
  const connected = state.providers.filter((p) => p.hasKey)
  const canRefresh = connected.some((p) => p.modelsListUrl)
  const multi = connected.length > 1

  const modelItems = connected.flatMap((p) =>
    p.models.map((mod) => ({
      ref: `${p.id}/${mod.id}`,
      id: mod.id,
      provider: p.label,
      vision: mod.vision
    }))
  )

  const effortRow = info.cap?.supported
    ? `<div class="mp-sep"></div>
       <button type="button" class="mp-item ${effortOpen ? 'open-hover' : ''}" id="effortTriggerBtn">
         <span class="mp-item-l"><span class="mp-item-t">思考程度</span></span>
         <span class="mp-arrow"><span>${esc(info.effort ? EFFORT_META[info.effort]?.label || info.effort : '默认')}</span><svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M3.5 2 6.5 5 3.5 8" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
       </button>`
    : ''

  $('#modelMainList').innerHTML = `
    ${
      modelItems.length
        ? modelItems
            .map(
              (x, idx) => `
          <button type="button" class="mp-item" data-mref="${esc(x.ref)}">
            <span class="mp-item-l">
              <span class="mp-item-t">${esc(x.id)}${x.vision ? ' 👁' : ''}</span>
              ${multi ? `<span class="mp-vendor-tag">${esc(x.provider)}</span>` : ''}
            </span>
            ${x.ref === info.ref ? `<span class="mp-check">${CHECK_SVG}</span>` : `<span class="mp-idx">${idx + 1}</span>`}
          </button>`
            )
            .join('')
        : `<button type="button" class="mp-item" data-open-providers="1">
            <span class="mp-item-l"><span class="mp-item-t">配置 API Key 以解锁模型</span></span>
            <span class="mp-arrow">›</span>
          </button>`
    }
    ${effortRow}
    <div class="mp-sep"></div>
    <button type="button" class="mp-item" data-open-providers="1">
      <span class="mp-item-l"><span class="mp-item-t">更多模型</span></span>
      <span class="mp-arrow"><svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M3.5 2 6.5 5 3.5 8" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    </button>
    ${
      canRefresh
        ? `<button type="button" class="mp-item" id="refreshModelsBtn">
             <span class="mp-item-l"><span class="mp-item-t" style="color:rgba(255,255,255,0.62)">刷新上游模型列表</span></span>
             <span class="mp-idx">↻</span>
           </button>`
        : ''
    }`

  if (effortOpen) renderEffortPanel()
  else $('#effortSubPanel').hidden = true
}

$('#modelChip').onclick = (e) => {
  e.stopPropagation()
  const openEffortDirect = !!e.target.closest('#effortTag')
  const m = $('#modelMenu')
  const was = m.hidden
  if (!was && (!openEffortDirect || effortOpen)) {
    closePopovers()
    return
  }
  closePopovers()
  if (!state) return
  effortOpen = openEffortDirect
  m.hidden = false
  renderModelPopover()
}

$('#modelMainList').addEventListener('click', async (e) => {
  e.stopPropagation()
  if (e.target.closest('#refreshModelsBtn')) {
    const label = $('#refreshModelsBtn .mp-item-t')
    if (label) label.textContent = '刷新中…'
    try {
      const res = await post('/api/providers/refresh', {})
      if (Array.isArray(res.providers)) state.providers = res.providers
      renderModelPopover()
      toast('已刷新已接入厂商的模型列表', 'ok')
    } catch (err) {
      toast(err.message, 'err')
      if (label) label.textContent = '刷新上游模型列表'
    }
    return
  }
  if (e.target.closest('#effortTriggerBtn')) {
    setEffortSubmenu(!effortOpen)
    return
  }
  const provBtn = e.target.closest('[data-open-providers]')
  if (provBtn) {
    closePopovers()
    openSettingsModal(ctx, 'models')
    return
  }
  const modBtn = e.target.closest('[data-mref]')
  if (!modBtn) return
  const ref = modBtn.dataset.mref
  if (!ref || ref === state?.genome?.roles?.main) {
    closePopovers()
    return
  }
  try {
    await post('/api/genome/roles', { roles: { ...state.genome.roles, main: ref } })
    toast(`已切换模型为 ${ref.split('/').pop()}`, 'ok')
    await loadState()
    renderModelPopover()
  } catch (err) {
    toast(err.message, 'err')
  }
})

$('#modelMainList').addEventListener('mouseover', (e) => {
  if (e.target.closest('#effortTriggerBtn')) {
    clearTimeout(effortCloseTimer)
    if (!effortOpen) setEffortSubmenu(true)
  } else if (e.target.closest('.mp-item') && effortOpen) {
    clearTimeout(effortCloseTimer)
    effortCloseTimer = setTimeout(() => setEffortSubmenu(false), 140)
  }
})

$('#effortSubPanel').addEventListener('mouseenter', () => {
  clearTimeout(effortCloseTimer)
})

$('#effortSubPanel').addEventListener('click', async (e) => {
  e.stopPropagation()
  const btn = e.target.closest('[data-eff]')
  if (btn) await applyEffortChoice(btn.dataset.eff)
})

// Textarea autosize & shortcuts
function autosize() {
  const t = $('#input')
  t.style.height = 'auto'
  t.style.height = `${Math.min(200, t.scrollHeight)}px`
}
$('#input').addEventListener('input', () => {
  autosize()
  if ($('#input').value === '/') showSlashMenu(true)
  else if (!$('#slashMenu').hidden && !$('#input').value.startsWith('/')) $('#slashMenu').hidden = true
})
$('#input').addEventListener('focus', () => fx.setMouseStrength?.(0.15))
$('#input').addEventListener('blur', () => fx.setMouseStrength?.())
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    $('#composer').requestSubmit()
  }
})
$('#input').addEventListener('paste', (e) => {
  for (const item of e.clipboardData?.items || []) {
    if (item.type.startsWith('image/')) {
      addImage(item.getAsFile())
      e.preventDefault()
    }
  }
})

$('#composer').onsubmit = async (e) => {
  e.preventDefault()
  closePopovers()
  let text = $('#input').value.trim()
  if (!text && !pendingImages.length && !uploadedRefs.length) return
  if (uploadedRefs.length) {
    const refLine = uploadedRefs.map((p) => `（已上传文件：${p}）`).join('\n')
    text = text ? `${text}\n\n${refLine}` : refLine
  }
  if (!current) {
    const r = await post('/api/sessions', { title: text.slice(0, 30) || '新会话' })
    await loadState()
    await openSession(r.id)
  }
  $('.empty-session', threadInner)?.remove()
  $('.home-hero', threadInner)?.remove()
  threadInner.insertAdjacentHTML(
    'beforeend',
    `<div class="msg user">${esc(text)}${pendingImages.length ? ` <span class="muted">[附 ${pendingImages.length} 张图片]</span>` : ''}</div>`
  )

  const images = pendingImages.map(({ mimeType, data }) => ({ mimeType, data }))
  pendingImages = []
  uploadedRefs = []
  renderAttachments()
  $('#input').value = ''
  autosize()
  setBusy(true)
  try {
    await post(`/api/sessions/${current}/ask`, { text, images })
  } catch (err) {
    setBusy(false)
    handle({ type: 'error', message: err.message })
  }
  scrollBottom()
}

// Global keyboard shortcut: Cmd/Ctrl + B toggles sidebar
addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b' && view === 'workbench') {
    e.preventDefault()
    updatePrefs({ sidebarCollapsed: !prefs.sidebarCollapsed })
  }
})
addEventListener('resize', () => {
  if (innerWidth > 900) $('#sidebarBackdrop').hidden = true
})

// ---------- Boot ----------
applyPrefs()
loadState()
  .then(() => {
    const sid = new URLSearchParams(location.search).get('s')
    if (sid && state.sessions.some((x) => x.id === sid)) openSession(sid)
    else goHome()
  })
  .catch((e) => banner(e.message))
