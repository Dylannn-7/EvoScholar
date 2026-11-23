import { go, goHome, setThemePreference, store, themePreference } from '../app.js'
import { api, post, put } from './api.js'
import { chooseFolder } from './folder-picker.js'
import { esc, openModal, toast } from './modal.js'
import { starterCards } from './workbench.js'

const STEPS = ['接入模型', '运行环境', '外观与项目', '自进化与开始']
const THEMES = [['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']]
const wizard = { step: 1, providerId: 'deepseek', connection: null, projectName: '' }
const hasModelKey = () => store.state?.providers?.some((p) => p.hasKey)

export function openOnboarding ({ step = 1 } = {}) {
  if (step === 1) Object.assign(wizard, { providerId: 'deepseek', connection: null, projectName: '' })
  renderStep(step)
}

function renderStep (step) {
  wizard.step = step
  let stopJobs
  openModal({
    wide: true,
    fullClass: 'onboarding-modal',
    bodyHtml: `<header class="ob-header"><h2 id="obTitle" tabindex="-1">新手向导</h2><button class="btn ghost small" data-ob-skip type="button">跳过向导</button></header>
      <ol class="ob-steps" aria-label="向导步骤">${STEPS.map((name, i) => `<li ${i + 1 === step ? 'aria-current="step"' : ''}>${i + 1} ${name}</li>`).join('')}</ol>
      <div class="ob-body"></div>
      <footer class="ob-footer">
        ${step > 1 ? '<button class="btn ghost" data-ob-back type="button">上一步</button>' : ''}
        <span class="muted" data-ob-require>${step === 1 && !hasModelKey() ? '请先保存一个 API Key，或点击右上角跳过向导' : ''}</span>
        <button class="btn primary" data-ob-next type="button" ${step === 1 && !hasModelKey() ? 'disabled' : ''}>${step === 4 ? '进入工作台' : '下一步'}</button>
      </footer>`,
    onClose: () => stopJobs?.(),
    onMount: (el, close) => {
      el.setAttribute('aria-labelledby', 'obTitle')
      el.querySelector('#obTitle').focus()
      const body = el.querySelector('.ob-body')
      const next = el.querySelector('[data-ob-next]')
      const skip = el.querySelector('[data-ob-skip]')
      let finishing = false
      const finish = async (starterId) => {
        if (finishing) return
        finishing = true
        skip.disabled = next.disabled = true
        try {
          await put('/api/settings/ui', { onboardingCompleted: true })
          await store.refresh()
          if (el.isConnected) { close(); goHome(starterId) }
        } catch (err) {
          toast(err.message, 'err')
          finishing = skip.disabled = false
          next.disabled = step === 1 && !hasModelKey()
        }
      }
      skip.onclick = () => finish()
      next.onclick = () => wizard.step === 4 ? finish() : renderStep(wizard.step + 1)
      el.querySelector('[data-ob-back]')?.addEventListener('click', () => {
        if (!finishing) renderStep(wizard.step - 1)
      })
      if (step === 1) mountModels(body, close, () => {
        next.disabled = finishing || !hasModelKey()
        el.querySelector('[data-ob-require]').textContent = hasModelKey() ? '' : '请先保存一个 API Key，或点击右上角跳过向导'
      })
      if (step === 2) stopJobs = mountEnvironment(body)
      if (step === 3) mountAppearance(body, close)
      if (step === 4) mountEvolution(body, finish)
    }
  })
}

function mountModels (body, close, updateNext) {
  body.innerHTML = `<h3>接入你的模型服务</h3>
    <p class="muted">EvoScholar 在本机运行，不提供模型。API 密钥只保存在本机，只发送给你选择的模型服务。</p>
    <div data-ob-models class="muted">正在读取厂商…</div>
    <button class="btn ghost small" data-ob-settings type="button">需要自定义网关或其他协议？前往设置</button>`
  body.querySelector('[data-ob-settings]').onclick = () => { close(); go('settings', 'models') }
  const panel = body.querySelector('[data-ob-models]')
  void api('/api/models').then(({ providers }) => {
    const presets = providers.filter((p) => !p.custom)
    const draw = (message = '', failed = false) => {
      if (!body.isConnected) return
      const p = presets.find((item) => item.id === wizard.providerId) ?? presets[0]
      const configured = store.state.providers.filter((item) => item.hasKey)
      const official = p.protocol === p.defaultProtocol && p.baseUrl === p.defaultBaseUrl && /^https:\/\/[^<]+$/.test(p.baseUrl)
      const keySaved = configured.some((item) => item.id === p.id)
      const count = wizard.connection?.id === p.id ? wizard.connection.count : null
      panel.innerHTML = `
        ${configured.length ? `<p class="result ok">已接入：${configured.map((item) => esc(item.label)).join('、')}</p>` : ''}
        <div class="seg-tabs ob-providers" aria-label="模型厂商">${presets.map((item) => `<button type="button" class="${p.id === item.id ? 'on' : ''}" aria-pressed="${p.id === item.id}" data-ob-provider="${esc(item.id)}">${esc(item.label)}</button>`).join('')}</div>
        ${p.apiKeyUrl ? `<p><a href="${esc(p.apiKeyUrl)}" target="_blank" rel="noopener">获取 API Key</a></p>` : ''}
        ${official ? `<form data-ob-key><label class="lbl" for="obApiKey">API Key</label>
          <div class="inline"><input class="input" id="obApiKey" type="password" autocomplete="off" required>
          <button class="btn primary" type="submit">保存并获取模型</button>
          <button class="btn ghost" data-ob-test type="button" ${keySaved ? '' : 'disabled'}>测试连接</button></div></form>`
          : '<p>请前往设置配置此厂商的地址或协议。</p>'}
        ${count !== null ? `<p class="result ok">已连接 ${esc(p.label)}，获取到 ${count} 个模型</p>` : ''}
        <p data-ob-model-result aria-live="polite" ${message ? `class="result ${failed ? 'bad' : 'ok'}"` : 'hidden'}>${esc(message)}</p>`
      updateNext()
      panel.querySelectorAll('[data-ob-provider]').forEach((button) => {
        button.onclick = () => { wizard.providerId = button.dataset.obProvider; draw() }
      })
      const form = panel.querySelector('[data-ob-key]')
      if (!form) return
      const run = async (label, action) => {
        panel.querySelectorAll('button, input').forEach((control) => { control.disabled = true })
        const result = panel.querySelector('[data-ob-model-result]')
        result.hidden = false
        result.textContent = label
        try { draw(await action()) } catch (err) { draw(err.message, true) }
      }
      form.onsubmit = (event) => {
        event.preventDefault()
        const input = form.querySelector('#obApiKey')
        const key = input.value.trim()
        if (!key) return
        void run('正在保存密钥并获取模型…', async () => {
          await put(`/api/providers/${p.id}`, { key })
          input.value = ''
          try {
            const result = await post(`/api/providers/${p.id}/models`)
            const first = result.provider.models[0]
            if (!store.state.defaults.model && first) await put('/api/settings/defaults', { model: `${p.id}/${first.id}` })
            if (body.isConnected) wizard.connection = { id: p.id, count: result.count }
          } finally { await store.refresh() }
        })
      }
      panel.querySelector('[data-ob-test]').onclick = () => run('正在测试连接…', async () => {
        await post(`/api/providers/${p.id}/test`)
        return '测试连接成功'
      })
    }
    draw()
  }).catch((err) => { panel.textContent = err.message })
}

function mountEnvironment (body) {
  const isWindows = navigator.platform.startsWith('Win')
  body.innerHTML = `<h3>配置运行环境</h3><div class="ob-grid">
    <section class="panel ob-card">
      <h4>Python 科研工具环境</h4><p class="muted">用于出图检查、稿件规范检查、PDF 解析和数据处理。未安装时，对话与文献检索不受影响，出图与稿件检查暂不可用。</p>
      <div data-ob-job="python"></div>
    </section>
    <section class="panel ob-card">
      <h4>Linux 执行容器</h4><p class="muted">模型编写的代码在断网容器中运行，只能访问当前项目。没有容器时，模型编写的代码默认不会执行，其他功能不受影响。</p>
      <div data-ob-job="sandbox"></div>
    </section>
    </div>`
  const jobs = { python: null, sandbox: null }
  let execution
  let timer
  const kinds = Object.keys(jobs)
  const statusPath = (kind) => `/api/setup/${kind}`
  const executionPath = '/api/settings/execution/status'
  const draw = (kind, error = '') => {
    const job = jobs[kind]
    const box = body.querySelector(`[data-ob-job="${kind}"]`)
    const python = kind === 'python'
    const ready = python ? job?.ready : execution?.state === 'ready'
    const noEngine = !python && execution?.state === 'engine'
    const status = job?.running ? '安装在后台进行，可以先继续下一步'
      : ready ? '已就绪' : noEngine ? `请先安装并启动 Docker Desktop${isWindows ? '（需要 WSL 2）' : ''}`
        : job?.ok === false ? '安装失败' : job ? '尚未安装' : error ? '读取状态失败' : '正在检测…'
    box.innerHTML = `<p class="muted" role="status">${status}</p>
      ${error ? `<p class="result bad">${esc(error)}</p>` : ''}
      ${job?.log ? `<pre class="ob-log">${esc(job.log.trimEnd().split(/\r?\n/).slice(-6).join('\n'))}</pre>` : ''}
      <div class="inline"><button class="btn ghost small" data-ob-install type="button" ${job && !job.running && !ready && (python || execution && !noEngine) ? '' : 'disabled'}>${python ? '安装' : '构建镜像'}</button>
        ${!python ? '<button class="btn ghost small" data-ob-redetect type="button">重新检测</button>' : ''}</div>`
    box.querySelector('[data-ob-install]').onclick = (event) => {
      event.currentTarget.disabled = true
      void load(kind, true)
    }
    box.querySelector('[data-ob-redetect]')?.addEventListener('click', () => { void load(kind) })
  }
  const load = async (kind, start = false, polling = false) => {
    try {
      const job = await (start ? post(statusPath(kind)) : api(statusPath(kind)))
      if (!body.isConnected) return
      jobs[kind] = job
      if (kind === 'sandbox' && (!polling || !job.running)) execution = await api(executionPath)
      if (body.isConnected) draw(kind)
    } catch (err) { if (body.isConnected) draw(kind, err.message) }
    finally {
      clearTimeout(timer)
      if (body.isConnected && kinds.some((id) => jobs[id]?.running)) {
        timer = setTimeout(() => { for (const id of kinds) if (jobs[id]?.running) void load(id, false, true) }, 1500)
      }
    }
  }
  for (const kind of kinds) { draw(kind); void load(kind) }
  return () => clearTimeout(timer)
}

function mountAppearance (body, close) {
  body.innerHTML = `<h3>外观与项目</h3><div class="ob-grid">
    <section class="panel ob-card"><h4>界面主题</h4><div class="seg" aria-label="界面主题">${THEMES.map(([id, label]) => `<button type="button" data-ob-theme="${id}">${label}</button>`).join('')}</div></section>
    <section class="panel ob-card"><h4>项目</h4>
      <p class="muted">每个课题对应电脑上的一个文件夹。项目规则和记忆只在所属项目内生效，智能体只能读写这个文件夹。</p>
      <button class="btn ghost small" data-ob-folder type="button">选择项目文件夹</button>
      ${wizard.projectName ? `<p class="result ok">已添加项目：${esc(wizard.projectName)}</p>` : ''}
    </section></div>`
  const themeButtons = [...body.querySelectorAll('[data-ob-theme]')]
  const showTheme = (theme) => themeButtons.forEach((button) => {
    const selected = button.dataset.obTheme === theme
    button.classList.toggle('on', selected)
    button.setAttribute('aria-pressed', String(selected))
  })
  showTheme(themePreference())
  for (const button of themeButtons) button.onclick = async () => {
    const old = themePreference()
    const theme = button.dataset.obTheme
    setThemePreference(theme)
    showTheme(theme)
    themeButtons.forEach((item) => { item.disabled = true })
    try {
      await put('/api/settings/ui', { theme })
      store.state.ui = { ...store.state.ui, theme }
    } catch (err) {
      setThemePreference(old)
      showTheme(old)
      toast(err.message, 'err')
    } finally { themeButtons.forEach((item) => { item.disabled = false }) }
  }
  body.querySelector('[data-ob-folder]').onclick = async () => {
    close()
    try {
      const path = await chooseFolder({ title: '选择项目文件夹', confirmText: '添加这个文件夹' })
      if (path) {
        const { project } = await post('/api/projects', { path })
        wizard.projectName = project.name
        await store.refresh()
      }
    } catch (err) { toast(err.message, 'err') }
    finally { openOnboarding({ step: 3 }) }
  }
}

function mountEvolution (body, finish) {
  body.innerHTML = `<h3>工作台如何积累经验</h3><div class="ob-grid ob-grid-three">
    <section class="panel ob-card"><h4>规则记忆</h4><p class="muted">你纠正一次，系统就记成项目规则（P- 编号）。之后的新会话自动沿用。</p></section>
    <section class="panel ob-card"><h4>经验积累</h4><p class="muted">出错时先反思，把教训记成经验（L- 编号），按任务效果计分。跑通的流程可封装为可执行技能，经你批准后转正。</p></section>
    <section class="panel ob-card"><h4>流程优化</h4><p class="muted">对提示词和流程的改进先在会话内试用，经你批准才上线。可在「轨迹 → 版本」对比和回滚。</p></section>
    </div><h3>从一个任务开始</h3><div class="ob-grid ob-grid-three">${starterCards()}</div>`
  body.onclick = (event) => {
    const starter = event.target.closest('[data-starter]')
    if (starter) void finish(starter.dataset.starter)
  }
}
