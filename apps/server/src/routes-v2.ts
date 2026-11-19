// v2 routes: model settings, projects, folder picker, library and usage.
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_SANDBOX_IMAGE,
  PERMISSION_LABELS,
  PERMISSION_MODES,
  PROTOCOLS,
  addProject,
  atomicWriteFile,
  keyEnvFor,
  localGatewayHost,
  normalizeGatewayBase,
  consolidate,
  deleteUserRule,
  importSkill,
  listStyles,
  listUserRules,
  removeImportedSkill,
  setSkillEnabled,
  setUserRule,
  stylePreview,
  fetchProviderModels,
  forgetLibraryEntry,
  getProject,
  libraryPath,
  listDirs,
  listLibrary,
  listProjects,
  listProviders,
  modelInfo,
  presetIds,
  projectFiles,
  providerInfo,
  saveSettings,
  setDeliverable,
  testProviderConnection,
  updateProject,
  usageBy,
  usageTotals,
  type PermissionMode,
  type Protocol,
  type ProviderOverride,
  type Runtime,
  type UsageGroup
} from '@evoscholar/core'
import { serveProjectFile } from './file-preview'
import { body, httpError, send, serveFile } from './http'

export function setEnvKey(root: string, name: string, value: string) {
  if (!/^[A-Z][A-Z0-9_]*_API_KEY$/.test(name)) throw httpError(400, '无效的 API Key 环境变量名')
  if (/[\r\n\0]/.test(value)) throw httpError(400, 'API Key 必须为单行')
  const file = join(root, '.env')
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : []
  const i = lines.findIndex((l) => l.startsWith(`${name}=`) || l.startsWith(`# ${name}=`))
  const line = `${name}=${value}`
  if (i >= 0) lines[i] = line
  else lines.push(line)
  atomicWriteFile(file, lines.join('\n').replace(/\n*$/, '\n'), 0o600)
  if (value) process.env[name] = value
  else delete process.env[name]
}

const PROTOCOL_IDS = PROTOCOLS.map((p) => p.id)

function checkBaseUrl(raw: string): string {
  try { return normalizeGatewayBase(raw) }
  catch (error) { throw httpError(400, (error as Error).message) }
}

export function createV2Routes(rt: Runtime, hooks: { resetIdleSessions: () => Promise<void>; onOverlayChange?: () => void }) {
  const ws = rt.ws
  const settings = () => ws.settings

  const modelsPayload = () => ({
    providers: listProviders(ws.config),
    execution: { engine: 'docker', image: DEFAULT_SANDBOX_IMAGE, hostMode: false, ...settings().execution },
    protocols: PROTOCOLS,
    defaults: settings().defaults,
    efforts: settings().efforts,
    permissions: PERMISSION_MODES.map((id) => ({ id, label: PERMISSION_LABELS[id] }))
  })

  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname
    const method = req.method
    let mm: RegExpExecArray | null

    // ---------- model settings ----------
    if (p === '/api/models' && method === 'GET') return send(res, 200, modelsPayload()), true

    if ((mm = /^\/api\/providers\/([a-z0-9][a-z0-9-]{0,40})$/.exec(p)) && method === 'PUT') {
      const id = mm[1]
      const b = await body(req)
      const isPreset = presetIds().includes(id)
      const prev = settings().providers[id] ?? {}
      if (!isPreset && !prev.custom && !b.custom) throw httpError(404, '未知厂商')
      const next: ProviderOverride = { ...prev }
      if (b.protocol !== undefined) {
        if (!PROTOCOL_IDS.includes(b.protocol)) throw httpError(400, '不支持的协议')
        if (b.protocol !== prev.protocol) { delete next.baseUrl; delete next.models; delete next.modelsFetchedAt }
        next.protocol = b.protocol as Protocol
      }
      if (b.region !== undefined) { next.region = String(b.region); delete next.baseUrl }
      if (b.baseUrl !== undefined) {
        const v = String(b.baseUrl).trim()
        if (v) next.baseUrl = checkBaseUrl(v)
        else delete next.baseUrl
      }
      if (b.authHeader !== undefined) {
        if (!['bearer', 'x-api-key', 'api-key', 'x-goog-api-key'].includes(b.authHeader)) throw httpError(400, '不支持的认证方式')
        next.authHeader = b.authHeader
      }
      if (!isPreset) {
        next.custom = true
        next.label = String(b.label ?? prev.label ?? id).slice(0, 60)
        next.protocol = next.protocol ?? 'chat-completions'
        if (!next.baseUrl) throw httpError(400, '自定义厂商需要填写 Base URL')
        if (b.models !== undefined) next.models = String(b.models).split(/[\s,]+/).filter(Boolean).slice(0, 200).map((m) => ({ id: m }))
      }
      const proposed = providerInfo({ ...ws.config, providers: { ...ws.config.providers, [id]: { ...ws.baseProviders[id], ...next } } }, id)!
      const base = proposed.baseUrl && !proposed.baseUrl.includes('<') ? checkBaseUrl(proposed.baseUrl) : ''
      const origin = base ? new URL(base).origin : undefined
      const official = isPreset && base === proposed.defaultBaseUrl
      if (base && !official && b.confirmGateway === base) {
        next.gatewayApproval = { base, privateAccess: b.privateGateway === true || localGatewayHost(new URL(base)) }
      }
      if (base && !official && next.gatewayApproval?.base !== base && (b.baseUrl !== undefined || b.key !== undefined))
        throw httpError(409, '请确认自定义网关的地址和 API 根路径')
      if (b.key !== undefined && typeof b.key !== 'string') throw httpError(400, 'API Key 必须为字符串')
      if (b.key !== undefined) {
        if (!origin) throw httpError(400, '请先填写 Base URL')
        const hostHash = createHash('sha256').update(origin).digest('hex').slice(0, 16).toUpperCase()
        const envKey = official ? keyEnvFor(id, ws.baseProviders[id]) :
          `EVO_${id.toUpperCase().replace(/-/g, '_')}_${hostHash}_API_KEY`
        setEnvKey(ws.root, envKey, b.key)
        next.apiKeyEnv = envKey
        next.credentialOrigin = origin
      } else if (official && next.credentialOrigin !== origin) {
        delete next.credentialOrigin
        delete next.apiKeyEnv
      }
      settings().providers[id] = next
      saveSettings(ws)
      await hooks.resetIdleSessions()
      return send(res, 200, { ok: true, provider: providerInfo(ws.config, id) }), true
    }
    if ((mm = /^\/api\/providers\/([a-z0-9][a-z0-9-]{0,40})$/.exec(p)) && method === 'DELETE') {
      const id = mm[1]
      delete settings().providers[id]
      saveSettings(ws)
      await hooks.resetIdleSessions()
      return send(res, 200, { ok: true }), true
    }
    if ((mm = /^\/api\/providers\/([a-z0-9][a-z0-9-]{0,40})\/models$/.exec(p)) && method === 'POST') {
      const id = mm[1]
      const r = await fetchProviderModels(ws.config, id)
      if (!r.ok) return send(res, 400, { error: r.error }), true
      settings().providers[id] = { ...(settings().providers[id] ?? {}), models: r.models, modelsFetchedAt: new Date().toISOString() }
      saveSettings(ws)
      return send(res, 200, { ok: true, count: r.models.length, provider: providerInfo(ws.config, id) }), true
    }
    if ((mm = /^\/api\/providers\/([a-z0-9][a-z0-9-]{0,40})\/test$/.exec(p)) && method === 'POST') {
      const id = mm[1]
      const b = await body(req)
      const info = providerInfo(ws.config, id)
      if (!info) throw httpError(404, '未知厂商')
      const model = String(b.model || info.models[0]?.id || '')
      if (!model) return send(res, 400, { error: '没有可测试的模型，请先获取模型' }), true
      const r = await testProviderConnection(ws.config, `${id}/${model}`)
      return send(res, r.ok ? 200 : 400, r.ok ? r : { error: r.error }), true
    }
    if (p === '/api/settings/execution/status' && method === 'GET') {
      const state = rt.executor.status ? await rt.executor.status() : (await rt.executor.available() ? 'ready' : 'engine')
      return send(res, 200, { state, hostMode: settings().execution?.hostMode === true }), true
    }
    if (p === '/api/settings/execution' && method === 'PUT') {
      const b = await body(req, 4096)
      const next = { ...settings().execution }
      if (b.engine !== undefined) {
        if (typeof b.engine !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(b.engine))
          throw httpError(400, '请输入 PATH 中的容器命令名，例如 docker 或 podman')
        next.engine = b.engine
      }
      if (b.image !== undefined) {
        if (typeof b.image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,199}$/.test(b.image))
          throw httpError(400, '请输入有效的 Linux 执行镜像名称')
        next.image = b.image
      }
      if (b.hostMode !== undefined) {
        if (typeof b.hostMode !== 'boolean' || (b.hostMode && b.confirmHostMode !== true))
          throw httpError(400, '启用宿主模式需要明确确认风险')
        next.hostMode = b.hostMode
      }
      settings().execution = next
      saveSettings(ws)
      return send(res, 200, { execution: next }), true
    }
    if (p === '/api/settings/defaults' && method === 'PUT') {
      const b = await body(req)
      const known = new Set(listProviders(ws.config).flatMap((pv) => pv.models.map((md) => `${pv.id}/${md.id}`)))
      const d = settings().defaults
      for (const k of ['model', 'fast', 'vision'] as const) {
        if (b[k] === undefined) continue
        if (b[k] && !known.has(String(b[k]))) throw httpError(400, `未知模型 ${b[k]}`)
        if (b[k]) d[k] = String(b[k])
        else delete d[k]
      }
      if (b.effort !== undefined) d.effort = String(b.effort) || undefined
      if (b.figureStyle !== undefined) {
        if (b.figureStyle && !/^[a-z0-9-]+$/.test(String(b.figureStyle))) throw httpError(400, '风格名无效')
        d.figureStyle = String(b.figureStyle) || undefined
      }
      if (b.permission !== undefined) {
        if (!PERMISSION_MODES.includes(b.permission)) throw httpError(400, '未知权限模式')
        d.permission = b.permission as PermissionMode
      }
      if (b.efforts && typeof b.efforts === 'object') {
        for (const [ref, v] of Object.entries(b.efforts as Record<string, string>)) {
          if (!known.has(ref)) continue
          const cap = modelInfo(ws.config, ref).reasoningEffort
          if (!v || v === 'default') delete settings().efforts[ref]
          else if (cap.supported && (!cap.values?.length || cap.values.includes(v))) settings().efforts[ref] = v
        }
      }
      saveSettings(ws)
      await hooks.resetIdleSessions()
      return send(res, 200, { ok: true, ...modelsPayload() }), true
    }

    // ---------- projects ----------
    if (p === '/api/projects' && method === 'GET') return send(res, 200, { projects: listProjects(rt.db) }), true
    if (p === '/api/projects' && method === 'POST') {
      const b = await body(req)
      try {
        return send(res, 200, { project: addProject(ws, rt.db, String(b.path ?? ''), b.name ? String(b.name) : undefined) }), true
      } catch (e) {
        throw httpError(400, (e as Error).message)
      }
    }
    if ((mm = /^\/api\/projects\/(p-[\w-]+)$/.exec(p)) && method === 'PATCH') {
      const b = await body(req)
      updateProject(rt.db, mm[1], { name: b.name, archived: b.archived })
      return send(res, 200, { project: getProject(rt.db, mm[1]) }), true
    }
    if ((mm = /^\/api\/projects\/(p-[\w-]+)\/files$/.exec(p)) && method === 'GET') {
      const proj = getProject(rt.db, mm[1])
      if (!proj) throw httpError(404, '项目不存在')
      return send(res, 200, { root: proj.path, files: projectFiles(proj.path, url.searchParams.get('q') ?? '') }), true
    }
    if (p === '/api/fs/dirs' && method === 'GET') return send(res, 200, listDirs(url.searchParams.get('path') ?? undefined)), true

    // ---------- library ----------
    if (p === '/api/library' && method === 'GET') {
      const q = url.searchParams
      return send(res, 200, {
        files: listLibrary(rt.db, {
          projectId: q.get('project') ?? undefined,
          sessionId: q.get('session') ?? undefined,
          kind: q.get('kind') ?? undefined,
          type: q.get('type') ?? undefined,
          q: q.get('q') ?? undefined,
          deliverable: q.get('deliverable') === '1'
        })
      }), true
    }
    if ((mm = /^\/api\/library\/(\d+)$/.exec(p))) {
      const id = Number(mm[1])
      if (method === 'PATCH') {
        const b = await body(req)
        setDeliverable(rt.db, id, !!b.deliverable)
        return send(res, 200, { ok: true }), true
      }
      if (method === 'DELETE') {
        forgetLibraryEntry(rt.db, id)
        return send(res, 200, { ok: true }), true
      }
    }
    if ((mm = /^\/api\/library\/(\d+)\/file$/.exec(p)) && method === 'GET') {
      const f = libraryPath(rt.db, Number(mm[1]))
      if (!f || !existsSync(f) || statSync(f).isDirectory()) throw httpError(404, '文件不存在（可能已被移动或删除）')
      return await serveProjectFile(rt, res, f, url.searchParams.get('preview') === 'first-page'), true
    }

    // ---------- usage ----------
    if (p === '/api/usage' && method === 'GET') {
      const days = Number(url.searchParams.get('days') ?? 30) || undefined
      const group = (['day', 'model', 'session', 'project'].includes(url.searchParams.get('group') ?? '') ? url.searchParams.get('group') : 'day') as UsageGroup
      return send(res, 200, {
        totals: usageTotals(rt.db, days),
        rows: usageBy(rt.db, group, { days, sessionId: url.searchParams.get('session') ?? undefined, projectId: url.searchParams.get('project') ?? undefined })
      }), true
    }
    // ---------- plugins: figure styles, skills, user rules ----------
    if (p === '/api/styles' && method === 'GET') return send(res, 200, { styles: await listStyles(rt), current: settings().defaults.figureStyle ?? null }), true
    if ((mm = /^\/api\/styles\/([a-z0-9-]+)\/preview$/.exec(p)) && method === 'GET') {
      try { return serveFile(res, await stylePreview(rt, mm[1])), true } catch (e) { throw httpError(500, (e as Error).message) }
    }
    if (p === '/api/plugins/skills/import' && method === 'POST') {
      const b = await body(req, 20 * 1024 * 1024)
      try {
        const r = await importSkill(rt, { folder: b.folder ? String(b.folder) : undefined, zip: b.zip ? String(b.zip) : undefined, github: b.github ? String(b.github) : undefined, replace: !!b.replace })
        if (b.enable !== false) setSkillEnabled(rt, r.name, true)
        await hooks.resetIdleSessions()
        return send(res, 200, r), true
      } catch (e) { throw httpError(400, (e as Error).message) }
    }
    if ((mm = /^\/api\/plugins\/skills\/([a-z0-9][a-z0-9-]{0,63})$/.exec(p))) {
      if (method === 'PATCH') {
        const b = await body(req)
        try { setSkillEnabled(rt, mm[1], !!b.enabled) } catch (e) { throw httpError(400, (e as Error).message) }
        await hooks.resetIdleSessions()
        return send(res, 200, { ok: true, genome: rt.genomes.activeId() }), true
      }
      if (method === 'DELETE') {
        try { removeImportedSkill(rt, mm[1]) } catch (e) { throw httpError(400, (e as Error).message) }
        await hooks.resetIdleSessions()
        return send(res, 200, { ok: true }), true
      }
    }
    if (p === '/api/plugins/rules' && method === 'GET') return send(res, 200, { rules: listUserRules(rt) }), true
    if ((mm = /^\/api\/plugins\/rules\/(user\.[a-z0-9-]+)$/.exec(p))) {
      if (method === 'PATCH') {
        const b = await body(req)
        if (b.status && !['trial', 'active', 'disabled'].includes(b.status)) throw httpError(400, '未知状态')
        try { return send(res, 200, { rule: setUserRule(rt, mm[1], { status: b.status, message: b.message }) }), true } catch (e) { throw httpError(404, (e as Error).message) }
      }
      if (method === 'DELETE') { deleteUserRule(rt, mm[1]); return send(res, 200, { ok: true }), true }
    }
    if (p === '/api/evolve/consolidate' && method === 'POST') {
      const b = await body(req)
      try {
        return send(res, 200, consolidate(rt, { overlayIds: (b.overlayIds ?? []).map(String), memoryIds: (b.memoryIds ?? []).map(String), note: b.note ? String(b.note).slice(0, 300) : undefined })), true
      } catch (e) { throw httpError(400, (e as Error).message) }
    }

    // ---------- in-loop evolution: memory, overlays, log ----------
    if (p === '/api/evolve' && method === 'GET') {
      const session = url.searchParams.get('session') ?? undefined
      return send(res, 200, {
        memory: rt.evolve.list(),
        overlays: rt.evolve.overlays(session, true).slice(-200),
        log: rt.evolve.recentLog({ sessionId: session, limit: 300 })
      }), true
    }
    if ((mm = /^\/api\/memory\/([LP]-\d{4})$/.exec(p))) {
      const id = mm[1]
      if (!rt.evolve.get(id)) throw httpError(404, '条目不存在')
      if (method === 'PATCH') {
        const b = await body(req)
        try {
          if (b.pinned !== undefined) rt.evolve.pin(id, !!b.pinned)
          if (b.status !== undefined) {
            if (!['trial', 'active', 'retired'].includes(b.status)) throw new Error('未知状态')
            rt.evolve.setStatus(id, b.status)
          }
          if (b.trigger !== undefined || b.content !== undefined) rt.evolve.edit(id, { trigger: b.trigger, content: b.content })
        } catch (e) { throw httpError(400, (e as Error).message) }
        rt.evolve.log({ kind: 'revert', text: `你修改了 ${id}`, refs: [id] })
        return send(res, 200, { item: rt.evolve.get(id) }), true
      }
      if (method === 'DELETE') {
        rt.evolve.remove(id)
        rt.evolve.log({ kind: 'revert', text: `你删除了 ${id}`, refs: [id] })
        return send(res, 200, { ok: true }), true
      }
    }
    if (p === '/api/memory' && method === 'POST') {
      const b = await body(req)
      try {
        const { item } = rt.evolve.upsert({ kind: b.kind === 'lesson' ? 'lesson' : 'preference', trigger: String(b.trigger ?? ''), content: String(b.content ?? ''), source: 'user', projectId: b.projectId ? String(b.projectId) : null, pinned: !!b.pinned })
        return send(res, 200, { item }), true
      } catch (e) { throw httpError(400, (e as Error).message) }
    }
    if ((mm = /^\/api\/overlays\/(O-[\w]+)\/revert$/.exec(p)) && method === 'POST') {
      rt.evolve.setOverlay(mm[1], 'reverted')
      rt.evolve.log({ kind: 'revert', text: `你撤销了本会话调整 ${mm[1]}`, refs: [mm[1]] })
      hooks.onOverlayChange?.()
      return send(res, 200, { ok: true }), true
    }
    return false
  }
}
