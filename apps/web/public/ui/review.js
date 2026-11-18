// Manuscript-check report review and in-app file preview (shared by session view and library).
import { md } from './markdown.js'
import { esc, openLightbox, openModal, toast } from './modal.js'
import { post } from './api.js'

export function openReportReviewModal(sessionId, report, onFeedbackSaved) {
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
    }
  })
}

// ============================================================ In-App File Preview Modal
export async function openFilePreviewModal(sessionId, filePath, directUrl) {
  const url = directUrl || `/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(filePath)}`
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
