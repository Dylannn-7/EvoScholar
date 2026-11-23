// Plugins: skill import (Anthropic Agent Skills format) from a folder, a zip or a GitHub path;
// enabling / disabling skills (a user-approved genome change); figure style catalog; user rules.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import YAML from 'yaml'
import { atomicWriteFile } from './atomic-file'
import type { Runtime } from './session'
import {
  kernelRevisionPath, listSkills, readKernelSkill, readSkillFile, skillNameValid, skillSource, writeSkillSource, type SkillSource
} from './skills'
import { inside } from './tools/sandbox'
import { pythonBin, runProcess } from './tools/exec'
import { readUserRules, writeUserRules } from './evolve/kernels'

const MAX_FILES = 300
const MAX_BYTES = 8 * 1024 * 1024
const TEXT_OK = /\.(md|txt|py|json|ya?ml|csv|tsv|r|m|js|ts|sh|ps1|toml|cfg|ini|tex|bib|html|css|svg)$/i
const BIN_OK = /\.(png|jpe?g|gif|webp|pdf)$/i

type FileMap = Map<string, Buffer>

function bundlePath(path: string): boolean {
  return path.split('/').every((part) => part && part !== '.' && part !== '..' &&
    !/[\\:*?"<>|\u0000-\u001f]/.test(part) && !/[ .]$/.test(part) &&
    !/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part))
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (!m) throw new Error('SKILL.md 缺少 YAML frontmatter（--- name / description ---）')
  return (YAML.parse(m[1]) ?? {}) as Record<string, unknown>
}

/** Validate a skill bundle and install it as skills/<name>/ with provenance in .source.json. */
export function installSkillFiles(root: string, files: FileMap, source: SkillSource, opts: { replace?: boolean } = {}): { name: string; files: number; warnings: string[] } {
  const skillMd = files.get('SKILL.md')
  if (!skillMd) throw new Error('没有找到 SKILL.md（技能目录的根上必须有 SKILL.md）')
  const fm = parseFrontmatter(skillMd.toString('utf8'))
  const name = String(fm.name ?? '').trim()
  if (!skillNameValid(name)) throw new Error(`技能名「${name}」无效：只能用小写字母、数字和 -`)
  if (!String(fm.description ?? '').trim()) throw new Error('SKILL.md 缺少 description')
  if (files.size > MAX_FILES) throw new Error(`文件太多（${files.size} 个，上限 ${MAX_FILES}）`)
  let total = 0
  for (const b of files.values()) total += b.length
  if (total > MAX_BYTES) throw new Error(`技能太大（${(total / 1048576).toFixed(1)} MB，上限 8 MB）`)
  const dir = inside(root, join('skills', name))
  const prev = existsSync(dir) ? skillSource(root, name) : undefined
  if (prev && prev.type === 'builtin') throw new Error(`已有内置技能 ${name}，不能覆盖`)
  if (prev && !opts.replace) throw new Error(`已经导入过 ${name}；如需更新请选择「覆盖更新」`)
  const warnings: string[] = []
  const skills = inside(root, 'skills')
  mkdirSync(skills, { recursive: true })
  const staged = mkdtempSync(join(skills, `.import-${name}-`))
  try {
    const written = new Set<string>()
    for (const [clean, buf] of files) {
      if (!bundlePath(clean) || /(^|\/)\./.test(clean)) { warnings.push(`跳过 ${clean}`); continue }
      const key = clean.normalize('NFC').toLowerCase()
      if (written.has(key)) throw new Error(`技能文件名重复：${clean}`)
      written.add(key)
      if (!TEXT_OK.test(clean) && !BIN_OK.test(clean) && clean !== 'SKILL.md' && !/^LICENSE/i.test(clean)) { warnings.push(`跳过不支持的文件类型 ${clean}`); continue }
      const f = join(staged, clean)
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, buf)
    }
    if (/^\s*(import|from)\s+(subprocess|socket|requests)/m.test([...files.entries()].filter(([k]) => k.endsWith('.py')).map(([, v]) => v.toString('utf8')).join('\n')))
      warnings.push('附带脚本里有联网或子进程调用；智能体只能阅读这些脚本，运行时仍需你的确认')
    const license = String(fm.license ?? '') || ([...files.keys()].find((k) => /^LICENSE/i.test(k)) ? '见 LICENSE' : '')
    if (!license) warnings.push('没有找到许可证信息，请确认可以使用')
    atomicWriteFile(join(staged, '.source.json'), JSON.stringify({ ...source, license: license || undefined, importedAt: new Date().toISOString() }, null, 2))
    if (existsSync(dir)) {
      const backup = join(skills, `.backup-${name}-${randomUUID()}`)
      renameSync(dir, backup)
      try {
        renameSync(staged, dir)
      } catch (error) {
        try { if (!existsSync(dir) && existsSync(backup)) renameSync(backup, dir) } catch {}
        throw error
      }
      rmSync(backup, { recursive: true, force: true })
    } else {
      renameSync(staged, dir)
    }
    return { name, files: files.size, warnings }
  } finally {
    if (existsSync(staged)) rmSync(staged, { recursive: true, force: true })
  }
}

export function readFolder(folder: string): FileMap {
  const base = realpathSync(folder)
  if (!existsSync(join(base, 'SKILL.md'))) throw new Error('这个文件夹里没有 SKILL.md')
  const out: FileMap = new Map()
  let bytes = 0
  let visited = 0
  const walk = (d: string, depth: number) => {
    if (depth > 32) throw new Error('技能目录层级过深')
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (++visited > MAX_FILES * 4) throw new Error('文件太多')
      const n = entry.name
      if (n.startsWith('.') || n === '__pycache__' || n === 'node_modules' || entry.isSymbolicLink()) continue
      const f = inside(base, join(d, n))
      if (entry.isDirectory()) walk(f, depth + 1)
      else if (entry.isFile()) {
        if (out.size >= MAX_FILES) throw new Error('文件太多')
        if (statSync(f).size > MAX_BYTES - bytes) throw new Error('技能太大')
        const content = readFileSync(f)
        bytes += content.length
        if (bytes > MAX_BYTES) throw new Error('技能太大')
        out.set(relative(base, join(d, n)).split(sep).join('/'), content)
      }
    }
  }
  walk(base, 0)
  if (!out.has('SKILL.md')) throw new Error('这个文件夹里没有普通文件 SKILL.md')
  return out
}

/** Minimal zip reader (stored + deflate). The skill root is the folder that holds SKILL.md. */
export function readZip(buf: Buffer): FileMap {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('不是有效的 zip 文件')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const central = p
  const end = central + buf.readUInt32LE(eocd + 12)
  if (count > MAX_FILES * 2 || end > eocd || buf.readUInt16LE(eocd + 4) || buf.readUInt16LE(eocd + 6))
    throw new Error('zip 目录无效或文件太多')
  const all: FileMap = new Map()
  let bytes = 0
  for (let k = 0; k < count; k++) {
    if (p + 46 > end || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 目录损坏')
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nlen = buf.readUInt16LE(p + 28); const xlen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8')
    p += 46 + nlen + xlen + clen
    if (p > end || !bundlePath(name.replace(/\/$/, ''))) throw new Error('zip 包含无效文件名')
    if (name.endsWith('/') || name.startsWith('__MACOSX/')) continue
    if (all.has(name)) throw new Error(`zip 文件名重复：${name}`)
    if (usize > MAX_BYTES - bytes) throw new Error(`${name} 太大`)
    if (local + 30 > central || buf.readUInt32LE(local) !== 0x04034b50) throw new Error('zip 文件头损坏')
    const lnlen = buf.readUInt16LE(local + 26)
    const lxlen = buf.readUInt16LE(local + 28)
    const start = local + 30 + lnlen + lxlen
    if (start + csize > central) throw new Error('zip 文件数据不完整')
    const data = buf.subarray(start, start + csize)
    if (method !== 0 && method !== 8) throw new Error(`不支持的压缩方式 ${method}`)
    const content = method === 0 ? data : inflateRawSync(data, { maxOutputLength: Math.max(1, usize) })
    if (content.length !== usize) throw new Error('zip 文件大小不一致')
    all.set(name, content)
    bytes += content.length
  }
  const skillPath = [...all.keys()].filter((k) => k === 'SKILL.md' || k.endsWith('/SKILL.md')).sort((a, b) => a.length - b.length)[0]
  if (!skillPath) throw new Error('zip 里没有 SKILL.md')
  const prefix = skillPath.slice(0, -'SKILL.md'.length)
  const out: FileMap = new Map()
  for (const [k, v] of all) if (k.startsWith(prefix)) out.set(k.slice(prefix.length), v)
  return out
}

/** https://github.com/<owner>/<repo>/tree/<ref>/<path> (or blob/.../SKILL.md, or owner/repo/path). */
export function parseGithubUrl(url: string): { owner: string; repo: string; ref?: string; path: string } {
  const u = url.trim().replace(/\/+$/, '').replace(/\/SKILL\.md$/, '')
  const m = /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)(?:\/(?:tree|blob)\/([^/]+))?(?:\/(.+))?$/.exec(u)
  if (!m || !bundlePath(`${m[1]}/${m[2]}`) || (m[3] && !bundlePath(m[3])) || (m[4] && !bundlePath(m[4])))
    throw new Error('GitHub 地址格式不对，例如 https://github.com/<owner>/<repo>/tree/main/skills/<name>')
  return { owner: m[1], repo: m[2], ref: m[3], path: m[4] ?? '' }
}

async function readDownload(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return Buffer.concat(chunks, bytes)
      bytes += value.byteLength
      if (bytes > limit) throw new Error('GitHub 下载超过大小限制')
      chunks.push(value)
    }
  } finally {
    if (bytes > limit) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function fetchGithubSkill(url: string, fetchFn: typeof fetch = fetch): Promise<{ files: FileMap; origin: string }> {
  const g = parseGithubUrl(url)
  const api = `https://api.github.com/repos/${g.owner}/${g.repo}`
  const options = { redirect: 'error' as const, signal: AbortSignal.timeout(30_000) }
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'EvoScholar' }
  const json = async (url: string) => {
    const response = await fetchFn(url, { ...options, headers })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`读取 GitHub 仓库失败：HTTP ${response.status}`)
    }
    return JSON.parse((await readDownload(response, MAX_BYTES)).toString('utf8'))
  }
  const ref = g.ref ?? (await json(api)).default_branch
  if (typeof ref !== 'string' || !ref) throw new Error('GitHub 未返回有效默认分支')
  const revision = await json(`${api}/commits/${encodeURIComponent(ref)}`)
  const commit = revision?.sha
  const treeId = revision?.commit?.tree?.sha
  const validSha = (x: unknown) => typeof x === 'string' && /^[a-f0-9]{40}$/i.test(x)
  if (!validSha(commit) || !validSha(treeId)) throw new Error('GitHub 未返回有效提交版本')
  const tree = await json(`${api}/git/trees/${treeId}?recursive=1`)
  if (!Array.isArray(tree.tree) || tree.truncated) throw new Error('GitHub 仓库目录不完整')
  const prefix = g.path ? `${g.path}/` : ''
  const rows = tree.tree as { path?: unknown; type?: unknown; mode?: unknown }[]
  const paths = rows.flatMap((t) => t?.type === 'blob' && (t.mode === '100644' || t.mode === '100755') &&
    typeof t.path === 'string' && bundlePath(t.path) && t.path.startsWith(prefix) &&
    (TEXT_OK.test(t.path) || BIN_OK.test(t.path) || /(?:^|\/)LICENSE[^/]*$/.test(t.path)) ? [t.path] : [])
  if (!paths.includes(`${prefix}SKILL.md`)) throw new Error(`${g.path || '仓库根目录'} 下没有 SKILL.md`)
  if (paths.length > MAX_FILES) throw new Error('文件太多')
  const files: FileMap = new Map()
  let bytes = 0
  const download = async (path: string, required: boolean) => {
    const r = await fetchFn(`https://raw.githubusercontent.com/${g.owner}/${g.repo}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`, {
      ...options, headers: { 'user-agent': 'EvoScholar' }
    })
    if (!r.ok) {
      await r.body?.cancel()
      if (!required && r.status === 404) return
      throw new Error(`下载 ${path} 失败：HTTP ${r.status}`)
    }
    const content = await readDownload(r, MAX_BYTES - bytes)
    bytes += content.length
    return content
  }
  for (const path of paths) files.set(path.slice(prefix.length), (await download(path, true))!)
  if (![...files.keys()].some((k) => /^LICENSE/i.test(k))) {
    for (const lic of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
      const content = await download(lic, false)
      if (content) { files.set('LICENSE.repo.md', content); break }
    }
  }
  return { files, origin: `https://github.com/${g.owner}/${g.repo}/tree/${commit}/${g.path}` }
}

export async function importSkill(rt: Runtime, src: { folder?: string; zip?: string; github?: string; replace?: boolean }, fetchFn?: typeof fetch) {
  if (src.github) {
    const { files, origin } = await fetchGithubSkill(src.github, fetchFn)
    return installSkillFiles(rt.ws.root, files, { type: 'github', origin }, { replace: src.replace })
  }
  if (src.zip) return installSkillFiles(rt.ws.root, readZip(Buffer.from(src.zip, 'base64')), { type: 'zip' }, { replace: src.replace })
  if (src.folder) return installSkillFiles(rt.ws.root, readFolder(src.folder), { type: 'folder', origin: resolve(src.folder) }, { replace: src.replace })
  throw new Error('请提供文件夹、zip 或 GitHub 地址')
}

/** Enabling or disabling a skill changes the harness: recorded as a manual genome version. */
export function setSkillEnabled(rt: Runtime, name: string, on: boolean) {
  if (on && skillSource(rt.ws.root, name).type === 'forged') throw new Error('可执行技能请使用独立的启停开关')
  const meta = listSkills(rt.ws.root).find((s) => s.name === name)
  if (!meta) throw new Error(`没有技能 ${name}`)
  const g = rt.genomes.load()
  const has = (g.skills ?? []).some((s) => s.name === name)
  if (has === on) return g
  return rt.genomes.deriveManual((x) => {
    x.skills = on ? [...(x.skills ?? []), { name, version: meta.version }] : (x.skills ?? []).filter((s) => s.name !== name)
  }, `${on ? '启用' : '停用'}技能 ${name}（用户在插件页操作）`, rt.db)
}

export function removeImportedSkill(rt: Runtime, name: string) {
  const src = skillSource(rt.ws.root, name)
  if (src.type === 'builtin') throw new Error('内置技能不能删除，可以停用')
  if ((rt.genomes.load().skills ?? []).some((s) => s.name === name)) setSkillEnabled(rt, name, false)
  rmSync(join(rt.ws.root, 'skills', name), { recursive: true, force: true })
}

// ---------------------------------------------------------------- figure styles
let styleCache: unknown[] | undefined
/** Bump when evoscholar_styles.preview() changes so cached gallery images are regenerated. */
/** Bump when preview rendering changes; then regenerate assets/style-previews/<version>/. */
export const PREVIEW_VERSION = 'v2'
export async function listStyles(rt: Runtime): Promise<unknown[]> {
  if (styleCache) return styleCache
  const env = { ws: rt.ws, cwd: rt.ws.dataDir, ledger: rt.ledger, category: () => 'usage' as const }
  const r = await runProcess(pythonBin(env), [join(rt.ws.root, 'python', 'evoscholar_styles.py'), 'list', '--meta'], env, 120, AbortSignal.timeout(130_000))
  if (r.code !== 0) throw new Error(`读取出图风格失败：${r.out.trim().split('\n').slice(-2).join(' ')}`)
  styleCache = JSON.parse(r.stdout.slice(r.stdout.indexOf('[')))
  return styleCache!
}
export async function stylePreview(rt: Runtime, id: string): Promise<string> {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('风格名无效')
  // Previews ship with the app, so the gallery works before the Python environment is installed.
  const bundled = join(rt.ws.root, 'assets', 'style-previews', PREVIEW_VERSION, `${id}.png`)
  if (existsSync(bundled)) return bundled
  const dir = join(rt.ws.dataDir, 'style-previews', PREVIEW_VERSION)
  mkdirSync(dir, { recursive: true })
  const out = join(dir, `${id}.png`)
  if (existsSync(out)) return out
  const env = { ws: rt.ws, cwd: dir, ledger: rt.ledger, category: () => 'usage' as const }
  const r = await runProcess(pythonBin(env), [join(rt.ws.root, 'python', 'evoscholar_styles.py'), 'preview', id, out], env, 120, AbortSignal.timeout(130_000))
  if (r.code !== 0 || !existsSync(out)) throw new Error(`生成样图失败：${r.out.trim().split('\n').slice(-2).join(' ')}`)
  return out
}

// ---------------------------------------------------------------- user rules
export function listUserRules(rt: Runtime) { return readUserRules(rt.ws.dataDir) }
export function setUserRule(rt: Runtime, id: string, patch: { status?: 'trial' | 'active' | 'disabled'; message?: string }) {
  const rules = readUserRules(rt.ws.dataDir)
  const r = rules.find((x) => x.id === id)
  if (!r) throw new Error('规则不存在')
  if (patch.status) r.status = patch.status
  if (patch.message) r.params = { ...r.params, message: patch.message }
  writeUserRules(rt.ws.dataDir, rules)
  return r
}
export function deleteUserRule(rt: Runtime, id: string) {
  writeUserRules(rt.ws.dataDir, readUserRules(rt.ws.dataDir).filter((x) => x.id !== id))
}

const TEXT_FILE = /\.(md|txt|py|ya?ml|json|csv|tsv|tex|bib|sh|r|jl|js|ts|toml|ini|cfg|mplstyle)$/i
const FILE_PREVIEW_LIMIT = 256 * 1024
const KERNEL_FILES = ['kernel.py', 'test_kernel.py']

/** Read-only detail for the plugin page: body, revisions, bundled files and forged source. */
export function skillDetail(root: string, name: string) {
  const source = skillSource(root, name)
  const selected = source.releases?.active ?? source.releases?.trial
  const s = selected === undefined ? readSkillFile(root, name) : readKernelSkill(root, name, source, selected)
  if (!s) return undefined
  const dir = inside(root, join('skills', name))
  const versions = new Set<number>([s.meta.version])
  if (source.releases) {
    for (const version of [...source.releases.approved, source.releases.trial]) {
      if (version !== undefined) versions.add(version)
    }
  }
  const files: { path: string; size: number; text: boolean }[] = []
  const walk = (d: string, depth: number) => {
    if (depth > 6 || files.length >= 300) return
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.') || entry.name === '__pycache__') continue
      const full = join(d, entry.name)
      const rel = relative(dir, full).split(sep).join('/')
      if (entry.isDirectory()) { walk(full, depth + 1); continue }
      const revision = /^SKILL@v(\d+)\.md$/.exec(rel)
      if (revision) { versions.add(Number(revision[1])); continue }
      if (rel === 'SKILL.md' || KERNEL_FILES.includes(rel)) continue
      files.push({ path: rel, size: statSync(full).size, text: TEXT_FILE.test(rel) })
    }
  }
  walk(dir, 0)
  const kernelPath = kernelRevisionPath(name, source, selected ?? 1)
  const kernelDir = inside(root, kernelPath)
  const kernel = source.type === 'forged'
    ? Object.fromEntries(KERNEL_FILES.filter((f) => existsSync(join(kernelDir, f))).map((f) => [f, readSkillText(root, name, relative(dir, join(kernelDir, f)))]))
    : undefined
  return {
    name, version: s.meta.version, description: s.meta.description, body: s.body, source,
    versions: [...versions].sort((a, b) => b - a), files: files.sort((a, b) => a.path.localeCompare(b.path)), kernel
  }
}

/** A text file inside one skill folder, capped for display. */
export function readSkillText(root: string, name: string, rel: string): string {
  if (!skillNameValid(name)) throw new Error('技能名无效')
  const dir = inside(root, join('skills', name))
  const file = inside(dir, rel)
  if (!TEXT_FILE.test(file) && !KERNEL_FILES.includes(rel)) throw new Error('只能查看文本文件')
  const st = statSync(file)
  if (!st.isFile()) throw new Error('不是文件')
  const buf = readFileSync(file).subarray(0, FILE_PREVIEW_LIMIT)
  return buf.toString('utf8') + (st.size > FILE_PREVIEW_LIMIT ? '\n…（文件较大，只显示前 256 KB）' : '')
}

/** Trust an imported skill (or withdraw trust). Bundled and built-in skills are trusted already. */
export function setSkillTrusted(rt: Runtime, name: string, on: boolean) {
  const src = skillSource(rt.ws.root, name)
  if (!['github', 'zip', 'folder'].includes(src.type) || src.bundled) throw new Error('只有导入的技能可以设置信任')
  writeSkillSource(rt.ws.root, name, { ...src, trusted: on })
}

/** Switch a forged (executable) skill on or off without deleting it. */
export function setKernelEnabled(rt: Runtime, name: string, on: boolean) {
  const src = skillSource(rt.ws.root, name)
  if (src.type !== 'forged') throw new Error('只有锻造的可执行技能可以单独启停')
  writeSkillSource(rt.ws.root, name, { ...src, disabled: !on })
}

/** Restore an already approved release. Trials and their reuse evidence stay independent. */
export function rollbackKernel(rt: Runtime, name: string, version: unknown) {
  const src = skillSource(rt.ws.root, name)
  const releases = src.releases
  if (src.type !== 'forged' || !releases || typeof version !== 'number' ||
      !Number.isSafeInteger(version) || !releases.approved.includes(version))
    throw new Error('只能回滚到已批准的可执行技能版本')
  if (!existsSync(inside(rt.ws.root, join(kernelRevisionPath(name, src, version), 'kernel.py'))))
    throw new Error('该版本缺少可执行代码')
  if (releases.active === version) return
  writeSkillSource(rt.ws.root, name, { ...src, status: 'active', releases: { ...releases, active: version } })
  rt.evolve.log({ kind: 'revert', text: `可执行技能 ${name} v${releases.active} 回滚为 v${version}`,
    refs: [`K:${name}@v${version}`], data: { skill: name, version, from: releases.active } })
}
