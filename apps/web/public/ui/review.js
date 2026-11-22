// Manuscript-check report review and in-app file preview (shared by session view and library).
import { md } from './markdown.js'
import { esc, openModal, toast } from './modal.js'
import { apiFetch, post } from './api.js'

export function openReportReviewModal(sessionId, report, onFeedbackSaved, state = {}) {
  let sevFilter = state.sevFilter || 'all'
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
                      ${f.location ? `<button type="button" class="finding-location" data-location title="查看原文">${esc(f.loc)}</button>`
                        : `<span class="floc">${esc(f.loc)}</span>`}
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

        wrap.querySelectorAll('[data-location]').forEach((button) => {
          button.onclick = async () => {
            if (wrap.dataset.openingSource) return
            const id = button.closest('[data-fid]').dataset.fid
            const { path, page, line } = report.findings.find((f) => f.id === id).location
            const scrollTop = wrap.querySelector('.rep-list').scrollTop
            wrap.dataset.openingSource = '1'
            try {
              await openFilePreviewModal(sessionId, path, undefined, {
                page, line, isCurrent: () => wrap.isConnected,
                onBack: () => openReportReviewModal(sessionId, report, onFeedbackSaved, { sevFilter, scrollTop })
              })
            } finally { delete wrap.dataset.openingSource }
          }
        })

        wrap.querySelectorAll('.finding-btns button').forEach((b) => {
          b.onclick = async () => {
            const card = b.closest('.finding-card')
            const fid = card.dataset.fid
            const verdict = b.dataset.v
            try {
              await post(`/api/sessions/${sessionId}/check-feedback`, { reportDir: report.dir, ids: [fid], verdict })
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
      wrap.querySelector('.rep-list').scrollTop = state.scrollTop || 0
    }
  })
}

// ============================================================ In-App File Preview Modal
export async function openFilePreviewModal(sessionId, filePath, directUrl, { page = 1, line, isCurrent, onBack } = {}) {
  const url = directUrl || `/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(filePath)}`
  const name = filePath.split(/[\\/]/).pop()
  const pdf = /\.pdf$/i.test(filePath)
  const html = /\.html?$/i.test(filePath)
  const isolated = pdf || html || /\.svg$/i.test(filePath)
  const raster = /\.(png|jpe?g|gif|webp)$/i.test(filePath)
  const isText = /\.(md|txt|json|csv|tex|py|bib|yaml|yml|log|jsonl)$/i.test(filePath)
  const urls = []
  const objectURL = (blob) => {
    const object = URL.createObjectURL(blob)
    urls.push(object)
    return object
  }
  const dispose = () => urls.forEach((object) => URL.revokeObjectURL(object))
  try {
    const res = await apiFetch(url)
    if (!res.ok) throw new Error('无法读取文件预览')
    const blob = await res.blob()
    // Binary downloads use a non-executable MIME type even if opened in the workbench origin.
    const download = objectURL(blob.slice(0, blob.size, 'application/octet-stream'))
    const controls = `${onBack ? '<button class="btn ghost small" type="button" data-report-back>返回检查报告</button>' : ''}<a class="btn primary small" href="${esc(download)}" download="${esc(name)}">下载文件</a>`
    let content = ''
    if (isolated) {
      let preview
      if (pdf) {
        const response = await apiFetch(`${url}${url.includes('?') ? '&' : '?'}preview=page&page=${page}`)
        if (response.ok) preview = await response.blob()
        else content = `<p>无法渲染 PDF 第 ${page} 页，请打开原文件核对页码。</p>`
      } else if (html) {
        const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'">`
        preview = new Blob([policy, blob], { type: 'text/html' })
      } else preview = blob.slice(0, blob.size, 'image/svg+xml')
      if (preview) content = `<iframe title="${esc(pdf ? `PDF 第 ${page} 页` : name)}" sandbox="" referrerpolicy="no-referrer" src="${esc(objectURL(preview))}" style="width:100%;height:60vh;border:0;background:white"></iframe>`
    } else if (raster) {
      content = `<img alt="${esc(name)}" src="${esc(objectURL(blob))}" style="max-width:100%;max-height:65vh">`
    } else if (isText) {
      const raw = await blob.text()
      const preview = raw.length > 120_000 ? raw.slice(0, 120_000) + '\n\n…（预览已截断，请下载查看完整内容）' : raw
      if (line) {
        const lines = raw.split(/\r\n|\n|\r/)
        if (lines.at(-1) === '') lines.pop()
        if (line > lines.length) content = '<p>原文件已没有这一行，请重新检查稿件。</p>'
        else {
          const first = Math.max(1, line - 10)
          const context = lines.slice(first - 1, line + 10).map((text, i) => {
            const number = first + i
            const code = esc(text.length > 4000 ? text.slice(0, 4000) + '…' : text)
            return `<span class="source-line${number === line ? ' on' : ''}" ${number === line ? 'aria-current="true"' : ''}><span class="line-number">${number}</span>${code}</span>`
          }).join('')
          content = `<pre class="code-preview source-preview">${context}</pre>`
        }
      } else {
        content = /\.md$/i.test(filePath)
          ? `<div class="md-preview msg assistant">${md(preview)}</div>`
          : `<pre class="code-preview">${esc(preview)}</pre>`
      }
    }
    if (isCurrent && !isCurrent()) return dispose()
    const title = line ? `${filePath} · 第 ${line} 行` : pdf ? `${filePath} · 第 ${page} 页` : filePath
    openModal({
      title, wide: true, bodyHtml: `<div class="file-preview-bar">${controls}</div>${content}`, onClose: dispose,
      onMount: (modal) => {
        if (onBack) modal.querySelector('[data-report-back]').onclick = onBack
        modal.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'center' })
      }
    })
  } catch (error) {
    dispose()
    toast(error.message, 'err')
  }
}
