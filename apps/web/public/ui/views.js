import { md } from './markdown.js'
import { renderLineage, VERSION_STATUS, versionStatus } from './lineage.js'
import { confirmDialog, esc, openLightbox, openModal, promptDialog, toast, yuan } from './modal.js'

const STATUS = { evaluating: '评测中', pending: '待审批', approved: '已上线', rejected: '已拒绝', discarded: '自动淘汰' }
const mark = (v) => (v === undefined || v === null ? '<span class="muted">—</span>' : v ? '<span class="ok">✓</span>' : '<span class="no">✗</span>')
const diffHtml = (lines) =>
  `<pre class="diff">${(lines || []).map((l) => `<span class="${l.op === '+' ? 'add' : l.op === '-' ? 'del' : 'ctx'}">${esc(l.op)} ${esc(l.text)}</span>`).join('\n')}</pre>`

// ============================================================ Evolution View
let evoSelected = null

export async function renderEvolutionView(root, ctx) {
  const r = await ctx.api('/api/evolution')
  if (ctx.getView() !== 'evolution') return
  const pendingCount = r.candidates.filter((c) => c.status === 'pending').length
  ctx.setPending(pendingCount)
  if (!r.lineage.some((node) => node.id === evoSelected)) {
    evoSelected = (r.candidates.find((c) => c.status === 'pending') || r.candidates[0])?.genome_id ?? r.active.id
  }

  root.innerHTML = `
    <div class="page-wrap">
      <div class="page-head">
        <div>
          <h2>自我进化实验室</h2>
          <p class="page-sub">当前上线 <code>${esc(r.active.id)}</code>${r.active.parent ? ` ← <code>${esc(r.active.parent)}</code>` : ''} · ${esc(r.benchmark)}</p>
        </div>
        <div class="page-actions">
          ${r.peak ? '<span class="pill warn-pill">DeepSeek 高峰时段 (2×)</span>' : '<span class="pill ok-pill">非高峰时段</span>'}
          ${r.active.parent ? '<button type="button" class="btn ghost" id="evoRollback">回滚到父版本</button>' : ''}
          <button type="button" class="btn primary" id="evoRun" ${r.running.active ? 'disabled' : ''}>${r.running.active ? '进化运行中…' : '跑一轮进化'}</button>
        </div>
      </div>

      ${r.active.note ? `<div class="info-banner">${esc(r.active.note)}</div>` : ''}
      ${r.running.log.length ? `<div class="section-card"><h3>本轮运行日志</h3><pre class="evo-log">${esc(r.running.log.join('\n'))}</pre></div>` : ''}

      <div class="evo-grid">
        <div class="section-card evo-cands">
          <h3>候选版本 (${r.candidates.length})</h3>
          ${
            r.candidates.length
              ? r.candidates
                  .map(
                    (c) => `
                <button type="button" class="cand-card ${evoSelected === c.genome_id ? 'on' : ''} ${c.status === 'pending' ? 'pending' : ''}" data-cand="${esc(c.genome_id)}">
                  <div class="cand-top">
                    <code>${esc(c.genome_id)}</code>
                    <span class="chip ${esc(c.status)}">${STATUS[c.status] || esc(c.status)}</span>
                    <span class="cand-cost">${yuan(c.cost_cny)}</span>
                  </div>
                  <div class="cand-target">${esc(c.target)}</div>
                  <div class="cand-scores">开发 ${c.base_dev_pass ?? '?'}→<b>${c.dev_pass ?? '?'}</b>/${c.dev_total ?? '?'}${c.acc_total ? ` · 验收 ${c.base_acc_pass}→<b>${c.acc_pass}</b>/${c.acc_total}` : ''}</div>
                  ${c.diagnosis ? `<div class="cand-diag">${esc(c.diagnosis)}</div>` : ''}
                </button>`
                  )
                  .join('')
              : '<p class="muted">暂无候选版本。点击右上角「跑一轮进化」启动一轮离线评测与反思。</p>'
          }
        </div>
        <div class="section-card evo-detail" id="evoDetail">
          <p class="muted">选择一个版本查看改动和评测结果。</p>
        </div>
      </div>

      <div class="two-col">
        <div class="section-card">
          <h3>Genome 谱系树</h3>
          <div class="lineage">${renderLineage(r.lineage, r.active.id, evoSelected)}</div>
        </div>
        <div class="section-card">
          <h3>最近进化轮次</h3>
          <div class="table-wrap">
            <table class="data-table">
              <tr><th>轮次 ID</th><th>基线</th><th>状态</th><th>花费</th></tr>
              ${r.runs.map((x) => `<tr><td><code>${esc(x.id)}</code></td><td><code>${esc(x.base_genome)}</code></td><td>${esc(x.status)}</td><td class="num">${yuan(x.cost_cny)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">暂无运行记录</td></tr>'}
            </table>
          </div>
        </div>
      </div>
    </div>`

  root.querySelector('#evoRun').onclick = async () => {
    let force = false
    if (r.peak) {
      const ok = await confirmDialog({
        title: '当前为 DeepSeek 高峰时段',
        message: '北京时间工作日 9:00–12:00 / 14:00–18:00 单价为非高峰的 2 倍。要忽略高峰与每日轮数限制强行运行吗？（取消则改为正常规则检查）',
        confirmText: '强制运行',
        cancelText: '按规则运行'
      })
      force = ok
    }
    try {
      await ctx.post('/api/evolution/run', { force })
      toast('已启动一轮进化，正在后台执行', 'ok')
      renderEvolutionView(root, ctx)
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  const rb = root.querySelector('#evoRollback')
  if (rb) {
    rb.onclick = async () => {
      const ok = await confirmDialog({
        title: '确认回滚 Genome',
        message: `将当前上线版本从 ${r.active.id} 回滚到 ${r.active.parent}？之后的新会话将使用旧版本。`,
        confirmText: '确认回滚',
        danger: true
      })
      if (!ok) return
      try {
        await ctx.post('/api/genome/rollback')
        toast(`已回滚至 ${r.active.parent}`, 'ok')
        await ctx.loadState()
        renderEvolutionView(root, ctx)
      } catch (e) {
        toast(e.message, 'err')
      }
    }
  }

  const selectables = [...root.querySelectorAll('[data-cand], [data-lineage]')]
  const versionId = (btn) => btn.dataset.cand ?? btn.dataset.lineage
  selectables.forEach((btn) => {
    btn.onclick = () => {
      evoSelected = versionId(btn)
      for (const item of selectables) {
        const selected = versionId(item) === evoSelected
        if (item.hasAttribute('data-lineage')) item.setAttribute('aria-pressed', String(selected))
        else item.classList.toggle('on', selected)
      }
      loadCandidateDetail(root.querySelector('#evoDetail'), evoSelected, root, ctx)
    }
  })

  if (evoSelected) {
    await loadCandidateDetail(root.querySelector('#evoDetail'), evoSelected, root, ctx)
  }

  if (r.running.active) {
    ctx.setEvoTimer(() => {
      if (ctx.getView() === 'evolution') renderEvolutionView(root, ctx)
    }, 3000)
  }
}

async function loadCandidateDetail(box, id, root, ctx) {
  if (!box) return
  box.innerHTML = '<p class="muted">加载详情中…</p>'
  let d
  try {
    d = await ctx.api(`/api/evolution/${encodeURIComponent(id)}`)
  } catch (error) {
    if (id === evoSelected) box.textContent = error.message
    return
  }
  if (id !== evoSelected || ctx.getView() !== 'evolution' || !box.isConnected) return
  const c = d.candidate || {}
  const status = versionStatus(d.genome, c.status)
  const changes = d.cases.filter((x) => x.base !== x.cand)
  box.innerHTML = `
    <div class="cand-detail-head">
      <div>
        <h3>${esc(id)} · <span class="chip ${esc(status)}">${esc(VERSION_STATUS[status] || status)}</span></h3>
        ${d.genome.note ? `<p class="page-sub">${esc(d.genome.note)}</p>` : ''}
        ${c.reason ? `<p class="page-sub">${esc(c.reason)}</p>` : ''}
      </div>
      ${
        c.status === 'pending'
          ? `<div class="page-actions"><button type="button" class="btn ghost" data-act="reject">拒绝</button><button type="button" class="btn primary" data-act="promote">批准上线</button></div>`
          : ''
      }
    </div>
    ${d.promptDiffs.map((p) => `<h4 class="sub-h">${esc(p.key)} <span class="muted">${esc(p.from || '（默认描述）')} → ${esc(p.to)}</span></h4>${diffHtml(p.diff)}`).join('')}
    ${(d.skillDiffs || []).map((s) => `<h4 class="sub-h">技能 ${esc(s.key)} <span class="muted">${esc(s.from || '新增')} → ${esc(s.to || '移除')}</span></h4>${diffHtml(s.diff)}`).join('')}
    ${d.workflowDiff?.some((line) => line.op !== ' ') ? `<h4 class="sub-h">工作流</h4>${diffHtml(d.workflowDiff)}` : ''}
    <h4 class="sub-h">逐题变化 <span class="muted">${changes.length ? `${changes.length} 题有变化` : '无变化'}</span></h4>
    <div class="table-wrap">
      <table class="data-table">
        <tr><th>任务</th><th>集</th><th>父版本</th><th>候选</th><th>花费</th></tr>
        ${d.cases
          .map(
            (x) =>
              `<tr class="${x.base !== x.cand ? (x.cand ? 'row-fix' : 'row-reg') : ''}" title="${esc((x.failures || []).join('\n'))}">
                <td><code>${esc(x.caseId)}</code></td>
                <td class="muted">${x.split === 'acceptance' ? '验收' : '开发'}</td>
                <td>${mark(x.base)}</td>
                <td>${mark(x.cand)}</td>
                <td class="num muted">${x.candCost !== undefined ? yuan(x.candCost) : ''}</td>
              </tr>`
          )
          .join('')}
      </table>
    </div>
    <details class="yaml-details"><summary>Genome YAML Diff</summary>${diffHtml(d.genomeDiff)}</details>`

  box.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = async () => {
      try {
        if (b.dataset.act === 'promote') {
          const ok = await confirmDialog({
            title: `批准上线 ${id}`,
            message: `上线后，新创建的科研会话将使用 ${id}；如遇问题可随时在实验室里一键回滚。`,
            confirmText: '批准上线'
          })
          if (!ok) return
          await ctx.post(`/api/evolution/${id}/promote`)
          ctx.fx.reform()
          toast(`${id} 已上线`, 'ok')
        } else {
          const reason = await promptDialog({
            title: `拒绝候选 ${id}`,
            label: '拒绝原因（可选，会记录到进化谱系供下次反思参考）',
            placeholder: '例如：只在样本题通过，通用性不足…',
            confirmText: '确认拒绝'
          })
          if (reason === null) return
          await ctx.post(`/api/evolution/${id}/reject`, { reason })
          toast(`已拒绝 ${id}`, 'info')
        }
        await ctx.loadState()
        renderEvolutionView(root, ctx)
      } catch (e) {
        toast(e.message, 'err')
      }
    }
  })
}

// ============================================================ Capabilities View (Skills & Rulepacks)
let capTab = 'skills'
let capQuery = ''

export async function renderCapabilitiesView(root, ctx) {
  const data = await ctx.api('/api/capabilities')
  if (ctx.getView() !== 'capabilities') return

  const q = capQuery.trim().toLowerCase()
  const match = (...parts) => !q || parts.some((p) => String(p || '').toLowerCase().includes(q))

  const skills = data.skills.filter((s) => match(s.name, s.description))
  const figPacks = data.figureRulepacks.filter((f) => match(f.id, f.name, f.notes))
  const writePacks = data.writingRulepacks.filter((w) => match(w.id, w.name, w.description))

  root.innerHTML = `
    <div class="page-wrap">
      <div class="page-head">
        <div>
          <h2>技能与规则库</h2>
          <p class="page-sub">激活 Genome <code>${esc(data.genome.id)}</code> · 已启用 ${data.skills.filter((s) => s.enabled).length} 项技能 · ${data.genome.tools.length} 个工具 · ${data.figureRulepacks.length} 套出图规范 · ${data.writingRulepacks.length} 套写作规则</p>
        </div>
        <div class="page-actions">
          <input type="search" class="search-input" id="capSearch" placeholder="搜索技能或规则包…" value="${esc(capQuery)}">
        </div>
      </div>

      <div class="seg-tabs" id="capTabs">
        <button type="button" class="${capTab === 'skills' ? 'on' : ''}" data-tab="skills">科研技能 (${data.skills.length})</button>
        <button type="button" class="${capTab === 'figures' ? 'on' : ''}" data-tab="figures">出图规则包 (${data.figureRulepacks.length})</button>
        <button type="button" class="${capTab === 'writing' ? 'on' : ''}" data-tab="writing">写作规则包 (${data.writingRulepacks.length})</button>
        <button type="button" class="${capTab === 'stats' ? 'on' : ''}" data-tab="stats">工具与误报统计</button>
      </div>

      <div id="capBody"></div>
    </div>`

  const body = root.querySelector('#capBody')
  if (capTab === 'skills') {
    body.innerHTML = `<div class="cap-grid">${
      skills
        .map(
          (s) => `<div class="cap-card ${s.enabled ? '' : 'dimmed'}">
          <div class="cap-card-h"><code>${esc(s.name)}</code><span class="chip ${s.enabled ? 'active' : ''}">${s.enabled ? `v${s.activeVersion ?? s.version} 已启用` : '未启用'}</span></div>
          <p>${esc(s.description || '无描述')}</p>
        </div>`
        )
        .join('') || '<p class="muted">没有匹配的技能。</p>'
    }</div>`
  } else if (capTab === 'figures') {
    body.innerHTML = `<div class="cap-grid">${
      figPacks
        .map(
          (f) => `<div class="cap-card">
          <div class="cap-card-h"><b>${esc(f.name)}</b><code>${esc(f.id)}</code></div>
          <div class="kv-mini">
            ${f.widthMm?.single || f.widthMm?.double ? `<span>栏宽：${f.widthMm?.single ?? '—'} / ${f.widthMm?.double ?? '—'} mm</span>` : ''}
            ${f.fontPt?.min || f.fontPt?.max ? `<span>字号：${f.fontPt?.min ?? '—'}–${f.fontPt?.max ?? '—'} pt</span>` : ''}
            ${f.rasterMinDpi ? `<span>位图 ≥ ${f.rasterMinDpi} dpi</span>` : ''}
            ${f.formats?.length ? `<span>推荐：${esc(f.formats.join(' / '))}</span>` : ''}
            ${f.colorblindSafe ? '<span>色盲友好检查</span>' : ''}
          </div>
          ${f.notes ? `<p>${esc(f.notes)}</p>` : ''}
        </div>`
        )
        .join('') || '<p class="muted">没有匹配的出图规则包。</p>'
    }</div>`
  } else if (capTab === 'writing') {
    body.innerHTML = `<div class="cap-grid">${
      writePacks
        .map(
          (w) => `<div class="cap-card ${w.status === 'stub' ? 'dimmed' : ''}">
          <div class="cap-card-h"><b>${esc(w.name)}</b><span class="chip ${w.status === 'verified' ? 'active' : ''}">${w.status === 'verified' ? `${w.ruleCount} 条规则` : '占位（通用检查）'}</span></div>
          <div class="kv-mini"><code>${esc(w.id)}</code>${w.variants.length ? `<span>变体：${esc(w.variants.map((v) => v.id).join(', '))}</span>` : ''}</div>
          ${w.description ? `<p>${esc(w.description)}</p>` : ''}
        </div>`
        )
        .join('') || '<p class="muted">没有匹配的写作规则包。</p>'
    }</div>`
  } else {
    body.innerHTML = `
      <div class="section-card">
        <h3>已启用工具 (${data.genome.tools.length})</h3>
        <div class="pill-list">${data.genome.tools.map((t) => `<code class="tool-pill">${esc(t)}</code>`).join('')}</div>
      </div>
      <div class="section-card">
        <h3>稿件规则反馈与误报率统计</h3>
        <p class="page-sub">来自各会话中对 <code>manuscript_check</code> 问题的「有效 / 误报」人工标注，用于持续优化写作检查规则。</p>
        <div class="table-wrap">
          <table class="data-table">
            <tr><th>规则 ID</th><th>规则包</th><th>有效</th><th>误报</th><th>不确定</th><th>误报率</th></tr>
            ${
              data.feedbackStats.length
                ? data.feedbackStats
                    .map(
                      (s) => `<tr>
                    <td><code>${esc(s.rule)}</code></td>
                    <td class="muted">${esc(s.pack || '—')}</td>
                    <td class="num ok">${s.valid}</td>
                    <td class="num no">${s.false_positive}</td>
                    <td class="num muted">${s.unsure}</td>
                    <td class="num">${s.fp_rate === null ? '—' : `${Math.round(s.fp_rate * 100)}%`}</td>
                  </tr>`
                    )
                    .join('')
                : '<tr><td colspan="6" class="muted">暂无规则反馈记录。在会话检查器里审阅稿件报告即可一键标「有效 / 误报」。</td></tr>'
            }
          </table>
        </div>
      </div>`
  }

  root.querySelector('#capTabs').onclick = (e) => {
    const b = e.target.closest('button[data-tab]')
    if (!b) return
    capTab = b.dataset.tab
    renderCapabilitiesView(root, ctx)
  }
  const inp = root.querySelector('#capSearch')
  inp.oninput = (e) => {
    capQuery = e.target.value
    renderCapabilitiesView(root, ctx)
  }
  if (q) {
    inp.focus()
    inp.setSelectionRange(inp.value.length, inp.value.length)
  }
}

// ============================================================ Ledger View
let ledgerFilter = 'all'

function fmtTok(n) {
  if (!n) return '0'
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return String(n)
}

export async function renderLedgerView(root, ctx) {
  const r = await ctx.api('/api/budget')
  if (ctx.getView() !== 'ledger') return
  const b = r.summary
  ctx.syncBudget(b)

  const pct = (val, max) => Math.min(100, (val / Math.max(0.01, max)) * 100)
  const barCls = (val, max) => (val >= max ? 'bad' : val >= max * 0.8 ? 'warn' : '')
  const catNames = { usage: '日常', evolution: '进化', dev: '开发', reserve: '预留' }
  const kindNames = { model: '模型', search: '联网搜索', fetch: '网页抓取', ocr: 'OCR' }

  const draw = () => {
    const rows = r.recent.filter((x) => ledgerFilter === 'all' || x.category === ledgerFilter)
    root.innerHTML = `
      <div class="page-wrap narrow">
        <div class="page-head">
          <div>
            <h2>用量与账本</h2>
            <p class="page-sub">按模型上游接口与配置汇率实时记录 Token 消耗与调用费用，日常对话不设预算与输出限制</p>
          </div>
          <div class="page-actions">
            ${r.peak ? '<span class="pill warn-pill">DeepSeek 高峰时段 · 2×</span>' : '<span class="pill ok-pill">非高峰标准计费</span>'}
          </div>
        </div>

        <div class="ledger-summary">
          <div class="ledger-hero-row">
            <div>
              <div class="ledger-total-label">累计花费</div>
              <div class="ledger-total">${yuan(b.totalCny)}</div>
            </div>
            <div class="ledger-substats">
              <div class="ls-item"><span class="ls-k">今日日常</span><span class="ls-v">${yuan(b.usageTodayCny)}</span></div>
              <div class="ls-item"><span class="ls-k">今日联网</span><span class="ls-v">${b.webCallsToday} 次</span></div>
              ${b.reservedCny > 0 ? `<div class="ls-item"><span class="ls-k">待结算</span><span class="ls-v">${yuan(b.reservedCny)}</span></div>` : ''}
            </div>
          </div>

          <div class="ledger-quotas">
            ${['usage', 'evolution', 'dev', 'reserve']
              .map(
                (k) => `
              <div class="quota-item">
                <div class="quota-top"><span>${esc(catNames[k] || k)}</span><span class="quota-val">${yuan(b.byCategory[k] || 0)}</span></div>
              </div>`
              )
              .join('')}
          </div>
        </div>

        <div class="ledger-list-head">
          <h3>最近流水 (${rows.length})</h3>
          <div class="seg-tabs compact" id="ledgerFilters">
            <button type="button" class="${ledgerFilter === 'all' ? 'on' : ''}" data-lf="all">全部</button>
            <button type="button" class="${ledgerFilter === 'usage' ? 'on' : ''}" data-lf="usage">日常</button>
            <button type="button" class="${ledgerFilter === 'evolution' ? 'on' : ''}" data-lf="evolution">进化</button>
            <button type="button" class="${ledgerFilter === 'dev' ? 'on' : ''}" data-lf="dev">开发</button>
          </div>
        </div>

        <div class="ledger-table-card">
          <table class="ledger-table">
            <tr><th>时间</th><th>调用</th><th>用量</th><th class="right">金额</th></tr>
            ${
              rows.length
                ? rows
                    .map((x) => {
                      const target = x.model ? x.model.split('/').pop() : kindNames[x.kind] || x.kind
                      let usageText = '1 次'
                      let usageTitle = ''
                      if (x.input_tokens) {
                        const hitRate = x.input_tokens > 0 ? Math.round((x.cache_read_tokens / x.input_tokens) * 100) : 0
                        usageText = `${fmtTok(x.input_tokens)} 入${hitRate ? ` (${hitRate}% 缓存)` : ''} · ${fmtTok(x.output_tokens)} 出`
                        usageTitle = `输入 ${x.input_tokens} / 缓存命中 ${x.cache_read_tokens} / 输出 ${x.output_tokens}`
                      }
                      return `<tr>
                        <td class="muted">${esc(x.ts.slice(5, 16).replace('T', ' '))}</td>
                        <td><span class="cat-tag">${esc(catNames[x.category] || x.category)}</span>${esc(target)}${x.peak ? '<span class="peak-tag">2×</span>' : ''}</td>
                        <td class="muted" title="${esc(usageTitle)}">${esc(usageText)}</td>
                        <td class="cost-cell">${yuan(x.cost_cny)}${x.estimated ? ' <span class="muted">估</span>' : ''}</td>
                      </tr>`
                    })
                    .join('')
                : '<tr><td colspan="4" class="muted">暂无记账记录。</td></tr>'
            }
          </table>
        </div>
      </div>`

    root.querySelector('#ledgerFilters').onclick = (e) => {
      const btn = e.target.closest('[data-lf]')
      if (!btn) return
      ledgerFilter = btn.dataset.lf
      draw()
    }
  }
  draw()
}

// ============================================================ Settings Dual-Column Modal (Claude + Codex style)
let settingsTab = 'general'

const TOOL_DESC = {
  bash: '在工作区执行 Python、LaTeX、数据处理等命令',
  read: '读取工作区文件及源码片段',
  write: '创建并写入研究产出文件',
  edit: '精确修改已有文档、脚本或配置',
  glob: '按文件名模式快速检索工作区文件',
  grep: '在工作区文本中正则搜索内容',
  web_search: '联网检索学术文献、官方文档与实时信息',
  web_fetch: '抓取指定网页或论文详情页正文',
  literature_search: '检索 Semantic Scholar / arXiv / OpenAlex / PubMed 文献',
  pdf_read: '提取学术论文 PDF 文本、章节结构与表格',
  render_figure: '生成符合目标期刊规范的出版级科研图表',
  manuscript_check: '按期刊或学位论文规则包核查稿件格式与引文'
}

const EFFORT_ZH = { none: '关闭', minimal: '极简', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' }
const fmtCtx = (n) => (!n ? '默认' : n >= 1000000 ? `${+(n / 1000000).toFixed(1)}M` : `${Math.round(n / 1000)}K`)

function openCustomGatewayModal(ctx, onDone) {
  openModal({
    title: '添加自定义网关',
    bodyHtml: `
      <p class="set-intro">接入任何兼容 OpenAI Chat Completions、Anthropic Messages 或 OpenAI Responses 协议的自建或第三方中转接口。</p>
      <form id="customGwForm">
        <div class="field"><label class="field-label">厂商标识（小写字母 / 数字 / -）</label><input class="field-input" name="id" placeholder="my-gateway" required></div>
        <div class="field"><label class="field-label">显示名称</label><input class="field-input" name="label" placeholder="我的实验室网关"></div>
        <div class="field"><label class="field-label">完整端点 URL</label><input class="field-input" name="endpoint" placeholder="https://example.com/v1/chat/completions" required></div>
        <div class="field"><label class="field-label">协议类型</label>
          <select class="field-input" name="protocol">
            <option value="chat-completions">Chat Completions（OpenAI 兼容）</option>
            <option value="messages">Messages（Anthropic 兼容）</option>
            <option value="responses">Responses</option>
          </select>
        </div>
        <div class="field"><label class="field-label">模型 ID（逗号或空格分隔）</label><input class="field-input" name="models" placeholder="model-a, model-b" required></div>
        <div class="field"><label class="field-label">API Key</label><input class="field-input" name="key" type="password" autocomplete="off"></div>
        <div class="modal-actions">
          <button type="button" class="btn ghost modal-cancel">取消</button>
          <button type="submit" class="btn primary">添加并保存</button>
        </div>
      </form>`,
    onMount: (el, close) => {
      el.querySelector('.modal-cancel').onclick = close
      el.querySelector('#customGwForm').onsubmit = async (e) => {
        e.preventDefault()
        const form = Object.fromEntries(new FormData(e.target))
        try {
          await ctx.post('/api/providers/custom', form)
          toast('已添加自定义网关', 'ok')
          await ctx.loadState()
          close()
          onDone?.(form.id)
        } catch (err) {
          toast(err.message, 'err')
        }
      }
    }
  })
}

export async function openSettingsModal(ctx, initialTab) {
  if (initialTab) {
    const map = { appearance: 'general', providers: 'models', roles: 'models', custom: 'models', limits: 'general' }
    settingsTab = map[initialTab] || initialTab
  }
  if (!['general', 'models', 'plugins', 'archived'].includes(settingsTab)) settingsTab = 'general'

  let modelSubTab = initialTab === 'roles' ? 'roles' : 'vendors'
  let modelQuery = ''
  let vendorDetailId = null
  let pluginSubTab = 'skills'
  let pluginQuery = ''
  let archivedQuery = ''
  let capsCache = null
  let archivedCache = null

  const state = await ctx.api('/api/state')
  ctx.setState(state)

  openModal({
    wide: true,
    fullClass: 'modal-settings',
    bodyHtml: `
      <div class="settings-shell">
        <aside class="settings-nav">
          <div class="settings-title">设置</div>
          <button type="button" data-stab="general">通用设置</button>
          <button type="button" data-stab="models">模型</button>
          <button type="button" data-stab="plugins">插件</button>
          <button type="button" data-stab="archived">已归档对话</button>
        </aside>
        <div class="settings-main">
          <div class="settings-head">
            <h3 id="settingsHeading"></h3>
            <button type="button" class="icon-btn modal-close" aria-label="关闭"><svg viewBox="0 0 12 12" width="12" height="12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
          </div>
          <div class="settings-body" id="settingsBody"></div>
        </div>
      </div>`,
    onMount: (el, close) => {
      el.querySelector('.modal-close').onclick = close
      const navBtns = el.querySelectorAll('[data-stab]')

      const restoreFocus = (id) => {
        const inp = el.querySelector(`#${id}`)
        if (inp) {
          inp.focus()
          inp.setSelectionRange(inp.value.length, inp.value.length)
        }
      }

      const renderTab = async () => {
        navBtns.forEach((b) => b.classList.toggle('on', b.dataset.stab === settingsTab))
        const body = el.querySelector('#settingsBody')
        const head = el.querySelector('#settingsHeading')
        const st = ctx.getState()

        if (settingsTab === 'general') {
          head.textContent = '通用设置'
          const prefs = ctx.getPrefs()
          body.innerHTML = `
            <p class="set-intro">配置界面外观、背景动效与长文阅读偏好。</p>
            <div class="set-group">
              <div class="set-row">
                <div><div class="set-k">粒子背景显示策略</div><div class="set-d">默认仅在首页与空会话展示粒子云，进入科研对话后自动切换为纯静谧深炭灰画布</div></div>
                <select class="set-ctrl" id="prefFxMode">
                  <option value="home" ${prefs.fxMode === 'home' ? 'selected' : ''}>仅首页显示 (推荐)</option>
                  <option value="ambient" ${prefs.fxMode === 'ambient' ? 'selected' : ''}>始终微弱背景</option>
                  <option value="off" ${prefs.fxMode === 'off' ? 'selected' : ''}>完全关闭</option>
                </select>
              </div>
              <div class="set-row">
                <div><div class="set-k">粒子渲染画质</div><div class="set-d">更改画质将刷新页面重建 WebGL 缓冲区</div></div>
                <select class="set-ctrl" id="prefFxQuality">
                  ${['auto', 'high', 'mid', 'low', 'off'].map((q) => `<option value="${q}" ${prefs.fxQuality === q ? 'selected' : ''}>${{ auto: '自动', high: '高 (262k 点)', mid: '中 (65k 点)', low: '低 (16k 点)', off: '关闭' }[q]}</option>`).join('')}
                </select>
              </div>
              <div class="set-row">
                <div><div class="set-k">对话栏正文宽度</div><div class="set-d">阅读长综述或宽表格时可切换为宽幅视图</div></div>
                <select class="set-ctrl" id="prefWidth">
                  <option value="standard" ${prefs.transcriptWidth === 'standard' ? 'selected' : ''}>标准 (740px)</option>
                  <option value="wide" ${prefs.transcriptWidth === 'wide' ? 'selected' : ''}>宽幅 (960px)</option>
                </select>
              </div>
              <div class="set-row">
                <div><div class="set-k">默认展开模型思考过程</div><div class="set-d">推理模型的内部思考过程默认收起或直接展开显示</div></div>
                <label class="switch"><input type="checkbox" id="prefReasoning" ${prefs.expandReasoning ? 'checked' : ''}><span></span></label>
              </div>
            </div>`
          body.querySelector('#prefFxMode').onchange = (e) => {
            ctx.updatePrefs({ fxMode: e.target.value })
            toast('已更新背景显示策略', 'ok')
          }
          body.querySelector('#prefFxQuality').onchange = (e) => {
            try { localStorage.setItem('evoscholar.fxQuality', e.target.value) } catch {}
            location.reload()
          }
          body.querySelector('#prefWidth').onchange = (e) => {
            ctx.updatePrefs({ transcriptWidth: e.target.value })
            toast('已调整对话栏宽度', 'ok')
          }
          body.querySelector('#prefReasoning').onchange = (e) => {
            ctx.updatePrefs({ expandReasoning: e.target.checked })
          }
          return
        }

        if (settingsTab === 'models') {
          head.textContent = '模型'
          const subTabsHtml = `
            <p class="set-intro">管理接入的模型厂商、API Key、自定义网关与任务角色分配；模型列表与上下文配置从上游接口动态获取，输出不做额外限额。</p>
            <div class="ul-tabs" id="modelSubTabs">
              <button type="button" class="${modelSubTab === 'vendors' ? 'on' : ''}" data-mtab="vendors">接入厂商</button>
              <button type="button" class="${modelSubTab === 'roles' ? 'on' : ''}" data-mtab="roles">角色分配</button>
            </div>`

          if (modelSubTab === 'vendors' && vendorDetailId) {
            const p = st.providers.find((x) => x.id === vendorDetailId)
            if (!p) {
              vendorDetailId = null
              return renderTab()
            }
            const effortHint = p.reasoningEffort?.supported ? `思考调节: ${p.reasoningEffort.values.map((v) => EFFORT_ZH[v] || v).join(' / ')}` : ''
            body.innerHTML = `
              ${subTabsHtml}
              <button type="button" class="back-link" id="vendorBack">← 返回厂商列表</button>
              <div class="vendor-hero">
                <div class="vendor-hero-title">
                  <h4>${esc(p.label)}</h4>
                  <span class="status-pill ${p.hasKey ? 'on' : 'off'}"><i></i>${p.hasKey ? '已接入' : '未配置'}</span>
                  <span class="muted" style="font-size:12px">${esc(p.protocols.join(' / '))}</span>
                </div>
                ${p.apiKeyUrl ? `<a class="link-quiet" href="${esc(p.apiKeyUrl)}" target="_blank" rel="noopener">获取 API Key ↗</a>` : ''}
              </div>
              <div class="set-group padded" style="margin-bottom:16px">
                <div class="field-label">API Key（环境变量 <code>${esc(p.apiKeyEnv)}</code>，仅保存至本机 <code>.env</code>）</div>
                <form class="prov-form" id="vendorKeyForm">
                  <input class="field-input" type="password" placeholder="${p.hasKey ? '已配置，输入新 Key 可覆盖保存' : `输入 ${p.apiKeyEnv}`}" autocomplete="off">
                  <button type="submit" class="btn primary">保存</button>
                </form>
              </div>
              <div class="set-sec-head">
                <span class="set-sec-title">模型列表 (${p.models.length})${effortHint ? ` · <span class="muted">${esc(effortHint)}</span>` : ''}</span>
                ${p.hasKey && p.modelsListUrl ? `<button type="button" class="btn ghost small" id="vendorRefreshBtn">↻ 从上游刷新</button>` : ''}
              </div>
              <div class="set-group">
                ${
                  p.models.length
                    ? p.models
                        .map(
                          (m) => `
                      <div class="model-list-row">
                        <code class="model-id-code">${esc(m.id)}</code>
                        <div class="model-meta-tags">
                          <span class="meta-chip">${fmtCtx(m.contextWindow)} 上下文</span>
                          ${m.maxOutputTokens ? `<span class="meta-chip">上游输出 ${fmtCtx(m.maxOutputTokens)}</span>` : '<span class="meta-chip">上游默认输出</span>'}
                          ${m.vision ? '<span class="meta-chip">视觉识图</span>' : ''}
                          ${m.reasoning ? '<span class="meta-chip">深度思考</span>' : ''}
                        </div>
                      </div>`
                        )
                        .join('')
                    : '<div class="set-row"><span class="muted">暂无可用模型，请配置 Key 后点击刷新。</span></div>'
                }
              </div>`

            body.querySelector('#modelSubTabs').onclick = (e) => {
              const b = e.target.closest('[data-mtab]')
              if (!b) return
              modelSubTab = b.dataset.mtab
              vendorDetailId = null
              renderTab()
            }
            body.querySelector('#vendorBack').onclick = () => {
              vendorDetailId = null
              renderTab()
            }
            body.querySelector('#vendorKeyForm').onsubmit = async (e) => {
              e.preventDefault()
              const key = e.target.querySelector('input').value
              try {
                await ctx.post('/api/keys', { provider: p.id, key })
                toast(`已保存 ${p.label} API Key`, 'ok')
                await ctx.loadState()
                renderTab()
              } catch (err) {
                toast(err.message, 'err')
              }
            }
            const refBtn = body.querySelector('#vendorRefreshBtn')
            if (refBtn) {
              refBtn.onclick = async () => {
                refBtn.disabled = true
                refBtn.textContent = '刷新中…'
                try {
                  const res = await ctx.post('/api/providers/refresh', { provider: p.id })
                  const info = res.results?.[p.id]
                  if (info?.error) toast(`刷新提示：${info.error}`, 'info')
                  else toast(`已更新 ${p.label}（${info?.count ?? 0} 个模型）`, 'ok')
                  await ctx.loadState()
                  renderTab()
                } catch (err) {
                  toast(err.message, 'err')
                  refBtn.disabled = false
                  refBtn.textContent = '↻ 从上游刷新'
                }
              }
            }
            return
          }

          if (modelSubTab === 'vendors') {
            const q = modelQuery.trim().toLowerCase()
            const filtered = st.providers.filter(
              (p) =>
                !q ||
                p.label.toLowerCase().includes(q) ||
                p.id.toLowerCase().includes(q) ||
                p.models.some((m) => m.id.toLowerCase().includes(q))
            )
            const connected = filtered.filter((p) => p.hasKey)
            const disconnected = filtered.filter((p) => !p.hasKey)
            const renderCard = (p) => `
              <button type="button" class="item-card" data-vendor="${esc(p.id)}">
                <div class="item-card-top">
                  <span class="item-card-name">${esc(p.label)}</span>
                  <span class="item-card-right">
                    <span class="status-pill ${p.hasKey ? 'on' : 'off'}"><i></i>${p.hasKey ? '已接入' : '未配置'}</span>
                    <span class="muted">›</span>
                  </span>
                </div>
                <div class="item-card-sub">${p.models.length} 个模型 · ${esc(p.protocols.join(' / '))}</div>
              </button>`

            body.innerHTML = `
              ${subTabsHtml}
              <div class="set-toolbar">
                <div class="set-search">
                  <svg viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.35"/><path d="M11 11l3 3" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>
                  <input id="vendorSearchInp" type="search" placeholder="搜索厂商或模型…" value="${esc(modelQuery)}">
                </div>
                <button type="button" class="btn ghost" id="refreshAllModelsBtn">↻ 刷新模型</button>
                <button type="button" class="btn ghost" id="addGatewayBtn">+ 自定义网关</button>
              </div>
              ${
                connected.length
                  ? `<div class="set-sec-head"><span class="set-sec-title">已接入厂商</span><span class="set-sec-meta">${connected.length} 个</span></div>
                     <div class="card-grid-2">${connected.map(renderCard).join('')}</div>`
                  : ''
              }
              ${
                disconnected.length
                  ? `<div class="set-sec-head"><span class="set-sec-title">未配置厂商</span><span class="set-sec-meta">${disconnected.length} 个</span></div>
                     <div class="card-grid-2">${disconnected.map(renderCard).join('')}</div>`
                  : ''
              }
              ${!filtered.length ? '<p class="muted">没有匹配的模型厂商。</p>' : ''}`

            body.querySelector('#modelSubTabs').onclick = (e) => {
              const b = e.target.closest('[data-mtab]')
              if (!b) return
              modelSubTab = b.dataset.mtab
              renderTab()
            }
            const sinp = body.querySelector('#vendorSearchInp')
            sinp.oninput = (e) => {
              modelQuery = e.target.value
              renderTab()
            }
            if (modelQuery) restoreFocus('vendorSearchInp')

            body.querySelectorAll('[data-vendor]').forEach((b) => {
              b.onclick = () => {
                vendorDetailId = b.dataset.vendor
                renderTab()
              }
            })
            body.querySelector('#addGatewayBtn').onclick = () => {
              openCustomGatewayModal(ctx, (newId) => {
                if (newId) vendorDetailId = newId
                renderTab()
              })
            }
            body.querySelector('#refreshAllModelsBtn').onclick = async () => {
              try {
                await ctx.post('/api/providers/refresh', {})
                toast('已刷新全部已接入厂商模型列表', 'ok')
                await ctx.loadState()
                renderTab()
              } catch (err) {
                toast(err.message, 'err')
              }
            }
            return
          }

          // modelSubTab === 'roles'
          const connected = st.providers.filter((p) => p.hasKey)
          const unconfigured = st.providers.filter((p) => !p.hasKey)
          const optHtml = (list, selectedRef, tag) =>
            list
              .map((p) =>
                p.models.length
                  ? `<optgroup label="${esc(p.label)}${tag}">${p.models
                      .map((m) => {
                        const ref = `${p.id}/${m.id}`
                        return `<option value="${esc(ref)}" ${selectedRef === ref ? 'selected' : ''}>${esc(m.id)}${m.vision ? ' · 视觉' : ''}</option>`
                      })
                      .join('')}</optgroup>`
                  : ''
              )
              .join('')
          const roleNames = {
            main: ['主力模型', '日常对话、代码执行与科研任务主调度'],
            fast: ['轻量模型', '文献初筛、快速分类与摘要'],
            vision: ['视觉模型', '图表检查预览与 PDF 扫描页识图'],
            reflector: ['进化·反思', '分析失败轨迹并生成改进方案'],
            judge: ['进化·评委', '离线评测对比与判分']
          }
          body.innerHTML = `
            ${subTabsHtml}
            <form id="rolesForm">
              <div class="set-group">
                ${Object.entries(roleNames)
                  .map(
                    ([k, [title, desc]]) => `
                  <div class="set-row">
                    <div><div class="set-k">${title}</div><div class="set-d">${desc}</div></div>
                    <select class="set-ctrl" name="${k}">
                      ${optHtml(connected, st.genome.roles[k], '（已接入）')}
                      ${optHtml(unconfigured, st.genome.roles[k], '（未配置）')}
                    </select>
                  </div>`
                  )
                  .join('')}
              </div>
              <div class="set-foot"><button type="submit" class="btn primary">保存角色分配</button></div>
            </form>`
          body.querySelector('#modelSubTabs').onclick = (e) => {
            const b = e.target.closest('[data-mtab]')
            if (!b) return
            modelSubTab = b.dataset.mtab
            renderTab()
          }
          body.querySelector('#rolesForm').onsubmit = async (e) => {
            e.preventDefault()
            const roles = Object.fromEntries(new FormData(e.target))
            try {
              const r = await ctx.post('/api/genome/roles', { roles })
              toast(`已更新角色分配 (${r.genome})`, 'ok')
              await ctx.loadState()
            } catch (err) {
              toast(err.message, 'err')
            }
          }
          return
        }

        if (settingsTab === 'plugins') {
          head.textContent = '插件'
          if (!capsCache) {
            body.innerHTML = '<p class="muted">正在加载插件清单…</p>'
            capsCache = await ctx.api('/api/capabilities')
            if (settingsTab !== 'plugins') return
          }
          const q = pluginQuery.trim().toLowerCase()
          const match = (...parts) => !q || parts.some((p) => String(p || '').toLowerCase().includes(q))
          const tabsHtml = `
            <p class="set-intro">查看当前科研工作区加载的技能包、运行时工具与期刊规则包。</p>
            <div class="ul-tabs" id="pluginSubTabs">
              <button type="button" class="${pluginSubTab === 'skills' ? 'on' : ''}" data-ptab="skills">技能 (${capsCache.skills.length})</button>
              <button type="button" class="${pluginSubTab === 'tools' ? 'on' : ''}" data-ptab="tools">工具 (${capsCache.genome.tools.length})</button>
              <button type="button" class="${pluginSubTab === 'packs' ? 'on' : ''}" data-ptab="packs">规则包 (${capsCache.writingRulepacks.length + capsCache.figureRulepacks.length})</button>
            </div>
            <div class="set-toolbar">
              <div class="set-search">
                <svg viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.35"/><path d="M11 11l3 3" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>
                <input id="pluginSearchInp" type="search" placeholder="搜索插件…" value="${esc(pluginQuery)}">
              </div>
            </div>`

          let listHtml = ''
          if (pluginSubTab === 'skills') {
            const list = capsCache.skills.filter((s) => match(s.name, s.description))
            listHtml = `
              <div class="set-sec-head"><span class="set-sec-title">工作区技能</span><span class="set-sec-meta">${list.length} 个</span></div>
              <div class="card-grid-2">
                ${
                  list.length
                    ? list
                        .map(
                          (s) => `
                      <div class="item-card">
                        <div class="item-card-top">
                          <span class="item-card-name">${esc(s.name)}</span>
                          <span class="status-pill ${s.enabled ? 'on' : 'off'}"><i></i>${s.enabled ? '已启用' : '已停用'}</span>
                        </div>
                        <div class="item-card-sub">v${s.activeVersion ?? s.version ?? 1}${s.description ? ` · ${esc(s.description)}` : ''}</div>
                      </div>`
                        )
                        .join('')
                    : '<p class="muted">没有匹配的技能。</p>'
                }
              </div>`
          } else if (pluginSubTab === 'tools') {
            const list = capsCache.genome.tools.filter((t) => match(t, TOOL_DESC[t]))
            listHtml = `
              <div class="set-sec-head"><span class="set-sec-title">全局工具</span><span class="set-sec-meta">系统与所有会话共用 · ${list.length} 个</span></div>
              <div class="card-grid-2">
                ${
                  list.length
                    ? list
                        .map(
                          (t) => `
                      <div class="item-card">
                        <div class="item-card-top">
                          <span class="item-card-name">${esc(t)}</span>
                          <span class="status-pill on"><i></i>已启用</span>
                        </div>
                        <div class="item-card-sub">${esc(TOOL_DESC[t] || '工作区内置工具')}</div>
                      </div>`
                        )
                        .join('')
                    : '<p class="muted">没有匹配的工具。</p>'
                }
              </div>`
          } else {
            const wList = capsCache.writingRulepacks.filter((w) => match(w.id, w.name, w.description))
            const fList = capsCache.figureRulepacks.filter((f) => match(f.id, f.name, f.notes))
            listHtml = `
              <div class="set-sec-head"><span class="set-sec-title">写作核查规则包</span><span class="set-sec-meta">${wList.length} 个</span></div>
              <div class="card-grid-2">
                ${
                  wList.length
                    ? wList
                        .map(
                          (w) => `
                      <div class="item-card">
                        <div class="item-card-top">
                          <span class="item-card-name">${esc(w.name)}</span>
                          <span class="status-pill ${w.status === 'verified' ? 'on' : 'off'}"><i></i>${w.status === 'verified' ? `${w.ruleCount} 条` : '通用'}</span>
                        </div>
                        <div class="item-card-sub">${esc(w.id)}${w.description ? ` · ${esc(w.description)}` : ''}</div>
                      </div>`
                        )
                        .join('')
                    : '<p class="muted">没有匹配的写作规则包。</p>'
                }
              </div>
              <div class="set-sec-head"><span class="set-sec-title">期刊出图规则包</span><span class="set-sec-meta">${fList.length} 个</span></div>
              <div class="card-grid-2">
                ${
                  fList.length
                    ? fList
                        .map(
                          (f) => `
                      <div class="item-card">
                        <div class="item-card-top">
                          <span class="item-card-name">${esc(f.name)}</span>
                          <span class="status-pill on"><i></i>已启用</span>
                        </div>
                        <div class="item-card-sub">${esc(f.id)}${f.rasterMinDpi ? ` · ≥${f.rasterMinDpi} dpi` : ''}${f.widthMm?.single ? ` · ${f.widthMm.single}/${f.widthMm.double}mm` : ''}</div>
                      </div>`
                        )
                        .join('')
                    : '<p class="muted">没有匹配的出图规则包。</p>'
                }
              </div>`
          }

          body.innerHTML = `${tabsHtml}${listHtml}`
          body.querySelector('#pluginSubTabs').onclick = (e) => {
            const b = e.target.closest('[data-ptab]')
            if (!b) return
            pluginSubTab = b.dataset.ptab
            renderTab()
          }
          const pinp = body.querySelector('#pluginSearchInp')
          pinp.oninput = (e) => {
            pluginQuery = e.target.value
            renderTab()
          }
          if (pluginQuery) restoreFocus('pluginSearchInp')
          return
        }

        // settingsTab === 'archived'
        head.textContent = '已归档对话'
        if (!archivedCache) {
          body.innerHTML = '<p class="muted">正在加载已归档对话…</p>'
          const data = await ctx.api('/api/sessions?archived=1')
          archivedCache = data.sessions || []
          if (settingsTab !== 'archived') return
        }
        const aq = archivedQuery.trim().toLowerCase()
        const rows = archivedCache.filter((s) => !aq || (s.title || s.id).toLowerCase().includes(aq))
        body.innerHTML = `
          <p class="set-intro">已归档的科研对话会从左侧栏隐藏，可随时恢复至会话列表或彻底删除。</p>
          <div class="set-toolbar">
            <div class="set-search">
              <svg viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.35"/><path d="M11 11l3 3" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>
              <input id="archSearchInp" type="search" placeholder="搜索已归档对话…" value="${esc(archivedQuery)}">
            </div>
          </div>
          <div class="set-group">
            ${
              rows.length
                ? rows
                    .map(
                      (s) => {
                        const ts = (s.last || s.created_at || '').slice(0, 16).replace('T', ' ')
                        const metaParts = [ts, `${s.turns ?? s.turn_count ?? 0} 轮`].filter(Boolean)
                        return `
                  <div class="arch-row" data-arch-id="${esc(s.id)}">
                    <div class="arch-info">
                      <div class="arch-title">${esc(s.title || '新对话')}</div>
                      <div class="arch-meta">${esc(metaParts.join(' · '))}</div>
                    </div>
                    <div class="arch-actions">
                      <button type="button" class="btn ghost small" data-unarchive="${esc(s.id)}">恢复</button>
                      <button type="button" class="btn ghost small" style="color:var(--danger)" data-arch-del="${esc(s.id)}">彻底删除</button>
                    </div>
                  </div>`
                      }
                    )
                    .join('')
                : `<div class="set-row"><span class="muted">${archivedCache.length ? '没有匹配的已归档对话。' : '暂无已归档对话。'}</span></div>`
            }
          </div>`

        const ainp = body.querySelector('#archSearchInp')
        ainp.oninput = (e) => {
          archivedQuery = e.target.value
          renderTab()
        }
        if (archivedQuery) restoreFocus('archSearchInp')

        body.querySelectorAll('[data-unarchive]').forEach((b) => {
          b.onclick = async () => {
            const sid = b.dataset.unarchive
            try {
              await ctx.patch(`/api/sessions/${encodeURIComponent(sid)}`, { archived: false })
              archivedCache = archivedCache.filter((x) => x.id !== sid)
              toast('已恢复至会话列表', 'ok')
              await ctx.loadSessions?.()
              renderTab()
            } catch (err) {
              toast(err.message, 'err')
            }
          }
        })
        body.querySelectorAll('[data-arch-del]').forEach((b) => {
          b.onclick = async () => {
            const sid = b.dataset.archDel
            const ok = await confirmDialog({
              title: '彻底删除对话',
              message: '确定要永久删除这条已归档对话及本地轨迹吗？删除后无法恢复。',
              confirmText: '彻底删除',
              danger: true
            })
            if (!ok) return
            try {
              await ctx.del(`/api/sessions/${encodeURIComponent(sid)}`)
              archivedCache = archivedCache.filter((x) => x.id !== sid)
              toast('已彻底删除', 'ok')
              await ctx.loadSessions?.()
              renderTab()
            } catch (err) {
              toast(err.message, 'err')
            }
          }
        })
      }

      navBtns.forEach((b) => {
        b.onclick = () => {
          settingsTab = b.dataset.stab
          vendorDetailId = null
          if (settingsTab === 'archived') archivedCache = null
          renderTab()
        }
      })
      renderTab()
    }
  })
}

// ============================================================ Manuscript Report Interactive Reviewer
export function openReportReviewModal(sessionId, report, onFeedbackSaved, ctx) {
  let sevFilter = 'all'
  const VERDICT_LABEL = { valid: '已标：有效', false_positive: '已标：误报', unsure: '已标：不确定' }

  openModal({
    title: `稿件检查报告 · ${report.summary?.file || report.dir}`,
    wide: true,
    bodyHtml: `<div id="repWrap"></div>`,
    onMount: (el) => {
      const wrap = el.querySelector('#repWrap')
      const draw = () => {
        const list = (report.findings || []).filter((f) => {
          if (sevFilter === 'unmarked') return !f.verdict
          return sevFilter === 'all' || f.severity === sevFilter
        })
        const c = report.counts || {}
        wrap.innerHTML = `
          <div class="rep-meta">
            <span>规则包：<code>${esc((report.summary?.packs || []).join(', '))}${report.summary?.variant ? ` (${report.summary.variant})` : ''}</code></span>
            <span>阶段：<code>${esc(report.summary?.stage || 'submission')}</code></span>
            <span class="sev-pill err">错误 ${c.error ?? 0}</span>
            <span class="sev-pill warn">提醒 ${c.warning ?? 0}</span>
            <span class="sev-pill info">提示 ${c.info ?? 0}</span>
          </div>
          <div class="seg-tabs small" id="repFilters">
            <button type="button" class="${sevFilter === 'all' ? 'on' : ''}" data-f="all">全部 (${report.findings.length})</button>
            <button type="button" class="${sevFilter === 'error' ? 'on' : ''}" data-f="error">错误 (${c.error ?? 0})</button>
            <button type="button" class="${sevFilter === 'warning' ? 'on' : ''}" data-f="warning">提醒 (${c.warning ?? 0})</button>
            <button type="button" class="${sevFilter === 'info' ? 'on' : ''}" data-f="info">提示 (${c.info ?? 0})</button>
            <button type="button" class="${sevFilter === 'unmarked' ? 'on' : ''}" data-f="unmarked">未标记</button>
          </div>
          <div class="rep-list">
            ${
              list.length
                ? list
                    .map(
                      (f) => `
                  <div class="finding-card" data-fid="${esc(f.id)}">
                    <div class="finding-top">
                      <code class="fid">${esc(f.id)}</code>
                      <span class="sev-pill ${f.severity === 'error' ? 'err' : f.severity === 'warning' ? 'warn' : 'info'}">${esc(f.severity)}</span>
                      <code class="frule">${esc(f.rule)}</code>
                      <span class="floc">${esc(f.loc)}</span>
                      ${f.verdict ? `<span class="verdict-tag v-${esc(f.verdict)}">${VERDICT_LABEL[f.verdict] || esc(f.verdict)}</span>` : ''}
                    </div>
                    <div class="finding-msg">${esc(f.message)}</div>
                    ${f.evidence ? `<pre class="finding-ev">${esc(f.evidence)}</pre>` : ''}
                    <div class="finding-foot">
                      <span class="muted">${esc(f.source || '')}</span>
                      <div class="finding-btns">
                        <button type="button" class="btn ghost small ${f.verdict === 'valid' ? 'on-ok' : ''}" data-v="valid">有效</button>
                        <button type="button" class="btn ghost small ${f.verdict === 'false_positive' ? 'on-bad' : ''}" data-v="false_positive">误报</button>
                        <button type="button" class="btn ghost small ${f.verdict === 'unsure' ? 'on-warn' : ''}" data-v="unsure">不确定</button>
                      </div>
                    </div>
                  </div>`
                    )
                    .join('')
                : '<p class="muted">当前筛选下没有问题条目。</p>'
            }
          </div>
          ${
            report.verify?.length
              ? `<details class="yaml-details"><summary>需人工核对提示 (${report.verify.length})</summary><ul class="verify-list">${report.verify.map((v) => `<li>${esc(v)}</li>`).join('')}</ul></details>`
              : ''
          }`

        wrap.querySelectorAll('#repFilters button').forEach((b) => {
          b.onclick = () => { sevFilter = b.dataset.f; draw() }
        })

        wrap.querySelectorAll('.finding-btns button').forEach((b) => {
          b.onclick = async () => {
            const card = b.closest('.finding-card')
            const fid = card.dataset.fid
            const verdict = b.dataset.v
            try {
              await ctx.post(`/api/sessions/${sessionId}/check-feedback`, { reportDir: report.dir, ids: [fid], verdict })
              const item = report.findings.find((x) => x.id === fid)
              if (item) item.verdict = verdict
              toast(`${fid} 已标为${verdict === 'valid' ? '有效' : verdict === 'false_positive' ? '误报' : '不确定'}`, 'ok')
              draw()
              onFeedbackSaved?.()
            } catch (err) {
              toast(err.message, 'err')
            }
          }
        })
      }
      draw()
    }
  })
}

// ============================================================ In-App File Preview Modal
export async function openFilePreviewModal(sessionId, filePath) {
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(filePath)}`
  if (/\.(png|jpe?g|svg|gif|webp)$/i.test(filePath)) {
    return openLightbox({ src: url, title: filePath, downloadHref: url })
  }
  const isText = /\.(md|txt|json|csv|tex|py|bib|yaml|yml|log|jsonl)$/i.test(filePath)
  if (!isText) {
    window.open(url, '_blank', 'noopener')
    return
  }
  const res = await fetch(url)
  if (!res.ok) return toast('无法读取文件预览', 'err')
  const raw = await res.text()
  const preview = raw.length > 120_000 ? raw.slice(0, 120_000) + '\n\n…（文件过大，预览已截断，请下载查看完整内容）' : raw
  const isMd = /\.md$/i.test(filePath)

  openModal({
    title: filePath,
    wide: true,
    bodyHtml: `
      <div class="file-preview-bar">
        <span class="muted">${(raw.length / 1024).toFixed(1)} KB</span>
        <div class="page-actions">
          <button type="button" class="btn ghost small" id="copyFileBtn">复制内容</button>
          <a class="btn primary small" href="${esc(url)}" download>下载文件</a>
        </div>
      </div>
      ${isMd ? `<div class="md-preview msg assistant">${md(preview)}</div>` : `<pre class="code-preview">${esc(preview)}</pre>`}`,
    onMount: (el) => {
      el.querySelector('#copyFileBtn').onclick = async () => {
        await navigator.clipboard.writeText(raw)
        toast('已复制到剪贴板', 'ok')
      }
    }
  })
}
