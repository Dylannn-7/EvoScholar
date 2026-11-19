// Workbench: project tree, transparent conversation, composer (model / effort / permission / files / @).
import { $, closePop, fx, go, openPop, store, syncFx } from '../app.js'
import { ago, api, apiFetch, del, fmtSize, loadApiImages, patch, post } from './api.js'
import { openEventStream } from './stream.js'
import { icon } from './icons.js'
import { formatToolSummary, md } from './markdown.js'
import { confirmDialog, esc, openModal, promptDialog, toast } from './modal.js'
import { chooseFolder } from './folder-picker.js'
import { openFilePreviewModal, openReportReviewModal } from './review.js'

const PERMS = {
  ask: { label: '询问', desc: '写文件和执行前询问', icon: 'shield' },
  acceptEdits: { label: '自动接受编辑', desc: '自动写文件，执行前询问', icon: 'edit' },
  plan: { label: '计划', desc: '只读，先给计划', icon: 'brain' },
  bypass: { label: '完全放行', desc: '全部自动执行', icon: 'bolt' }
}
// Runtime messages that can reach the transcript, in the user's language.
const ERRORS = [
  [/Resolve pending tools|Reconcile uncertain tool effects|Missing pending tool/, '上一轮被中途停止，请重新发送'],
  [/requires explicit recovery|Recovery identity changed/, '会话状态需要恢复，请重新打开这个会话'],
  [/aborted|AbortError/i, '已停止'],
  [/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i, '无法连接模型服务，请检查网络和厂商设置']
]
const readableError = (message = '') => {
  const hit = ERRORS.find(([re]) => re.test(message))
  return hit ? hit[1] : /[\u4e00-\u9fa5]/.test(message) ? message : `出错了：${message}`
}
const LS = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v) } catch {} }

export function initWorkbench () {
  const W = {
    current: null, // session id
    session: null, // session detail
    es: null,
    busy: false,
    project: LS('evo.project') || null, // project for new chats (null = drafts)
    model: null,
    effort: null,
    permission: null,
    files: [], // pending attachments: { file, name, image, url, path? }
    refs: [], // @ references (project-relative paths)
    live: null, // streaming assistant message
    think: null, // streaming reasoning step
    calls: new Map(), // callId -> step element
    turnStart: 0,
    openProjects: new Set(JSON.parse(LS('evo.openProjects') || '["drafts"]'))
  }
  const S = () => store.state
  const inner = $('#threadInner')
  const thread = $('#thread')
  const input = $('#input')
  const scroll = () => { thread.scrollTop = thread.scrollHeight }

  // ------------------------------------------------------------ defaults
  const providers = () => (S().providers || []).filter((p) => p.hasKey && p.models.length)
  const allModels = () => providers().flatMap((p) => p.models.map((m) => ({ ref: `${p.id}/${m.id}`, p, m })))
  const findModel = (ref) => allModels().find((x) => x.ref === ref)
  function resetChoices () {
    const d = S().defaults || {}
    W.model = W.session?.model || d.model || allModels()[0]?.ref || null
    W.effort = W.session ? W.session.effort : (S().efforts || {})[W.model] ?? d.effort ?? null
    W.permission = W.session?.permission || d.permission || 'ask'
  }

  // ------------------------------------------------------------ sidebar
  $('#addProject').innerHTML = icon('folderPlus', 17)
  $('#newChat').innerHTML = `${icon('plus', 16)}<span>新建会话</span><span class="k">${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'} N</span>`.replace('⌘', 'Cmd')
  $('#newChat').onclick = () => { go('workbench'); W.home() }
  $('#addProject').onclick = () => pickFolder()
  addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n' && !e.shiftKey) { e.preventDefault(); go('workbench'); W.home() } })

  function renderTree () {
    const sessions = S().sessions || []
    const groups = [...(S().projects || []).map((p) => ({ id: p.id, name: p.name, path: p.path })), { id: 'drafts', name: '草稿', path: '' }]
    $('#tree').innerHTML = groups.map((g) => {
      const list = sessions.filter((s) => (s.projectId || 'drafts') === g.id)
      const open = W.openProjects.has(g.id) || list.some((s) => s.id === W.current)
      const isCur = (W.project || 'drafts') === g.id
      return `<div class="proj ${open ? 'open' : ''} ${isCur ? 'current' : ''}" data-p="${esc(g.id)}">
        <div class="proj-row" title="${esc(g.path || '')}">
          <span class="caret">${icon('chevron', 13)}</span>${icon(g.id === 'drafts' ? 'file' : 'folder', 15)}<span class="name">${esc(g.name)}</span>
          <span class="acts"><button class="icon-btn" data-act="new" data-tip="在此项目新建会话" type="button">${icon('plus', 14)}</button>${g.id !== 'drafts' ? `<button class="icon-btn" data-act="pmenu" title="项目操作" type="button">${icon('more', 14)}</button>` : ''}</span>
        </div>
        <div class="sess-list">${list.length ? list.map((s) => `<div class="sess ${s.id === W.current ? 'on' : ''}" data-s="${esc(s.id)}">
            ${s.running ? '<i class="run"></i>' : ''}<span class="t">${esc(s.title || s.id)}</span><span class="when">${esc(ago(s.last || s.created_at))}</span>
            <button class="icon-btn menu" data-act="smenu" title="会话操作" type="button">${icon('more', 14)}</button></div>`).join('') : '<div class="sess-empty">还没有会话</div>'}</div>
      </div>`
    }).join('')
  }
  $('#tree').addEventListener('click', async (e) => {
    const projEl = e.target.closest('.proj')
    const pid = projEl?.dataset.p
    const act = e.target.closest('[data-act]')?.dataset.act
    if (act === 'new') { W.project = pid === 'drafts' ? null : pid; LS('evo.project', W.project); go('workbench'); W.home(); return }
    if (act === 'pmenu') return projectMenu(e.target.closest('[data-act]'), pid)
    const sEl = e.target.closest('.sess')
    if (act === 'smenu') return sessionMenu(e.target.closest('[data-act]'), sEl.dataset.s)
    if (sEl) { go('workbench'); return W.open(sEl.dataset.s) }
    if (e.target.closest('.proj-row')) {
      W.openProjects.has(pid) ? W.openProjects.delete(pid) : W.openProjects.add(pid)
      LS('evo.openProjects', JSON.stringify([...W.openProjects]))
      renderTree()
    }
  })
  function projectMenu (anchor, pid) {
    const p = S().projects.find((x) => x.id === pid)
    openPop(anchor, [
      { label: '重命名', icon: 'edit', onPick: async () => { const n = await promptDialog({ title: '重命名项目', defaultValue: p.name }); if (n) { await patch(`/api/projects/${pid}`, { name: n }); await refresh() } } },
      { label: '在资料空间查看', icon: 'library', onPick: () => go('library', { project: pid }) },
      { label: '从列表移除', desc: '不删除文件', icon: 'archive', onPick: async () => { await patch(`/api/projects/${pid}`, { archived: true }); if (W.project === pid) { W.project = null; LS('evo.project', null) } await refresh() } }
    ])
  }
  function sessionMenu (anchor, sid) {
    const s = S().sessions.find((x) => x.id === sid)
    openPop(anchor, [
      { label: '重命名', icon: 'edit', onPick: async () => { const n = await promptDialog({ title: '重命名会话', defaultValue: s.title }); if (n) { await patch(`/api/sessions/${sid}`, { title: n }); if (W.current === sid && W.session) { W.session.title = n; renderHead() } await refresh() } } },
      { label: s.pinned ? '取消置顶' : '置顶', icon: 'pin', onPick: async () => { await patch(`/api/sessions/${sid}`, { pinned: !s.pinned }); await refresh() } },
      { label: '会话文件', icon: 'library', onPick: () => go('library', { session: sid }) },
      { label: '删除会话', icon: 'trash', desc: s.projectId ? '保留项目文件' : '同时删除草稿文件', onPick: async () => {
        if (!(await confirmDialog({ title: '删除会话', message: `删除「${s.title || sid}」？对话记录不可恢复。`, confirmText: '删除', danger: true }))) return
        await del(`/api/sessions/${sid}`)
        if (W.current === sid) W.home()
        await refresh()
      } }
    ])
  }
  async function refresh () { await store.refresh(); renderTree(); renderBar() }

  // ------------------------------------------------------------ add a project folder
  async function pickFolder () {
    const path = await chooseFolder({ title: '添加项目文件夹', confirmText: '添加这个文件夹' })
    if (!path) return
    try {
      const r = await post('/api/projects', { path })
      W.project = r.project.id
      LS('evo.project', W.project)
      W.openProjects.add(r.project.id)
      await refresh()
      toast(`已添加项目「${r.project.name}」`, 'ok')
      W.home()
    } catch (err) { toast(err.message, 'err') }
  }

  // ------------------------------------------------------------ composer bar
  function renderBar () {
    // A remembered project can disappear (removed, or another workspace); fall back to drafts.
    const projects = S().projects
    if (W.project && projects && !projects.some((p) => p.id === W.project)) { W.project = null; LS('evo.project', null) }
    const m = findModel(W.model)
    const effCap = m?.m.reasoningEffort
    const proj = (S().projects || []).find((p) => p.id === (W.session ? W.session.projectId : W.project))
    const perm = PERMS[W.permission] || PERMS.ask
    $('#cbar').innerHTML = `
      <button type="button" class="tb" data-b="attach" data-tip-top title="添加文件或图片">${icon('paperclip', 17)}</button>
      <button type="button" class="tb" data-b="at" title="引用项目文件">${icon('at', 17)}</button>
      ${W.session ? '' : `<button type="button" class="tb" data-b="project" title="选择项目">${icon('folder', 16, 'dim')}<span class="proj-name">${esc(proj?.name || '草稿')}</span>${icon('chevronDown', 12, 'dim')}</button>`}
      <span class="sp"></span>
      <button type="button" class="tb ${W.permission === 'bypass' ? 'warn' : ''}" data-b="perm" title="权限模式">${icon(perm.icon, 15, 'dim')}<span>${perm.label}</span></button>
      ${effCap?.supported ? `<button type="button" class="tb" data-b="effort" title="思考程度（${esc(m.m.reasoningParam || '')}）">${icon('brain', 15, 'dim')}<span>${esc(W.effort || '默认')}</span></button>` : ''}
      <button type="button" class="tb" data-b="model" title="模型">${m ? esc(m.m.id) : '<span style="color:var(--warn)">先接入模型</span>'}${icon('chevronDown', 12, 'dim')}</button>
      ${W.busy ? `<button type="button" class="stopb" data-b="stop" title="停止">${icon('stop', 14)}</button>` : `<button type="submit" class="send" id="sendBtn" title="发送（Enter）" ${m ? '' : 'disabled'}>${icon('arrowUp', 15)}</button>`}`
  }
  $('#cbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-b]')
    if (!b) return
    const k = b.dataset.b
    if (k === 'attach') return $('#fileInput').click()
    if (k === 'at') return atMenu(b)
    if (k === 'stop') return post(`/api/sessions/${W.current}/cancel`)
    if (k === 'project') {
      return openPop(b, [
        ...(S().projects || []).map((p) => ({ label: p.name, desc: p.path, icon: 'folder', checked: W.project === p.id, onPick: () => { W.project = p.id; LS('evo.project', p.id); renderBar(); renderTree() } })),
        { label: '草稿', icon: 'file', checked: !W.project, onPick: () => { W.project = null; LS('evo.project', null); renderBar(); renderTree() } },
        { label: '添加项目文件夹…', icon: 'folderPlus', onPick: pickFolder }
      ])
    }
    if (k === 'perm') {
      return openPop(b, Object.entries(PERMS).map(([id, p]) => ({ label: p.label, desc: p.desc, icon: p.icon, checked: W.permission === id, onPick: async () => {
        W.permission = id
        renderBar()
        if (W.current) await patch(`/api/sessions/${W.current}/settings`, { permission: id }).catch((err) => toast(err.message, 'err'))
      } })))
    }
    if (k === 'effort') {
      const m = findModel(W.model)
      const vals = m?.m.reasoningEffort?.values || []
      return openPop(b, [{ group: `思考程度 · ${m?.m.reasoningParam || ''}` }, { label: '默认', checked: !W.effort, onPick: () => { W.effort = null; renderBar() } },
        ...vals.map((v) => ({ label: v, checked: W.effort === v, onPick: () => { W.effort = v; renderBar() } }))])
    }
    if (k === 'model') {
      const items = []
      for (const p of providers()) {
        items.push({ group: p.label })
        for (const mm of p.models) items.push({ label: mm.id, desc: [mm.contextWindow ? `${Math.round(mm.contextWindow / 1000)}K 上下文` : '', mm.vision ? '可读图' : ''].filter(Boolean).join(' · '), checked: W.model === `${p.id}/${mm.id}`, onPick: () => {
          W.model = `${p.id}/${mm.id}`
          const caps = mm.reasoningEffort
          W.effort = caps?.supported ? ((S().efforts || {})[W.model] ?? (caps.values?.includes(W.effort) ? W.effort : null)) : null
          renderBar()
        } })
      }
      items.push({ label: '接入更多模型…', icon: 'settings', onPick: () => go('settings', 'models') })
      return openPop(b, items, { search: '搜索模型' })
    }
  })

  // ------------------------------------------------------------ attachments & refs
  function renderChips () {
    $('#chips').innerHTML = [
      ...W.files.map((f, i) => `<span class="file-chip ${f.image ? 'thumb' : ''}">${f.image ? `<img src="${f.url}" alt="">` : icon('file', 14)}<span>${esc(f.name)}</span><button type="button" class="x" data-rmf="${i}">${icon('close', 12)}</button></span>`),
      ...W.refs.map((r, i) => `<span class="file-chip">${icon('at', 14)}<span>${esc(r)}</span><button type="button" class="x" data-rmr="${i}">${icon('close', 12)}</button></span>`)
    ].join('')
  }
  $('#chips').addEventListener('click', (e) => {
    const f = e.target.closest('[data-rmf]'); const r = e.target.closest('[data-rmr]')
    if (f) { W.files.splice(Number(f.dataset.rmf), 1); renderChips() }
    if (r) { W.refs.splice(Number(r.dataset.rmr), 1); renderChips() }
  })
  const addFiles = (list) => {
    for (const file of list) {
      if (file.size > 25 * 1024 * 1024) { toast(`${file.name} 超过 25 MB`, 'err'); continue }
      const image = /^image\/(png|jpeg|gif|webp)$/.test(file.type)
      W.files.push({ file, name: file.name || `粘贴的图片.${(file.type.split('/')[1] || 'png')}`, image, url: image ? URL.createObjectURL(file) : '' })
    }
    renderChips()
  }
  $('#fileInput').onchange = (e) => { addFiles(e.target.files); e.target.value = '' }
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.items || [])].filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean)
    if (files.length) { e.preventDefault(); addFiles(files) }
  })
  const comp = $('#composer')
  comp.addEventListener('dragover', (e) => { e.preventDefault(); comp.classList.add('drag') })
  comp.addEventListener('dragleave', () => comp.classList.remove('drag'))
  comp.addEventListener('drop', (e) => { e.preventDefault(); comp.classList.remove('drag'); addFiles(e.dataTransfer.files) })

  async function atMenu (anchor, query = '') {
    const pid = W.session ? W.session.projectId : W.project
    let files = []
    try {
      if (pid) files = (await api(`/api/projects/${pid}/files?q=${encodeURIComponent(query)}`)).files
      else if (W.current) files = (await api(`/api/sessions/${W.current}/files`)).files.map((f) => ({ path: f.path, size: f.size }))
    } catch {}
    if (!files.length) return toast(pid || W.current ? '没有可引用的文件' : '没有可引用的文件', 'info')
    openPop(anchor, files.slice(0, 200).map((f) => ({ label: f.path, right: fmtSize(f.size), icon: /\.(png|jpe?g|svg|gif|webp)$/i.test(f.path) ? 'image' : 'file', onPick: () => {
      if (!W.refs.includes(f.path)) W.refs.push(f.path)
      input.value = input.value.replace(/@[^\s@]*$/, '')
      renderChips(); input.focus()
    } })), { search: '搜索文件' })
  }

  // ------------------------------------------------------------ input
  const autosize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(220, input.scrollHeight)}px` }
  input.addEventListener('input', () => {
    autosize()
    const m = /(^|\s)@([^\s@]*)$/.exec(input.value.slice(0, input.selectionStart))
    if (m) atMenu($('#cbar [data-b="at"]'), m[2])
  })
  input.addEventListener('focus', () => fx.call('setMouseStrength', 0.15))
  input.addEventListener('blur', () => fx.call('setMouseStrength'))
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !document.querySelector('.pop')) { e.preventDefault(); comp.requestSubmit() }
  })
  comp.addEventListener('submit', (e) => { e.preventDefault(); send() })

  async function upload (sid, f) {
    const data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(f.file) })
    return (await post(`/api/sessions/${sid}/upload`, { name: f.name, data })).path
  }

  async function send () {
    const text = input.value.trim()
    if ((!text && !W.files.length) || W.busy) return
    if (!W.model) return toast('请先在设置里接入模型', 'err')
    try {
      if (!W.current) {
        const r = await post('/api/sessions', { title: text.slice(0, 40) || '新会话', projectId: W.project, model: W.model, effort: W.effort, permission: W.permission })
        await refresh()
        await W.open(r.id, { keepComposer: true })
      }
      const sid = W.current
      const attachments = []
      for (const f of W.files) attachments.push(await upload(sid, f))
      const shown = [...W.files.map((f) => f.name), ...W.refs.map((r) => `@${r}`)]
      $('.greet', inner)?.remove()
      setFresh(false)
      inner.insertAdjacentHTML('beforeend', `<div class="msg user">${esc(text)}${shown.length ? `<div class="att">${shown.map((n) => `<span class="file-chip">${icon('file', 13)}<span>${esc(n)}</span></span>`).join('')}</div>` : ''}</div>`)
      const refs = W.refs
      W.files = []; W.refs = []
      input.value = ''; autosize(); renderChips()
      W.turnStart = Date.now()
      setBusy(true)
      await post(`/api/sessions/${sid}/ask`, { text, model: W.model, effort: W.effort || '', permission: W.permission, attachments, refs })
      scroll()
    } catch (err) {
      setBusy(false)
      inner.insertAdjacentHTML('beforeend', `<div class="error-line">${esc(err.message)}</div>`)
    }
  }

  // ------------------------------------------------------------ messages
  // Evolution steps: tool calls of the evolve tools and host events (recall, self-check, learned...).
  const EVO_TOOL = {
    reflect: ['反思', (a) => `${a.cause || ''} → ${a.next_action || ''}`],
    note_lesson: ['调整', (a) => `记经验：${a.trigger || ''} → ${a.advice || ''}`],
    tune_harness: ['调整', (a) => `本会话：${a.op === 'prompt.note' ? `追加规则「${a.value}」` : a.op === 'tool.note' ? `${a.target} 说明补充「${a.value}」` : `${a.op === 'skill.enable' ? '启用' : '停用'}技能 ${a.target}`}`],
    recall: ['回忆', (a) => `检索「${a.query || ''}」`],
    offer_choices: ['选择', (a) => a.question || ''],
    forge_skill: ['调整', (a) => `锻造可执行技能 ${a.name || ''}：${a.description || ''}`],
    patch_skill: ['调整', (a) => `补丁技能 ${a.skill || ''}：${a.addition || ''}`],
    propose_rule: ['调整', (a) => `提出写作规则 ${a.id || ''}：${a.description || ''}`],
    run_skill: ['技能', (a) => `调用 ${a.name || ''}`]
  }
  const EVO_LABEL = { recall: '回忆', reflect: '反思', adjust: '调整', selfcheck: '自检', learned: '学到', preference: '偏好', observe: '观察', credit: '归因', revert: '撤销', choice: '选择' }
  function evoEl (kind, text, opts = {}) {
    const d = document.createElement('details')
    d.className = `step evo k-${kind} done`
    const items = opts.items || []
    d.innerHTML = `<summary><i class="dot"></i><span class="lab">${EVO_LABEL[kind] || kind}</span><span class="det">${esc(text)}</span>${opts.refs?.length ? `<span class="ms">${esc(opts.refs.slice(0, 4).join(' '))}</span>` : ''}</summary>${items.length ? `<div class="body">${items.map((x) => `<div><code>${esc(x.id)}</code> ${esc(x.text)}</div>`).join('')}</div>` : ''}`
    return d
  }
  function revertBtn (d, text) {
    const m = /\b([LP]-\d{4})\b|\b(O-[a-z0-9]+)\b|\b(user\.[a-z0-9-]+)\b/.exec(text || '')
    if (!m || $('.undo', d)) return
    const b = document.createElement('button')
    b.className = 'btn ghost small undo'
    b.type = 'button'
    b.textContent = '撤销'
    b.onclick = async (e) => {
      e.preventDefault(); e.stopPropagation()
      try {
        if (m[1]) await del(`/api/memory/${m[1]}`)
        else if (m[2]) await post(`/api/overlays/${m[2]}/revert`)
        else await del(`/api/plugins/rules/${m[3]}`)
        b.textContent = '已撤销'; b.disabled = true; d.classList.add('reverted')
      } catch (err) { toast(err.message, 'err') }
    }
    $('summary', d).appendChild(b)
  }
  function stepEl (kind, name, args, id) {
    const d = document.createElement('details')
    d.className = `step ${kind}`
    if (id) d.dataset.id = id
    if (kind === 'tool' && EVO_TOOL[name]) {
      const [lab, fn] = EVO_TOOL[name]
      d.className = `step evo k-${lab === '调整' ? 'adjust' : name === 'reflect' ? 'reflect' : 'recall'}`
      d.dataset.evo = name
      d.innerHTML = `<summary><i class="dot"></i><span class="lab">${lab}</span><span class="det">${esc(fn(args || {}))}</span><span class="ms"></span></summary><div class="body"><pre class="res"></pre></div>`
      return d
    }
    if (kind === 'think') {
      d.innerHTML = `<summary><i class="dot"></i><span class="lab">思考</span><span class="det"></span><span class="ms"></span></summary><div class="body"></div>`
    } else {
      const s = formatToolSummary(name, args)
      d.innerHTML = `<summary><i class="dot"></i><span class="lab">工具</span><span class="nm">${esc(s.label)}</span><span class="det">${esc(s.detail)}</span><span class="ms"></span></summary><div class="body"><pre class="args">${esc(JSON.stringify(args, null, 2))}</pre><pre class="res"></pre></div>`
      if (!id || W.busy) d.dataset.t0 = Date.now()
    }
    return d
  }
  function finishStep (d, text, isError) {
    const denied = isError && /^(Permission denied|Host guard denied)/.test(text || '')
    const stopped = isError && /^已停止：/.test(text || '')
    d.classList.add(isError ? 'err' : 'done')
    if (denied || stopped) d.classList.add('denied')
    $('.res', d).textContent = text || ''
    if (!isError && ['note_lesson', 'tune_harness', 'patch_skill', 'propose_rule'].includes(d.dataset.evo)) revertBtn(d, text)
    if (denied) $('.ms', d).textContent = '已拦截'
    else if (stopped) $('.ms', d).textContent = '已停止'
    else if (d.dataset.t0) $('.ms', d).textContent = `${((Date.now() - Number(d.dataset.t0)) / 1000).toFixed(1)}s`
  }
  function feedbackEl () {
    const f = document.createElement('div')
    f.className = 'feedback'
    f.innerHTML = `<button class="icon-btn" data-v="1" title="有用" type="button">${icon('check', 15)}</button><button class="icon-btn" data-v="-1" title="不满意" type="button">${icon('close', 15)}</button><button class="icon-btn" data-c="1" title="写一句评价" type="button">${icon('edit', 15)}</button>`
    f.onclick = async (e) => {
      const b = e.target.closest('button')
      if (!b) return
      if (b.dataset.c) { const note = await promptDialog({ title: '评价这次回答', multiline: true, placeholder: '哪里好、哪里不对、希望下次怎么做' }); if (note) { await post(`/api/sessions/${W.current}/feedback`, { kind: 'comment', note }); toast('已记录', 'ok') } return }
      await post(`/api/sessions/${W.current}/feedback`, { kind: 'thumb', value: Number(b.dataset.v) })
      f.querySelectorAll('[data-v]').forEach((x) => x.classList.toggle('on', x === b))
      f.classList.add('keep')
    }
    return f
  }
  // The server appends "[附件] a；b" / "[引用文件] …" and may prefix the plan-mode note; show those as chips.
  function userHtml (raw, images = 0) {
    let text = String(raw || '').replace(/^【计划模式】[^\n]*\n\n/, '')
    const files = []
    text = text.replace(/\n\n\[(附件|引用文件)\] ([^\n]+)$/, (_, kind, list) => { for (const f of list.split('；')) files.push(f.replace(/（.*?）$/, '')); return '' })
    return `<div class="msg user">${esc(text)}${files.length || images ? `<div class="att">${files.map((f) => `<span class="file-chip">${icon('file', 13)}<span>${esc(f)}</span></span>`).join('')}${!files.length && images ? `<span class="file-chip">${icon('image', 13)}<span>${images} 张图片</span></span>` : ''}</div>` : ''}</div>`
  }
  function renderStored (m) {
    if (m.role === 'user') return inner.insertAdjacentHTML('beforeend', userHtml(m.text, m.images))
    if (m.role === 'assistant') {
      if (m.text.trim()) inner.insertAdjacentHTML('beforeend', `<div class="msg assistant">${md(m.text)}</div>`)
      for (const c of m.calls) inner.appendChild(stepEl('tool', c.name, c.arguments, c.id))
      return
    }
    if (m.role === 'tool') {
      const t = [...inner.querySelectorAll('.step:not(.think):not(.done):not(.err)')][0]
      if (t) finishStep(t, m.text, m.isError)
    }
  }
  async function turnFiles () {
    try {
      const r = await api(`/api/library?session=${encodeURIComponent(W.current)}`)
      const fresh = r.files.filter((f) => new Date(f.updated_at).getTime() >= W.turnStart - 2000 && f.kind === 'output')
      const target = W.live || W.answer
      if (!fresh.length || !target) return
      const box = document.createElement('div')
      box.className = 'turn-files'
      box.innerHTML = fresh.slice(0, 12).map((f) => `<span class="file-chip ${f.type === 'figure' && /\.(png|jpe?g|gif|webp|svg)$/i.test(f.path) ? 'thumb' : ''}" data-lib="${f.id}" data-path="${esc(f.path)}">${f.type === 'figure' && /\.(png|jpe?g|gif|webp|svg)$/i.test(f.path) ? `<img data-api-image="/api/library/${f.id}/file" alt="">` : icon('file', 14)}<span>${esc(f.path.split('/').pop())}</span></span>`).join('')
      box.onclick = (e) => { const c = e.target.closest('[data-lib]'); if (c) openFilePreviewModal(W.current, c.dataset.path, `/api/library/${c.dataset.lib}/file`) }
      target.el.appendChild(box)
      loadApiImages(box)
    } catch {}
  }
  function setBusy (b) {
    W.busy = b
    renderBar()
    fx.call('setState', b ? 'thinking' : 'idle')
  }
  function ensureLive () {
    if (W.live) return W.live
    const el = document.createElement('div')
    el.className = 'msg assistant'
    inner.appendChild(el)
    W.live = { el, text: '', raf: 0 }
    return W.live
  }
  // Chain of thought -> particles (P5): each kind of work has its own shape; evolution has its own motion.
  const LIT = /^(lit_|web_|pdf_)/
  const DATA = new Set(['run_python', 'run_skill', 'figure_check', 'forge_skill', 'start_process'])
  const WRITE = new Set(['manuscript_check', 'check_feedback', 'propose_rule'])
  const EVOLVE_TOOLS = new Set(['note_lesson', 'tune_harness', 'patch_skill', 'forge_skill', 'propose_rule'])
  function shapeFor (name, args) {
    if (LIT.test(name)) return 'constellation'
    if (DATA.has(name)) return 'curve'
    if (WRITE.has(name)) return 'stripes'
    const path = String(args?.path || '')
    if (/\.(tex|md|docx?|txt|bib|rtf)$/i.test(path)) return 'stripes'
    if (/\.(csv|tsv|xlsx?|json|npy|mat|png|pdf|svg|jpe?g)$/i.test(path)) return 'curve'
    return null
  }
  function particlesFor (e) {
    switch (e.type) {
      case 'reasoning': fx.call('setState', 'thinking'); break
      case 'text': fx.call('setState', 'thinking'); fx.call('setShape', 'ring'); break
      case 'tool-call': {
        fx.call('setState', 'tool')
        if (e.name === 'reflect') fx.call('pulse', 'reflect')
        else if (EVOLVE_TOOLS.has(e.name)) fx.call('pulse', 'evolve')
        const sh = shapeFor(e.name, e.arguments)
        if (sh) fx.call('setShape', sh)
        break
      }
      case 'tool-result': fx.call('setState', 'thinking'); break
      case 'approval': case 'choice': fx.call('setState', 'approval'); break
      case 'approval-resolved': case 'choice-resolved': fx.call('setState', 'thinking'); break
      case 'evolve':
        if (e.kind === 'reflect') fx.call('pulse', 'reflect')
        else if (['recall', 'adjust', 'learned', 'preference', 'credit'].includes(e.kind)) fx.call('pulse', 'evolve')
        else if (e.kind === 'selfcheck') fx.call('setState', 'thinking')
        break
      case 'done': fx.call('setShape', 'ring'); fx.call('setState', 'idle'); fx.call('pulse', 'deliver'); break
    }
  }
  function handle (e) {
    particlesFor(e)
    switch (e.type) {
      case 'hello': if (e.busy) setBusy(true); break
      case 'reasoning': {
        if (!W.think) { W.think = stepEl('think'); W.think.dataset.t0 = Date.now(); W.think.dataset.text = ''; inner.appendChild(W.think); W.live = null }
        W.think.dataset.text += e.text
        const t = W.think.dataset.text
        $('.det', W.think).textContent = t.replace(/\s+/g, ' ').slice(-90)
        $('.body', W.think).textContent = t
        break
      }
      case 'text': {
        if (W.think) { W.think.classList.add('done'); $('.ms', W.think).textContent = `${((Date.now() - Number(W.think.dataset.t0)) / 1000).toFixed(0)}s`; W.think = null }
        const l = ensureLive()
        l.text += e.text
        if (!l.raf) l.raf = requestAnimationFrame(() => { l.raf = 0; l.el.innerHTML = md(l.text) })
        break
      }
      case 'tool-call': {
        if (W.think) { W.think.classList.add('done'); W.think = null }
        W.live = null
        const d = stepEl('tool', e.name, e.arguments, e.id)
        W.calls.set(e.id, d)
        inner.appendChild(d)
        break
      }
      case 'tool-result': {
        const id = String(e.invocationId || '').split('/').pop()
        const d = W.calls.get(id) || [...inner.querySelectorAll('.step:not(.think):not(.done):not(.err)')][0]
        if (d) finishStep(d, e.preview, e.isError)
        break
      }
      case 'approval': {
        if ([...inner.querySelectorAll('[data-id]')].some((card) => card.dataset.id === e.id)) break
        const c = document.createElement('div')
        c.className = 'card-inline'
        c.dataset.id = e.id
        c.innerHTML = `<div class="head">${icon('shield', 15)}<span>需要你的确认 · ${e.kind === 'edit' ? '写文件' : '执行'} <code>${esc(e.tool)}</code></span></div><pre>${esc(e.summary)}</pre>
          <div class="acts">${e.kind === 'edit' ? '<button class="btn ghost small" data-a="edits" type="button">本会话自动接受编辑</button>' : ''}<button class="btn ghost small" data-a="deny" type="button">拒绝</button><button class="btn primary small" data-a="allow" type="button">允许</button></div>`
        c.onclick = async (ev) => {
          const a = ev.target.closest('[data-a]')?.dataset.a
          if (!a || c.classList.contains('done') || c.dataset.busy) return
          c.dataset.busy = '1'
          c.querySelectorAll('button').forEach((b) => { b.disabled = true })
          try {
            if (a === 'edits') { W.permission = 'acceptEdits'; renderBar(); await patch(`/api/sessions/${W.current}/settings`, { permission: 'acceptEdits' }) }
            await post(`/api/sessions/${W.current}/approve/${e.id}`, { allow: a !== 'deny' })
          } catch (err) {
            delete c.dataset.busy
            c.querySelectorAll('button').forEach((b) => { b.disabled = false })
            toast(err.message, 'err')
          }
        }
        inner.appendChild(c)
        break
      }
      case 'approval-resolved': {
        const c = inner.querySelector(`.card-inline[data-id="${e.id}"]`)
        if (c) { c.classList.add('done'); c.querySelectorAll('button').forEach((b) => { b.disabled = true }); $('.head span', c).textContent = e.allow ? '已允许' : '已拒绝' }
        fx.call('setState', 'thinking')
        break
      }
      case 'evolve': {
        // Tool-driven steps (reflect / note_lesson / tune_harness / recall-by-tool / offer_choices) already show as rows.
        if (['reflect', 'adjust', 'choice'].includes(e.kind) || (e.kind === 'recall' && /^主动检索/.test(e.text))) break
        if (W.live) W.answer = W.live
        W.live = null
        inner.appendChild(evoEl(e.kind, e.text, { refs: e.refs, items: e.data?.items }))
        break
      }
      case 'choice': {
        const c = document.createElement('div')
        c.className = 'card-inline choice'
        c.dataset.id = e.id
        c.innerHTML = `<div class="head">${icon('brain', 15)}<span>${esc(e.question)}</span></div><div class="opts">${e.options.map((o, i) => `<button type="button" class="opt" data-i="${i}"><b>${esc(o.label)}</b>${o.detail ? `<span>${esc(o.detail)}</span>` : ''}</button>`).join('')}</div>`
        c.onclick = async (ev) => {
          const b = ev.target.closest('[data-i]')
          if (!b || c.classList.contains('done') || c.dataset.busy) return
          c.dataset.busy = '1'
          b.classList.add('on')
          try { await post(`/api/sessions/${W.current}/choice/${e.id}`, { index: Number(b.dataset.i) }) }
          catch (err) { delete c.dataset.busy; b.classList.remove('on'); toast(err.message, 'err') }
        }
        inner.appendChild(c)
        break
      }
      case 'choice-resolved': {
        const c = inner.querySelector(`.card-inline[data-id="${e.id}"]`)
        if (c) { c.classList.add('done'); c.querySelectorAll('button').forEach((b) => { b.disabled = true }) }
        fx.call('setState', 'thinking')
        break
      }
      case 'compaction': if (e.status === 'started') banner('正在压缩上下文…'); else banner(''); break
      case 'warning': banner(e.message); break
      case 'error': inner.insertAdjacentHTML('beforeend', `<div class="error-line">${esc(readableError(e.message))}</div>`); break
      case 'status':
        if (e.status === 'running') setBusy(true)
        else if (e.status === 'cancelled' || e.status === 'blocked') inner.insertAdjacentHTML('beforeend', '<div class="stop-line">已停止</div>')
        break
      case 'done': {
        // Unanswered cards cannot be answered once the turn has ended.
        for (const c of inner.querySelectorAll('.card-inline:not(.done)')) {
          c.classList.add('done', 'expired')
          c.querySelectorAll('button').forEach((b) => { b.disabled = true })
        }
        if (W.think) { W.think.classList.add('done'); W.think = null }
        const ans = W.live || W.answer
        if (ans) { ans.el.innerHTML = md(ans.text); ans.el.appendChild(feedbackEl()) }
        W.answer = ans
        turnFiles().finally(() => { W.live = null; W.answer = null })
        setBusy(false)
        refresh()
        break
      }
    }
    if (thread.scrollHeight - thread.scrollTop - thread.clientHeight < 240) scroll()
  }
  function banner (text) { const b = $('#banner'); b.hidden = !text; b.innerHTML = esc(text || '') }
  function setFresh (on) { document.body.classList.toggle('fresh', on) }
  function renderHead () {
    const s = W.session
    if (!s) { $('#convHead').innerHTML = ''; return }
    const proj = (S().projects || []).find((p) => p.id === s.projectId)
    $('#convHead').innerHTML = `<div class="tt"><h2>${esc(s.title || s.id)}</h2><div class="meta" title="${esc(s.cwd)}">${esc(proj ? proj.name : '草稿')}</div></div>
      <button class="icon-btn" data-h="files" title="本会话的文件" type="button">${icon('library', 17)}</button>
      <button class="icon-btn" data-h="more" title="更多" type="button">${icon('more', 17)}</button>`
  }
  $('#convHead').addEventListener('click', async (e) => {
    const h = e.target.closest('[data-h]')?.dataset.h
    if (h === 'files') go('library', { session: W.current })
    if (h === 'more') {
      const sum = await api(`/api/sessions/${W.current}/summary`).catch(() => ({ reports: [] }))
      openPop(e.target.closest('[data-h]'), [
        ...sum.reports.slice(0, 5).map((r) => ({ label: `检查报告 · ${r.summary?.file || r.dir}`, desc: `错误 ${r.counts?.error ?? 0} · 提醒 ${r.counts?.warning ?? 0}`, icon: 'file', onPick: () => openReportReviewModal(W.current, r) })),
        { label: '重命名', icon: 'edit', onPick: async () => { const n = await promptDialog({ title: '重命名会话', defaultValue: W.session.title }); if (n) { await patch(`/api/sessions/${W.current}`, { title: n }); W.session.title = n; renderHead(); refresh() } } },
        { label: '新建分支会话', icon: 'link', onPick: async () => { const r = await post(`/api/sessions/${W.current}/fork`); await refresh(); W.open(r.id) } }
      ])
    }
  })

  // ------------------------------------------------------------ public
  W.home = () => {
    W.es?.close(); W.es = null
    W.current = null; W.session = null; W.live = null; W.think = null; W.calls.clear()
    document.body.classList.remove('in-session')
    resetChoices()
    banner('')
    $('#convHead').innerHTML = ''
    const hasModel = !!W.model
    inner.innerHTML = `<div class="greet"><h1>今天想研究什么？</h1>${hasModel ? '' : '<p style="margin-top:14px"><button class="btn primary" id="goSetup" type="button">接入模型</button></p>'}</div>`
    $('#goSetup')?.addEventListener('click', () => go('settings', 'models'))
    setFresh(true)
    renderBar(); renderTree(); syncFx()
    try { history.replaceState(null, '', location.pathname) } catch {}
    input.focus()
  }
  W.open = async (id, opts = {}) => {
    W.es?.close()
    W.current = id; W.live = null; W.think = null; W.calls.clear()
    document.body.classList.add('in-session')
    renderTree()
    const current = Symbol()
    W.opening = current
    const sync = async () => {
      const snapshot = await api(`/api/sessions/${id}`)
      if (W.current !== id || W.opening !== current) return false
      W.session = snapshot
      W.live = null; W.think = null; W.calls.clear()
      resetChoices()
      renderHead(); renderBar(); banner('')
      inner.innerHTML = ''
      const byTurn = new Map()
      for (const ev of W.session.evolve || []) {
        if (['reflect', 'adjust', 'choice'].includes(ev.kind) || (ev.kind === 'recall' && /^主动检索/.test(ev.text))) continue
        const k = ev.turn_id ?? 0
        if (!byTurn.has(k)) byTurn.set(k, [])
        byTurn.get(k).push(ev)
      }
      const turns = W.session.turns || []
      let ti = -1
      const flush = (tid, phase) => {
        for (const ev of (byTurn.get(tid) || []).filter((x) => (phase === 'start') === (x.kind === 'recall' || x.kind === 'observe' || (x.kind === 'preference' && /^记住了/.test(x.text))))) inner.appendChild(evoEl(ev.kind, ev.text, { refs: ev.refs, items: ev.data?.items }))
      }
      for (const m of W.session.messages) {
        if (m.role === 'user' && /^【自检】/.test(m.text)) continue
        if (m.role === 'user') { if (ti >= 0) flush(turns[ti], 'end'); ti++; renderStored(m); flush(turns[ti], 'start'); continue }
        renderStored(m)
      }
      if (ti >= 0) flush(turns[ti], 'end')
      const fresh = !W.session.messages.length && !opts.keepComposer
      if (fresh) inner.innerHTML = '<div class="greet"><h1>今天想研究什么？</h1></div>'
      setFresh(fresh)
      for (const a of W.session.pendingApprovals || []) handle({ type: 'approval', ...a })
      for (const choice of W.session.pendingChoices || []) handle({ type: 'choice', ...choice })
      setBusy(!!W.session.busy)
      scroll(); syncFx()
      return true
    }
    try { if (!await sync()) return }
    catch (err) { if (W.opening === current && W.current === id) { toast(err.message, 'err'); W.home() }; return }
    W.es = openEventStream(
      (signal) => apiFetch(`/api/sessions/${id}/events`, { signal, headers: { accept: 'text/event-stream' } }),
      { onEvent: (event) => { if (W.current === id && W.opening === current) handle(event) }, resync: sync }
    )
    try { history.replaceState(null, '', `?s=${id}`) } catch {}
  }
  document.addEventListener('evo:open-session', (e) => W.open(e.detail))
  renderTree()
  return W
}
