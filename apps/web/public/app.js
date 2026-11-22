// EvoScholar web workbench v2 — no build step, no external requests.
// Shell: icon rail + view router + shared state. Views live in ui/*.js.
import { api, post, storeToken } from './ui/api.js'
import { icon } from './ui/icons.js'
import { toast } from './ui/modal.js'
import { initWorkbench } from './ui/workbench.js'
import { renderSettings } from './ui/settings.js'
import { renderLibrary, renderPlugins, renderTrajectory, renderUsage } from './ui/pages.js'

export const $ = (s, el = document) => el.querySelector(s)

// ---------------------------------------------------------------- theme (dark / light / follow system)
const THEMES = ['dark', 'light', 'system']
const darkQuery = matchMedia('(prefers-color-scheme: dark)')
let themePref = 'dark'
function applyTheme () {
  const resolved = themePref === 'system' ? (darkQuery.matches ? 'dark' : 'light') : themePref
  document.documentElement.dataset.theme = resolved
}
/** Remember the preference locally and apply it; the server copy is written by the settings page. */
export function setThemePreference (pref) {
  if (!THEMES.includes(pref)) return
  themePref = pref
  try { localStorage.setItem('evoscholar.theme', pref) } catch {}
  applyTheme()
}
export const themePreference = () => themePref
darkQuery.addEventListener?.('change', () => { if (themePref === 'system') applyTheme() })
{
  // The desktop shell passes the saved theme in the URL so the first paint already matches.
  let initial = new URLSearchParams(location.search).get('theme')
  if (!THEMES.includes(initial)) { try { initial = localStorage.getItem('evoscholar.theme') } catch {} }
  setThemePreference(THEMES.includes(initial) ? initial : 'dark')
}

// ---------------------------------------------------------------- particles
const NOOP = { setState () {}, setDim () {}, setBudgetLevel () {}, reform () {}, setQuality () {}, setMouseStrength () {}, quality: 'off' }
export const fx = { impl: NOOP, call (m, ...a) { try { this.impl[m]?.(...a) } catch {} } }
let fxMod = null
import('./fx/index.js').then((m) => { fxMod = m; fx.impl = m.initFx(document.getElementById('bg')) || NOOP; syncFx() }).catch((e) => console.warn('fx disabled:', e))
/** Switch particle quality in place: dispose the field, swap in a fresh canvas, start again. */
export function setFxQuality (q) {
  try { localStorage.setItem('evoscholar.fxQuality', q) } catch {}
  if (!fxMod) return
  try { fx.impl.dispose?.() } catch {}
  const old = document.getElementById('bg')
  const canvas = document.createElement('canvas')
  canvas.id = 'bg'
  canvas.setAttribute('aria-hidden', 'true')
  old.replaceWith(canvas)
  fx.impl = fxMod.initFx(canvas) || NOOP
  syncFx()
}
export function syncFx () {
  const main = document.getElementById('main')?.getBoundingClientRect()
  if (main?.width) fx.call('setFocus', (main.left + main.width / 2) / innerWidth)
  fx.call('setDim', document.body.classList.contains('in-session') ? 0.4 : view === 'workbench' ? 1 : 0.3)
}

// Liquid-glass rim light follows the pointer.
const pointer = { x: -1e4, y: -1e4, dirty: true }
addEventListener('pointermove', (e) => { pointer.x = e.clientX; pointer.y = e.clientY; pointer.dirty = true }, { passive: true })
;(function glassLight () {
  if (pointer.dirty) {
    pointer.dirty = false
    for (const el of document.querySelectorAll('.glass')) {
      const r = el.getBoundingClientRect()
      if (!r.width) continue
      el.style.setProperty('--lx', `${pointer.x - r.left}px`)
      el.style.setProperty('--ly', `${pointer.y - r.top}px`)
    }
  }
  requestAnimationFrame(glassLight)
})()

// ---------------------------------------------------------------- shared state
export const store = {
  state: null,
  async refresh () {
    this.state = await api('/api/state')
    if (this.state.ui?.theme && this.state.ui.theme !== themePref) setThemePreference(this.state.ui.theme)
    renderRail()
    return this.state
  }
}

// ---------------------------------------------------------------- router
const VIEWS = [
  { id: 'workbench', label: '工作台', icon: 'workbench' },
  { id: 'trajectory', label: '轨迹', icon: 'trajectory' },
  { id: 'plugins', label: '插件', icon: 'plugins' },
  { id: 'library', label: '资料空间', icon: 'library' },
  { id: 'usage', label: '用量', icon: 'usage' }
]
const RENDER = { trajectory: renderTrajectory, plugins: renderPlugins, library: renderLibrary, usage: renderUsage, settings: renderSettings }
let view = 'workbench'
let workbench

export function go (next, arg) {
  view = next
  for (const v of [...VIEWS.map((x) => x.id), 'settings']) $(`#view-${v}`).hidden = v !== next
  document.body.classList.toggle('with-side', next === 'workbench')
  $('#side').hidden = next !== 'workbench'
  renderRail()
  if (next !== 'workbench') RENDER[next]($(`#view-${next}`), arg)
  syncFx()
  try { history.replaceState(null, '', next === 'workbench' ? location.pathname + (workbench?.current ? `?s=${workbench.current}` : '') : `#${next}`) } catch {}
}

function renderRail () {
  const pending = store.state?.pending ?? 0
  $('#rail').innerHTML = `
    <button class="rail-btn brand" data-go="workbench" data-home="1" data-tip="EvoScholar 首页" type="button">${icon('brand', 18)}</button>
    ${VIEWS.map((v) => `<button class="rail-btn ${view === v.id ? 'on' : ''}" data-go="${v.id}" data-tip="${v.label}" type="button" aria-label="${v.label}">${icon(v.icon, 19)}${v.id === 'trajectory' && pending ? '<i class="dotmark"></i>' : ''}</button>`).join('')}
    <div class="rail-sp"></div>
    <button class="rail-btn ${view === 'settings' ? 'on' : ''}" data-go="settings" data-tip="设置" type="button" aria-label="设置">${icon('settings', 19)}</button>`
}
document.getElementById('rail').addEventListener('click', (e) => {
  const b = e.target.closest('[data-go]')
  if (!b) return
  if (b.dataset.home) { go('workbench'); workbench.home(); return }
  go(b.dataset.go)
})

// ---------------------------------------------------------------- popover menus
let popEl = null
export function closePop () { popEl?.remove(); popEl = null; document.querySelectorAll('.tb.open').forEach((x) => x.classList.remove('open')) }
/** Open a menu anchored to `anchor`. items: [{group}] | [{label, desc, right, checked, onPick}] */
export function openPop (anchor, items, opts = {}) {
  closePop()
  const el = document.createElement('div')
  el.className = 'pop'
  const draw = (q = '') => {
    const list = items.filter((it) => it.group || !q || `${it.label} ${it.desc || ''}`.toLowerCase().includes(q.toLowerCase()))
    el.querySelector('.pop-items').innerHTML = list.length ? list.map((it, i) => it.group
      ? `<div class="grp">${it.group}</div>`
      : `<button type="button" class="it" data-i="${items.indexOf(it)}">${it.icon ? icon(it.icon, 16) : ''}<span>${it.label}${it.desc ? `<span class="d">${it.desc}</span>` : ''}</span>${it.checked ? `<span class="tick">${icon('check', 15)}</span>` : it.right ? `<span class="r">${it.right}</span>` : ''}</button>`).join('') : '<div class="none">没有匹配项</div>'
  }
  el.innerHTML = `${opts.search ? `<input class="input" placeholder="${opts.search}">` : ''}<div class="pop-items"></div>`
  draw()
  document.body.appendChild(el)
  const r = anchor.getBoundingClientRect()
  const h = el.offsetHeight
  const w = el.offsetWidth
  el.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left))}px`
  el.style.top = r.top - h - 8 > 8 ? `${r.top - h - 8}px` : `${r.bottom + 8}px`
  anchor.classList.add('open')
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]')
    if (!b) return
    const it = items[Number(b.dataset.i)]
    closePop()
    Promise.resolve().then(() => it.onPick?.()).catch((error) => toast(error.message, 'err'))
  })
  const inp = el.querySelector('input')
  if (inp) { inp.oninput = () => draw(inp.value); setTimeout(() => inp.focus(), 0) }
  popEl = el
  return el
}
// Icon-only buttons take their tooltip as an accessible name, so screen readers say more than "button".
function nameButtons (root) {
  for (const b of root.querySelectorAll ? root.querySelectorAll('button:not([aria-label])') : []) {
    if (b.textContent.trim()) continue
    const name = b.title || b.dataset.tip
    if (name) b.setAttribute('aria-label', name)
  }
}
new MutationObserver((records) => {
  for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) nameButtons(n.parentElement || n)
}).observe(document.body, { childList: true, subtree: true })
nameButtons(document)
addEventListener('resize', () => syncFx())
addEventListener('hashchange', () => { const h = location.hash.slice(1); if (RENDER[h] && h !== view) go(h) })
addEventListener('mousedown', (e) => { if (popEl && !popEl.contains(e.target) && !e.target.closest('.tb.open')) closePop() })
addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop() })

// ---------------------------------------------------------------- boot
function showPairing(message = '') {
  workbench?.home()
  const existing = document.querySelector('#pairing')
  if (existing) { existing.querySelector('output').textContent = message; return }
  const dialog = document.createElement('dialog')
  dialog.id = 'pairing'
  dialog.className = 'modal'
  dialog.innerHTML = `<form class="modal-form"><h2>配对 EvoScholar</h2>
    <p>请输入启动终端显示的配对码。</p>
    <label class="field-label">配对码 <input class="input" name="code" type="password" inputmode="numeric" autocomplete="off" required></label>
    <output role="status"></output>
    <button class="btn primary" type="submit">配对</button></form>`
  dialog.querySelector('output').textContent = message
  dialog.addEventListener('cancel', (event) => event.preventDefault())
  document.body.append(dialog)
  dialog.showModal()
  const form = dialog.querySelector('form')
  form.onsubmit = async (event) => {
    event.preventDefault()
    const submit = form.querySelector('button')
    submit.disabled = true
    try {
      await pair(new FormData(form).get('code'))
      dialog.close(); dialog.remove()
      await boot()
    } catch (error) {
      form.querySelector('output').textContent = error.message
    } finally { submit.disabled = false }
  }
}
async function pair(code) {
  const result = await post('/api/auth/pair', { code })
  storeToken(result.token)
}
async function boot() {
  await store.refresh()
  const sid = new URLSearchParams(location.search).get('s')
  const [hash, sub] = location.hash.slice(1).split(':')
  workbench ??= initWorkbench()
  if (sid) workbench.open(sid)
  else workbench.home()
  go(RENDER[hash] ? hash : 'workbench', sub)
}
addEventListener('evo:unpaired', () => showPairing(workbench ? '会话令牌已失效，请重新配对。' : ''))
void (async () => {
  const auto = new URLSearchParams(location.hash.slice(1)).get('pair')
  if (auto) {
    try { await pair(auto) }
    catch (error) { showPairing(error.message); return }
    finally { history.replaceState(null, '', location.pathname + location.search) }
  }
  try { await boot() }
  catch (error) { showPairing(error.status === 401 ? '' : error.message) }
})()
