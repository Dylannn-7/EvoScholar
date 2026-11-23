import { api } from './api.js'
import { icon } from './icons.js'
import { esc, openModal, toast } from './modal.js'

const labels = { trigger: '原始报错', version: '版本与审批', result: '执行记录' }

export async function loadSpectralExample () {
  try {
    const response = await fetch('/examples/spectral-operator-evidence.json')
    return response.ok ? await response.json() : null
  } catch { return null }
}

export function operatorCard ({ id, title, badge, summaries, sample = false }) {
  const steps = Object.entries(labels).map(([section, label]) => `
    <button type="button" class="fs operator-step" aria-haspopup="dialog"
      data-operator-id="${esc(id)}" data-operator-section="${section}">
      <span class="fl">${sample && section === 'result' ? '留出验收' : label}</span>
      <span class="operator-summary">${esc(summaries[section])}</span>
    </button>`)
  return `<article class="flow fc-harness operator-card">
    <div class="flow-h"><span class="badge">${esc(badge)}</span><strong>${esc(title)}</strong></div>
    <div class="flow-row">${steps.join(`<span class="fa" aria-hidden="true">${icon('chevron', 14)}</span>`)}</div>
  </article>`
}

export async function openOperatorRecord (button, example, openSession) {
  const section = button.dataset.operatorSection
  if (!Object.hasOwn(labels, section)) return
  const id = button.dataset.operatorId
  const sample = id === 'spectral-example'
  try {
    const evidence = sample ? example?.records : await api(`/api/evolve/operators/${encodeURIComponent(id)}`)
    const records = evidence?.[section] || []
    const heading = sample && section === 'result' ? '留出验收' : labels[section]
    const empty = section === 'trigger' ? '这次锻造没有关联本回合的工具报错。' : '这个版本还没有执行记录。'
    openModal({
      title: heading, wide: true,
      bodyHtml: records.length ? `<div class="operator-records">${records.map((record, i) => {
        const ts = record.ts || (sample ? example?.recordedAt : undefined)
        return `
        <details class="operator-record"${i === 0 ? ' open' : ''}>
          <summary>${esc(record.label)}</summary>
          <div class="operator-record-meta">
            <code>${esc(record.id)}</code>
            ${ts ? `<time datetime="${esc(ts)}">${esc(new Date(ts).toLocaleString())}</time>` : ''}
            ${record.session ? `<button type="button" class="btn ghost small" data-operator-session="${esc(record.session)}">打开原会话</button>` : ''}
          </div>
          ${record.text ? `<pre class="skd-code">${esc(record.text)}</pre>` : ''}
          ${record.data ? `<pre class="skd-code">${esc(JSON.stringify(record.data, null, 2))}</pre>` : ''}
        </details>`
      }).join('')}</div>` : `<p class="modal-msg">${esc(empty)}</p>`,
      onMount: (el, close) => {
        el.querySelector('summary, .modal-close')?.focus()
        el.addEventListener('click', (event) => {
          const link = event.target.closest('[data-operator-session]')
          if (link) { close(); openSession(link.dataset.operatorSession) }
        })
      },
      onClose: () => { if (button.isConnected) button.focus() }
    })
  } catch (err) { toast(err.message, 'err') }
}
