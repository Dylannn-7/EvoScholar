// Pages: plugins, library (资料空间), usage, trajectory.
import { go, store } from '../app.js'
import { ago, api, fmtSize, fmtTokens, patch, post } from './api.js'
import { icon } from './icons.js'
import { confirmDialog, esc, toast } from './modal.js'
import { openFilePreviewModal } from './review.js'

const shell = (root, title, desc, actions = '') => {
  root.innerHTML = `<div class="page glass dark"><div class="page-head"><h1>${title}</h1><div class="page-actions">${actions}</div>${desc ? `<div class="desc">${desc}</div>` : ''}</div><div class="page-body"></div></div>`
  return root.querySelector('.page-body')
}
const SOURCE = { builtin: ['内置', ''], evolved: ['进化产生', 'accent'], imported: ['导入', 'warn'] }
const srcBadge = (s) => { const [l, c] = SOURCE[s || 'builtin']; return `<span class="badge ${c}">${l}</span>` }

// ---------------------------------------------------------------- plugins
let pluginTab = 'skills'
export async function renderPlugins (root) {
  const body = shell(root, '插件', '技能、工具和规则包。内置的随项目发布；进化沉淀出的技能和工具会出现在这里，也支持导入外部技能（Anthropic Agent Skills 格式）。')
  const c = await api('/api/capabilities')
  const counts = { skills: c.skills.length, tools: c.tools.length, rules: c.writingRulepacks.length + c.figureRulepacks.length }
  const draw = () => {
    body.innerHTML = `<div class="toolbar"><div class="seg">${[['skills', '技能'], ['tools', '工具'], ['rules', '规则包']].map(([id, l]) => `<button type="button" class="${pluginTab === id ? 'on' : ''}" data-t="${id}">${l} ${counts[id]}</button>`).join('')}</div></div><div id="pl"></div>`
    body.querySelector('.seg').onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) { pluginTab = b.dataset.t; draw() } }
    const pl = body.querySelector('#pl')
    if (pluginTab === 'skills') {
      pl.innerHTML = `<div class="cards">${c.skills.map((s) => `<div class="pcard ${s.enabled ? '' : 'off'}"><div class="top">${icon('plugins', 16)}<span class="nm">${esc(s.name)}</span>${srcBadge(s.source)}</div>
        <div class="ds">${esc(s.description || '')}</div><div class="ft"><span>v${s.activeVersion ?? s.version}</span>${s.enabled ? '<span class="badge ok">已启用</span>' : '<span class="badge">未启用</span>'}</div></div>`).join('')}</div>`
    } else if (pluginTab === 'tools') {
      pl.innerHTML = `<div class="cards">${c.tools.map((t) => `<div class="pcard ${t.enabled ? '' : 'off'}"><div class="top">${icon('code', 16)}<span class="nm"><code>${esc(t.name)}</code></span>${srcBadge(t.source)}</div>
        <div class="ds">${esc(t.description)}</div><div class="ft">${t.enabled ? '<span class="badge ok">已启用</span>' : '<span class="badge">未启用</span>'}</div></div>`).join('')}</div>`
    } else {
      const fb = new Map((c.feedbackStats || []).map((s) => [s.rule, s]))
      pl.innerHTML = `<div class="section-t">写作规范</div><div class="cards">${c.writingRulepacks.map((r) => `<div class="pcard"><div class="top">${icon('file', 16)}<span class="nm">${esc(r.name)}</span>${r.status === 'verified' ? '<span class="badge ok">已核实</span>' : '<span class="badge warn">待完善</span>'}</div>
          <div class="ds">${esc(r.description || '')}</div><div class="ft"><code>${esc(r.id)}</code><span>${r.ruleCount} 条规则</span>${r.verifyCount ? `<span>${r.verifyCount} 条待人工核对</span>` : ''}${r.variants.length ? `<span>${r.variants.map((v) => esc(v.label)).join(' / ')}</span>` : ''}</div></div>`).join('')}</div>
        <div class="section-t">期刊出图</div><div class="cards">${c.figureRulepacks.map((r) => `<div class="pcard"><div class="top">${icon('image', 16)}<span class="nm">${esc(r.name)}</span></div>
          <div class="ds">${[r.widthMm?.single ? `单栏 ${r.widthMm.single} mm` : '', r.widthMm?.double ? `双栏 ${r.widthMm.double} mm` : '', r.fontPt?.min ? `字号 ${r.fontPt.min}–${r.fontPt.max ?? ''} pt` : '', r.rasterMinDpi ? `位图 ≥ ${r.rasterMinDpi} dpi` : '', r.formats?.length ? r.formats.join(' / ') : ''].filter(Boolean).join(' · ')}</div><div class="ft"><code>${esc(r.id)}</code></div></div>`).join('')}</div>
        ${fb.size ? `<div class="section-t">规则反馈（误报 / 有效）</div><div class="bars">${[...fb.values()].slice(0, 20).map((s) => `<div class="bar-row"><span class="l"><code>${esc(s.rule)}</code></span><span class="tr"><i class="c-out" style="width:${(100 * (s.valid || 0)) / Math.max(1, s.total || 1)}%"></i><i style="background:var(--danger);width:${(100 * (s.false_positive || 0)) / Math.max(1, s.total || 1)}%"></i></span><span class="n">${s.false_positive || 0} / ${s.valid || 0}</span></div>`).join('')}</div>` : ''}`
    }
  }
  draw()
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
          <div class="fi">${img ? `<img src="/api/library/${f.id}/file" loading="lazy" alt="">` : icon(f.type === 'data' ? 'data' : f.type === 'code' ? 'code' : f.type === 'figure' ? 'image' : 'file', 17)}</div>
          <div class="fn"><b>${esc(f.path.split('/').pop())}</b><span>${esc(f.path)}${f.exists ? '' : ' · 文件已移动或删除'}</span></div>
          <div class="src">${f.kind === 'upload' ? '上传 · ' : ''}${f.session_id ? `<a data-sess="${esc(f.session_id)}">${esc(f.session_title || f.session_id)}</a>` : ''}<span class="faint"> · ${esc(f.project_name || '草稿')}</span></div>
          <div class="sz">${fmtSize(f.size)}</div><div class="tm">${esc(ago(f.updated_at))}</div>
          <button class="icon-btn star ${f.deliverable ? 'on' : ''}" data-star="${f.id}" title="${f.deliverable ? '取消交付物标记' : '标为交付物'}" type="button">${icon('star', 16)}</button></div>`
      }).join('')}</div>` : '<div class="empty-state"><b>还没有文件</b>会话里生成的图、表、文稿和你上传的文件都会出现在这里。</div>'}`
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
export async function renderTrajectory (root) {
  const body = shell(root, '轨迹', '智能体在思考—行动循环里的自进化记录：回忆了哪些经验、因为什么反思、调整了什么，以及哪些 harness 改动在等你批准。')
  const evo = await api('/api/evolution')
  const pending = evo.candidates.filter((c) => c.status === 'pending')
  body.innerHTML = `
    <div class="section-t">待你批准</div>
    ${pending.length ? `<div class="timeline">${pending.map((c) => `<div class="tl-item"><i class="rail-dot"></i><div class="c">
        <div class="h"><code>${esc(c.genome_id)}</code><span class="badge warn">待批准</span><span class="faint">${esc(c.target || '')}</span><span class="page-actions"><button class="btn ghost small" data-rej="${esc(c.genome_id)}" type="button">拒绝</button><button class="btn primary small" data-pro="${esc(c.genome_id)}" type="button">批准上线</button></span></div>
        <p>${esc(c.change || c.diagnosis || '')}</p></div></div>`).join('')}</div>` : '<p class="muted">没有等待批准的改动。</p>'}
    <div class="section-t">回合中的自进化</div>
    <div class="empty-state" style="margin:20px auto"><b>循环内自进化即将接入</b>接入后，每个回合的回忆、反思、调整、自检会按时间排在这里，每条都能追溯到证据会话，并可以撤销。</div>
    <div class="section-t">harness 版本</div>
    <div class="timeline">${evo.lineage.slice().reverse().slice(0, 30).map((g) => `<div class="tl-item"><i class="rail-dot ${g.status === 'active' ? '' : 'dim'}"></i><div class="c">
      <div class="h"><code>${esc(g.id)}</code>${g.status === 'active' ? '<span class="badge ok">当前</span>' : `<span class="badge">${esc({ archived: '历史', rejected: '已拒绝', candidate: '候选' }[g.status] || g.status)}</span>`}<span class="faint">${esc(g.createdBy?.startsWith('evolution') ? '进化生成' : '手动')}</span>
      ${g.status === 'archived' ? `<span class="page-actions"><button class="btn ghost small" data-rb="${esc(g.id)}" type="button">回滚到此版本</button></span>` : ''}</div>
      <p>${esc(g.note || '')}</p></div></div>`).join('')}</div>`
  body.onclick = async (e) => {
    const b = e.target.closest('[data-pro],[data-rej],[data-rb]')
    if (!b) return
    try {
      if (b.dataset.pro) { if (!(await confirmDialog({ title: '批准上线', message: `把 ${b.dataset.pro} 设为当前 harness？可以随时回滚。`, confirmText: '批准' }))) return; await post(`/api/evolution/${b.dataset.pro}/promote`) }
      if (b.dataset.rej) await post(`/api/evolution/${b.dataset.rej}/reject`, {})
      if (b.dataset.rb) { if (!(await confirmDialog({ title: '回滚', message: `回滚到 ${b.dataset.rb}？`, confirmText: '回滚' }))) return; await post('/api/genome/rollback', { to: b.dataset.rb }) }
      await store.refresh(); toast('已更新', 'ok'); renderTrajectory(root)
    } catch (err) { toast(err.message, 'err') }
  }
}
