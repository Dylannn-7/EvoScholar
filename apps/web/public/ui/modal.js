// Lightweight modal, lightbox, confirm/prompt, and toast helpers (replaces native browser dialogs).
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export const yuan = (n) => '¥' + (n ?? 0).toFixed(n >= 10 ? 1 : n >= 1 ? 2 : 4)

let toastRoot = null
export function toast(message, kind = 'info', ms = 3200) {
  if (!toastRoot) toastRoot = document.getElementById('toastRoot')
  if (!toastRoot) return
  const el = document.createElement('div')
  el.className = `toast toast-${kind}`
  el.textContent = message
  toastRoot.appendChild(el)
  requestAnimationFrame(() => el.classList.add('show'))
  setTimeout(() => {
    el.classList.remove('show')
    setTimeout(() => el.remove(), 220)
  }, ms)
}

let activeClose = null
export function closeModal() {
  if (activeClose) activeClose()
}

export function openModal({ title = '', bodyHtml = '', wide = false, fullClass = '', onMount, onClose } = {}) {
  closeModal()
  const root = document.getElementById('modalRoot')
  if (!root) return () => {}
  const wrap = document.createElement('div')
  wrap.className = 'modal-backdrop'
  wrap.innerHTML = `
    <div class="modal ${wide ? 'modal-wide' : ''} ${fullClass}" role="dialog" aria-modal="true">
      ${title ? `<div class="modal-head"><h3>${esc(title)}</h3><button type="button" class="icon-btn modal-close" aria-label="关闭"><svg viewBox="0 0 12 12" width="12" height="12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></div>` : ''}
      <div class="modal-body">${bodyHtml}</div>
    </div>`
  const close = () => {
    document.removeEventListener('keydown', onKey)
    wrap.remove()
    if (activeClose === close) activeClose = null
    onClose?.()
  }
  const onKey = (e) => {
    if (e.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKey)
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) close()
  })
  wrap.querySelector('.modal-close')?.addEventListener('click', close)
  activeClose = close
  root.appendChild(wrap)
  onMount?.(wrap.querySelector('.modal'), close)
  return close
}

export function confirmDialog({ title, message, confirmText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (v) => {
      if (settled) return
      settled = true
      resolve(v)
    }
    openModal({
      title,
      bodyHtml: `<p class="modal-msg">${esc(message)}</p>
        <div class="modal-actions">
          <button type="button" class="btn ghost" data-act="cancel">${esc(cancelText)}</button>
          <button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-act="ok">${esc(confirmText)}</button>
        </div>`,
      onMount: (el, close) => {
        el.querySelector('[data-act="cancel"]').onclick = () => { finish(false); close() }
        el.querySelector('[data-act="ok"]').onclick = () => { finish(true); close() }
        el.querySelector('[data-act="ok"]').focus()
      },
      onClose: () => finish(false)
    })
  })
}

export function promptDialog({ title, message = '', label = '', placeholder = '', defaultValue = '', confirmText = '保存', multiline = false }) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (v) => {
      if (settled) return
      settled = true
      resolve(v)
    }
    const inputEl = multiline
      ? `<textarea class="field-input" rows="3" placeholder="${esc(placeholder)}">${esc(defaultValue)}</textarea>`
      : `<input class="field-input" type="text" value="${esc(defaultValue)}" placeholder="${esc(placeholder)}">`
    openModal({
      title,
      bodyHtml: `${message ? `<p class="modal-msg">${esc(message)}</p>` : ''}
        <form class="modal-form">
          ${label ? `<label class="field-label">${esc(label)}</label>` : ''}
          ${inputEl}
          <div class="modal-actions">
            <button type="button" class="btn ghost" data-act="cancel">取消</button>
            <button type="submit" class="btn primary">${esc(confirmText)}</button>
          </div>
        </form>`,
      onMount: (el, close) => {
        const inp = el.querySelector('.field-input')
        inp.focus()
        if (!multiline && inp.select) inp.select()
        el.querySelector('[data-act="cancel"]').onclick = () => { finish(null); close() }
        el.querySelector('.modal-form').onsubmit = (e) => {
          e.preventDefault()
          finish(inp.value)
          close()
        }
      },
      onClose: () => finish(null)
    })
  })
}

export function openLightbox({ src, title, downloadHref }) {
  openModal({
    fullClass: 'modal-lightbox',
    bodyHtml: `
      <div class="lightbox-bar">
        <span class="lightbox-title">${esc(title)}</span>
        <div class="lightbox-actions">
          ${downloadHref ? `<a class="btn ghost small" href="${esc(downloadHref)}" download>下载原图</a>` : ''}
          <button type="button" class="icon-btn modal-close" aria-label="关闭"><svg viewBox="0 0 12 12" width="12" height="12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
        </div>
      </div>
      <div class="lightbox-stage"><img src="${esc(src)}" alt="${esc(title)}"></div>`,
    onMount: (el, close) => {
      el.querySelector('.modal-close').onclick = close
    }
  })
}
