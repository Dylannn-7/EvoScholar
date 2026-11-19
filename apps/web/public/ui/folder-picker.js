// Folder picker backed by /api/fs/dirs. Resolves with the chosen absolute path, or null.
import { api } from './api.js'
import { icon } from './icons.js'
import { esc, openModal, toast } from './modal.js'

export function chooseFolder ({ title = '选择文件夹', confirmText = '选择这个文件夹', start = null } = {}) {
  return new Promise((resolve) => {
    let cur = null
    let picked = null
    openModal({
      title,
      wide: true,
      bodyHtml: `
        <div class="inline" style="margin:12px 0"><input class="input" id="fpPath" placeholder="文件夹路径" spellcheck="false"><button class="btn ghost small" id="fpGo" type="button">前往</button></div>
        <div id="fpRoots" class="seg-tabs"></div>
        <div id="fpList" style="max-height:46vh;overflow:auto;border-radius:12px;background:rgba(0,0,0,.25);padding:4px"></div>
        <div class="modal-actions"><span class="muted" id="fpSel" style="margin-right:auto;font-size:12px"></span><button class="btn ghost" data-x type="button">取消</button><button class="btn primary" id="fpOk" type="button">${esc(confirmText)}</button></div>`,
      onClose: () => resolve(picked),
      onMount: (el, close) => {
        const load = async (path) => {
          try {
            const r = await api(`/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`)
            cur = r.path
            el.querySelector('#fpPath').value = r.path
            el.querySelector('#fpSel').textContent = r.path
            el.querySelector('#fpRoots').innerHTML = r.roots.map((x) => `<button type="button" data-d="${esc(x)}">${esc(x)}</button>`).join('')
            el.querySelector('#fpList').innerHTML = (r.parent ? `<div class="sess" data-d="${esc(r.parent)}">${icon('chevron', 13)}<span class="t">上一级</span></div>` : '') +
              (r.dirs.length ? r.dirs.map((d) => `<div class="sess" data-d="${esc(d.path)}">${icon('folder', 15)}<span class="t">${esc(d.name)}</span></div>`).join('') : '<div class="sess-empty">没有子文件夹</div>')
          } catch (err) { toast(err.message, 'err') }
        }
        el.addEventListener('click', (e) => { const d = e.target.closest('[data-d]'); if (d) load(d.dataset.d) })
        el.querySelector('#fpGo').onclick = () => load(el.querySelector('#fpPath').value.trim())
        el.querySelector('#fpPath').onkeydown = (e) => { if (e.key === 'Enter') load(e.target.value.trim()) }
        el.querySelector('[data-x]').onclick = close
        el.querySelector('#fpOk').onclick = () => { picked = el.querySelector('#fpPath').value.trim() || cur; close() }
        load(start)
      }
    })
  })
}
