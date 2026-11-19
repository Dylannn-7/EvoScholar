// Pages: plugins, library (资料空间), usage, trajectory.
import { go, store } from '../app.js'
import { ago, api, del, fmtSize, fmtTokens, loadApiImages, patch, post, put } from './api.js'
import { icon } from './icons.js'
import { confirmDialog, esc, openModal, promptDialog, toast } from './modal.js'
import { openFilePreviewModal } from './review.js'

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
  const body = shell(root, '插件', '技能、工具、规则包和出图风格。进化沉淀出的可执行技能和规则会出现在这里；也可以导入外部技能（Anthropic Agent Skills 格式）。',
    '<button class="btn primary small" id="importSkill" type="button">导入技能</button>')
  root.querySelector('#importSkill').onclick = () => importDialog(root)
  const [c, ur, st] = await Promise.all([api('/api/capabilities'), api('/api/plugins/rules'), api('/api/styles').catch(() => ({ styles: [], current: null }))])
  const counts = { skills: c.skills.length, tools: c.tools.length, rules: c.writingRulepacks.length + c.figureRulepacks.length + ur.rules.length, styles: st.styles.length }
  const sw = (on, attr) => `<button class="switch ${on ? 'on' : ''}" ${attr} type="button" aria-label="${on ? '停用' : '启用'}"></button>`
  const draw = () => {
    body.innerHTML = `<div class="toolbar"><div class="seg">${[['skills', '技能'], ['tools', '工具'], ['rules', '规则包'], ['styles', '出图风格']].map(([id, l]) => `<button type="button" class="${pluginTab === id ? 'on' : ''}" data-t="${id}">${l} ${counts[id]}</button>`).join('')}</div></div><div id="pl"></div>`
    const pl = body.querySelector('#pl')
    if (pluginTab === 'skills') {
      pl.innerHTML = `<div class="cards">${c.skills.map((s) => `<div class="pcard ${s.enabled || s.kernel ? '' : 'off'}" data-skill="${esc(s.name)}"><div class="top">${icon(s.kernel ? 'code' : 'plugins', 16)}<span class="nm">${esc(s.name)}</span>${srcBadge(s.source)}${s.kernel ? `<span class="badge ${s.status === 'active' ? 'ok' : 'warn'}">${s.status === 'active' ? '已转正' : '试用'}</span>` : ''}</div>
        <div class="ds">${esc(s.description || '')}</div>
        <div class="ft"><span>v${s.activeVersion ?? s.version}</span>${s.kernel ? `<span>复用 ${s.reuses || 0} 次</span>` : ''}${s.license ? (/^https?:/.test(s.license) ? `<a class="muted" href="${esc(s.license)}" target="_blank" rel="noopener">许可证</a>` : `<span>${esc(s.license.replace(/ license$/i, ''))}</span>`) : ''}${s.origin && s.origin.startsWith('http') ? `<a class="muted" href="${esc(s.origin)}" target="_blank" rel="noopener">来源</a>` : ''}
          <span class="page-actions">${s.source !== 'builtin' ? `<button class="icon-btn" data-del="${esc(s.name)}" title="删除" type="button">${icon('trash', 14)}</button>` : ''}${s.kernel ? '<span class="faint">所有会话可用</span>' : sw(s.enabled, `data-en="${esc(s.name)}"`)}</span></div></div>`).join('')}</div>`
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
      pl.innerHTML = `<p class="muted" style="margin-top:-4px">风格决定图的外观，期刊规则包决定尺寸和字号；两者组合使用。设为默认后，新会话出图会优先用它（你在对话里另有要求时以对话为准）。</p>
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
      const en = e.target.closest('[data-en]')
      if (en) { await patch(`/api/plugins/skills/${en.dataset.en}`, { enabled: !en.classList.contains('on') }); await store.refresh(); toast('已更新，生成了新的 harness 版本', 'ok'); return renderPlugins(root) }
      const d = e.target.closest('[data-del]')
      if (d) { if (!(await confirmDialog({ title: '删除技能', message: `删除 ${d.dataset.del}？`, confirmText: '删除', danger: true }))) return; await del(`/api/plugins/skills/${d.dataset.del}`); return renderPlugins(root) }
      const rs = e.target.closest('[data-rs]')
      if (rs) { await patch(`/api/plugins/rules/${rs.closest('[data-rule]').dataset.rule}`, { status: rs.dataset.rs }); return renderPlugins(root) }
      const rd = e.target.closest('[data-rdel]')
      if (rd) { await del(`/api/plugins/rules/${rd.closest('[data-rule]').dataset.rule}`); return renderPlugins(root) }
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

function importDialog (root) {
  let mode = 'github'
  openModal({
    title: '导入技能',
    bodyHtml: `<p class="modal-msg">支持 Anthropic Agent Skills 格式：一个包含 SKILL.md（带 name、description 的 frontmatter）的文件夹，可附带 references/、scripts/、assets/。导入后默认启用；附带脚本只供智能体阅读，运行仍按权限模式确认。</p>
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
            : '<input class="input" id="imFolder" placeholder="技能文件夹的完整路径（里面有 SKILL.md）" spellcheck="false">'
      }
      el.querySelector('#im').onclick = (e) => { const b = e.target.closest('[data-m]'); if (b) { mode = b.dataset.m; drawBody() } }
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
const lib = { project: '', session: '', type: '', q: '', deliverable: false }
export async function renderLibrary (root, arg) {
  if (arg) Object.assign(lib, { project: arg.project || '', session: arg.session || '' })
  const body = shell(root, '资料空间', '所有会话产出的文件和你上传的文件。文件留在原处（项目文件夹或草稿目录），这里只建索引，方便随时找到交付物。')
  const S = store.state
  const draw = async () => {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(lib)) if (v) qs.set(k === 'deliverable' ? 'deliverable' : k, k === 'deliverable' ? '1' : v)
    const { files } = await api(`/api/library?${qs}`)
    const sessTitle = lib.session && (S.sessions.find((s) => s.id === lib.session)?.title || lib.session)
    body.innerHTML = `<div class="toolbar">
        <div class="search">${icon('search', 15)}<input class="input" id="lq" placeholder="搜索文件名" value="${esc(lib.q)}"></div>
        <div class="seg">${[['', '全部'], ['figure', '图'], ['document', '文档'], ['data', '数据'], ['code', '代码']].map(([id, l]) => `<button type="button" class="${lib.type === id ? 'on' : ''}" data-type="${id}">${l}</button>`).join('')}</div>
        <select class="input" id="lp"><option value="">全部项目</option>${S.projects.map((p) => `<option value="${esc(p.id)}" ${lib.project === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}<option value="drafts" ${lib.project === 'drafts' ? 'selected' : ''}>草稿</option></select>
        <button type="button" class="btn ${lib.deliverable ? 'primary' : 'ghost'} small" id="ld">${icon('star', 14)}只看交付物</button>
        ${lib.session ? `<button type="button" class="btn ghost small" id="lsx">会话：${esc(sessTitle)} ${icon('close', 12)}</button>` : ''}
      </div>
      ${files.length ? `<div class="flist">${files.map((f) => {
        const img = f.type === 'figure' && /\.(png|jpe?g|gif|webp|svg)$/i.test(f.path) && f.exists
        return `<div class="frow ${f.exists ? '' : 'missing'}" data-id="${f.id}" data-path="${esc(f.path)}" data-type="${f.type}" title="${esc(f.root)}/${esc(f.path)}">
          <div class="fi">${img ? `<img data-api-image="/api/library/${f.id}/file" loading="lazy" alt="">` : icon(f.type === 'data' ? 'data' : f.type === 'code' ? 'code' : f.type === 'figure' ? 'image' : 'file', 17)}</div>
          <div class="fn"><b>${esc(f.path.split('/').pop())}</b><span>${esc(f.path)}${f.exists ? '' : ' · 文件已移动或删除'}</span></div>
          <div class="src">${f.kind === 'upload' ? '上传 · ' : ''}${f.session_id ? `<a data-sess="${esc(f.session_id)}">${esc(f.session_title || f.session_id)}</a>` : ''}<span class="faint"> · ${esc(f.project_name || '草稿')}</span></div>
          <div class="sz">${fmtSize(f.size)}</div><div class="tm">${esc(ago(f.updated_at))}</div>
          <button class="icon-btn star ${f.deliverable ? 'on' : ''}" data-star="${f.id}" title="${f.deliverable ? '取消交付物标记' : '标为交付物'}" type="button">${icon('star', 16)}</button></div>`
      }).join('')}</div>` : '<div class="empty-state"><b>还没有文件</b>会话里生成的图、表、文稿和你上传的文件都会出现在这里。</div>'}`
    loadApiImages(root)
    let t
    body.querySelector('#lq').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { lib.q = e.target.value.trim(); draw() }, 250) }
    body.querySelector('.seg').onclick = (e) => { const b = e.target.closest('[data-type]'); if (b) { lib.type = b.dataset.type; draw() } }
    body.querySelector('#lp').onchange = (e) => { lib.project = e.target.value; draw() }
    body.querySelector('#ld').onclick = () => { lib.deliverable = !lib.deliverable; draw() }
    body.querySelector('#lsx')?.addEventListener('click', () => { lib.session = ''; draw() })
    body.querySelector('.flist')?.addEventListener('click', async (e) => {
      const star = e.target.closest('[data-star]')
      if (star) { e.stopPropagation(); await patch(`/api/library/${star.dataset.star}`, { deliverable: !star.classList.contains('on') }); return draw() }
      const s = e.target.closest('[data-sess]')
      if (s) { e.stopPropagation(); go('workbench'); return document.dispatchEvent(new CustomEvent('evo:open-session', { detail: s.dataset.sess })) }
      const row = e.target.closest('.frow')
      if (row && !row.classList.contains('missing')) openFilePreviewModal(null, row.dataset.path, `/api/library/${row.dataset.id}/file`)
    })
  }
  await draw()
}

// ---------------------------------------------------------------- usage
const use = { days: 30, group: 'model' }
export async function renderUsage (root) {
  const body = shell(root, '用量', '模型 token 用量统计。不统计费用：不同厂商、不同网关的价格各不相同，请以厂商账单为准。',
    `<div class="seg" id="ur">${[[7, '7 天'], [30, '30 天'], [90, '90 天'], [0, '全部']].map(([d, l]) => `<button type="button" class="${use.days === d ? 'on' : ''}" data-d="${d}">${l}</button>`).join('')}</div>`)
  root.querySelector('#ur').onclick = (e) => { const b = e.target.closest('[data-d]'); if (b) { use.days = Number(b.dataset.d); renderUsage(root) } }
  const q = (group) => api(`/api/usage?group=${group}&days=${use.days || ''}`)
  const [daily, grouped] = await Promise.all([q('day'), q(use.group)])
  const t = daily.totals
  const total = t.inputTokens + t.outputTokens
  body.innerHTML = `<div class="stats">
      ${[['总 tokens', fmtTokens(total)], ['输入', fmtTokens(t.inputTokens)], ['输出', fmtTokens(t.outputTokens)], ['缓存命中', `${(t.cacheHitRate * 100).toFixed(1)}%`], ['模型请求', fmtTokens(t.requests)], ['对话回合', fmtTokens(t.turns)], ['工具调用', `${fmtTokens(t.toolCalls)}${t.toolErrors ? ` <span class="faint" style="font-size:12px">失败 ${t.toolErrors}</span>` : ''}`]]
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
  const body = shell(root, '轨迹', '智能体在思考—行动循环里的自进化记录：回忆了哪些经验、因为什么反思、调整了什么、学到了什么。经验和偏好自动生效但随时可撤销；持久修改 harness 需要你批准。')
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
          <p>${esc(e.text)}</p></div></div>`).join('')}</div>` : '<div class="empty-state"><b>还没有自进化记录</b>开始一个会话后，回忆、反思、调整和学到的内容会按时间排在这里。</div>'
    } else if (trajTab === 'memory') {
      const list = ev.memory.filter((m) => memFilter === 'live' ? m.status !== 'retired' : m.status === memFilter)
      html += list.length ? `<div class="cards">${list.map((m) => { const [sl, sc] = STATUS[m.status]; return `<div class="pcard" data-mem="${esc(m.id)}">
          <div class="top">${m.status === 'active' && m.trust === 'trusted' ? `<input type="checkbox" data-pick="${esc(m.id)}" ${pick.has(m.id) ? 'checked' : ''} title="选入 genome 候选">` : ''}<code>${esc(m.id)}</code><span class="badge">${m.kind === 'lesson' ? '经验' : '偏好'}</span><span class="badge ${sc}">${sl}</span>${m.pinned ? '<span class="badge accent">置顶</span>' : ''}${m.trust === 'untrusted' ? '<span class="badge warn">来源含外部内容</span>' : ''}</div>
          <div class="ds" style="-webkit-line-clamp:5"><b style="color:#fff;font-weight:500">${esc(m.trigger)}</b> → ${esc(m.content)}</div>
          <div class="ft"><span>得分 ${score(m).toFixed(2)}</span><span>用过 ${m.uses} 次</span><span>${{ model: '模型提炼', user: '你给的', choice: '你的选择', edit: '你的修改', host: '系统' }[m.source] || ''}</span><span>${m.scope === 'project' ? '项目内' : m.scope === 'stage' ? `阶段 ${esc(m.stage || '')}` : '全局'}</span>
            <span class="page-actions"><button class="icon-btn" data-act="pin" title="${m.pinned ? '取消置顶' : '置顶（总是注入）'}" type="button">${icon('pin', 14)}</button><button class="icon-btn" data-act="edit" title="编辑" type="button">${icon('edit', 14)}</button>
            ${m.status === 'retired' ? `<button class="icon-btn" data-act="restore" title="恢复" type="button">${icon('refresh', 14)}</button>` : `<button class="icon-btn" data-act="retire" title="淘汰（不再注入）" type="button">${icon('archive', 14)}</button>`}<button class="icon-btn" data-act="del" title="删除" type="button">${icon('trash', 14)}</button></span></div></div>` }).join('')}</div>` : '<div class="empty-state"><b>这里还没有条目</b>会话中提炼的经验、你的选择和明确要求（例如「以后都用 Okabe-Ito 配色」）会出现在这里。</div>'
    } else if (trajTab === 'overlays') {
      html += ev.overlays.length ? `<div class="timeline">${ev.overlays.slice().reverse().map((o) => `<div class="tl-item"><i class="rail-dot ${o.status === 'reverted' ? 'dim' : ''}"></i><div class="c">
          <div class="h">${o.status === 'trial' || o.status === 'kept' ? `<input type="checkbox" data-pick="${esc(o.id)}" ${pick.has(o.id) ? 'checked' : ''} title="选入 genome 候选">` : ''}<code>${esc(o.id)}</code><span class="badge">${esc(o.op)}${o.target ? ` · ${esc(o.target)}` : ''}</span><span class="badge ${o.status === 'reverted' ? '' : o.status === 'kept' ? 'ok' : 'warn'}">${{ trial: '试用中', kept: '保留', reverted: '已撤销', promoted: '已沉淀' }[o.status] || esc(o.status)}</span>
          ${o.before_score !== null && o.after_score !== null ? `<span class="faint">回合得分 ${Number(o.before_score).toFixed(2)} → ${Number(o.after_score).toFixed(2)}</span>` : ''}<span class="page-actions">${sessLink(o.session_id)}${o.status === 'trial' || o.status === 'kept' ? `<button class="btn ghost small" data-rev="${esc(o.id)}" type="button">撤销</button>` : ''}</span></div>
          <p>${esc(o.value || '')}${o.reason ? `<br><span class="faint">原因：${esc(o.reason)}</span>` : ''}</p></div></div>`).join('')}</div>` : '<div class="empty-state"><b>还没有会话调整</b>智能体在会话里用 tune_harness 试用的工作方式调整会列在这里；表现好的调整之后可以沉淀为 genome 候选，经你批准上线。</div>'
    } else {
      html += `<div class="section-t">待你批准</div>${pending.length ? `<div class="timeline">${pending.map((c) => {
          const v = c.verification || {}
          const badge = v.verified
            ? `<span class="badge ok">已验证 ${esc(String(v.pass))}/${esc(String(v.total))}</span>`
            : '<span class="badge warn">未验证</span>'
          const evidenceLine = v.verified
            ? `验证运行：<code>${esc(v.runId || '')}</code> · 通过 ${esc(String(v.pass))}/${esc(String(v.total))}`
            : '验证证据：未验证（尚未关联离线回放或评测通过记录）'
          const scopeLine = `适用范围：${esc(v.scope || '全局 harness')}`
          return `<div class="tl-item"><i class="rail-dot"></i><div class="c">
          <div class="h"><code>${esc(c.genome_id)}</code><span class="badge warn">待批准</span>${badge}<span class="faint">${esc(c.target || '')}</span><span class="page-actions"><button class="btn ghost small" data-rej="${esc(c.genome_id)}" type="button">拒绝</button><button class="btn primary small" data-pro="${esc(c.genome_id)}" type="button">批准上线</button></span></div>
          <p>${esc(c.change || c.diagnosis || '')}</p>
          <p class="faint">${evidenceLine} · ${scopeLine}</p></div></div>`
        }).join('')}</div>` : '<p class="muted">没有等待批准的改动。</p>'}
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
      if (!(await confirmDialog({ title: '沉淀为 genome 候选', message: `把选中的 ${ids.length} 项写进一个新的 harness 版本候选？候选不会自动上线，需要你在「版本」里批准，可以随时回滚。`, confirmText: '生成候选' }))) return
      try {
        const r = await post('/api/evolve/consolidate', { overlayIds: ids.filter((x) => x.startsWith('O-')), memoryIds: ids.filter((x) => /^[LP]-/.test(x)) })
        pick.clear(); trajTab = 'versions'; await store.refresh(); toast(`已生成候选 ${r.genome}，请在「版本」里查看并批准`, 'ok', 6000); return renderTrajectory(root)
      } catch (err) { return toast(err.message, 'err') }
    }
    const t = e.target.closest('[data-t]'); if (t) { trajTab = t.dataset.t; return draw() }
    const mf = e.target.closest('[data-mf]'); if (mf) { memFilter = mf.dataset.mf; return draw() }
    const sl = e.target.closest('[data-sess]'); if (sl) { go('workbench'); return document.dispatchEvent(new CustomEvent('evo:open-session', { detail: sl.dataset.sess })) }
    try {
      if (e.target.closest('#addPref')) {
        const text = await promptDialog({ title: '添加偏好', message: '写一条你希望智能体以后都遵守的习惯，例如「出图用 Okabe-Ito 配色，坐标轴标签不加粗」。', multiline: true })
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
          if (!(await confirmDialog({ title: '批准上线', message: `把 ${b.dataset.pro} 设为当前 harness？（验证 ${v.pass}/${v.total}，适用范围：${v.scope}）。可以随时回滚。`, confirmText: '批准' }))) return
          await post(`/api/evolution/${b.dataset.pro}/promote`, {})
        } else {
          if (!(await confirmDialog({ title: '批准未验证候选', message: `候选 ${b.dataset.pro} 当前为「未验证」，尚未关联离线回放或评测记录（适用范围：${v?.scope || '全局 harness'}）。确定继续吗？`, confirmText: '继续确认', danger: true }))) return
          if (!(await confirmDialog({ title: '二次确认：上线未验证候选', message: `请再次确认将未验证候选 ${b.dataset.pro} 设为当前 harness。上线后如有异常可随时回滚。`, confirmText: '确认批准上线', danger: true }))) return
          await post(`/api/evolution/${b.dataset.pro}/promote`, { confirmUnverified: true })
        }
      }
      if (b.dataset.rej) await post(`/api/evolution/${b.dataset.rej}/reject`, {})
      if (b.dataset.rb) { if (!(await confirmDialog({ title: '回滚', message: `回滚到 ${b.dataset.rb}？`, confirmText: '回滚' }))) return; await post('/api/genome/rollback', { to: b.dataset.rb }) }
      await store.refresh(); toast('已更新', 'ok'); renderTrajectory(root)
    } catch (err) { toast(err.message, 'err') }
  }
}
