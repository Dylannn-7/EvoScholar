// v2 routes: model settings, projects, folder picker, library and usage.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PERMISSION_LABELS,
  PERMISSION_MODES,
  PROTOCOLS,
  addProject,
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
import { body, httpError, send, serveFile } from './http'

export function setEnvKey(root: string, name: string, value: string) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error('无效的环境变量名')
  const file = join(root, '.env')
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : []
  const i = lines.findIndex((l) => l.startsWith(`${name}=`) || l.startsWith(`# ${name}=`))
  const line = `${name}=${value}`
  if (i >= 0) lines[i] = line
  else lines.push(line)
  writeFileSync(file, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 })
  if (value) process.env[name] = value
  else delete process.env[name]
}

const PROTOCOL_IDS = PROTOCOLS.map((p) => p.id)

function checkBaseUrl(raw: string): string {
  let u: URL
  try { u = new URL(raw) } catch { throw httpError(400, 'Base URL 格式不对') }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
    throw httpError(400, '远程地址必须使用 https')
  if (u.username || u.password || u.search || u.hash) throw httpError(400, 'Base URL 不能包含账号、查询参数或锚点')
  return u.href.replace(/\/+$/, '')
}

export function createV2Routes(rt: Runtime, hooks: { resetIdleSessions: () => Promise<void> }) {
  const ws = rt.ws
  const settings = () => ws.settings

  const modelsPayload = () => ({
    providers: listProviders(ws.config),
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
      settings().providers[id] = next
      saveSettings(ws)
      const info = providerInfo(ws.config, id)!
      if (b.key !== undefined) setEnvKey(ws.root, info.apiKeyEnv, String(b.key).trim())
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
      return serveFile(res, f), true
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
    return false
  }
}
