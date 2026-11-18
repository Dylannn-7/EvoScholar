// Plugins: skill import (Anthropic Agent Skills format) from a folder, a zip or a GitHub path;
// enabling / disabling skills (a user-approved genome change); figure style catalog; user rules.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import YAML from 'yaml'
import type { Runtime } from './session'
import { listSkills, readSkillFile, skillNameValid, skillSource, writeSkillSource, type SkillSource } from './skills'
import { pythonBin, runProcess } from './tools/exec'
import { readUserRules, writeUserRules } from './evolve/kernels'

const MAX_FILES = 300
const MAX_BYTES = 8 * 1024 * 1024
const TEXT_OK = /\.(md|txt|py|json|ya?ml|csv|tsv|r|m|js|ts|sh|ps1|toml|cfg|ini|tex|bib|html|css|svg)$/i
const BIN_OK = /\.(png|jpe?g|gif|webp|pdf)$/i

type FileMap = Map<string, Buffer>

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
  const dir = join(root, 'skills', name)
  const prev = existsSync(dir) ? skillSource(root, name) : undefined
  if (prev && prev.type === 'builtin') throw new Error(`已有内置技能 ${name}，不能覆盖`)
  if (prev && !opts.replace) throw new Error(`已经导入过 ${name}；如需更新请选择「覆盖更新」`)
  const warnings: string[] = []
  const staged = join(root, 'skills', `.import-${name}-${Date.now()}`)
  mkdirSync(staged, { recursive: true })
  try {
    for (const [rel, buf] of files) {
      const clean = normalize(rel).split(sep).join('/')
      if (clean.startsWith('..') || clean.startsWith('/') || /(^|\/)\./.test(clean)) { warnings.push(`跳过 ${rel}`); continue }
      if (!TEXT_OK.test(clean) && !BIN_OK.test(clean) && clean !== 'SKILL.md' && !/^LICENSE/i.test(clean)) { warnings.push(`跳过不支持的文件类型 ${rel}`); continue }
      const f = join(staged, clean)
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, buf)
    }
    if (/^\s*(import|from)\s+(subprocess|socket|requests)/m.test([...files.entries()].filter(([k]) => k.endsWith('.py')).map(([, v]) => v.toString('utf8')).join('\n')))
      warnings.push('附带脚本里有联网或子进程调用；智能体只能阅读这些脚本，运行时仍需你的确认')
    const license = String(fm.license ?? '') || ([...files.keys()].find((k) => /^LICENSE/i.test(k)) ? '见 LICENSE' : '')
    if (!license) warnings.push('没有找到许可证信息，请确认可以使用')
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    cpSync(staged, dir, { recursive: true })
    writeSkillSource(root, name, { ...source, license: license || undefined, importedAt: new Date().toISOString() })
    return { name, files: files.size, warnings }
  } finally {
    rmSync(staged, { recursive: true, force: true })
  }
}

export function readFolder(folder: string): FileMap {
  const base = resolve(folder)
  if (!existsSync(join(base, 'SKILL.md'))) throw new Error('这个文件夹里没有 SKILL.md')
  const out: FileMap = new Map()
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n.startsWith('.') || n === '__pycache__' || n === 'node_modules') continue
      const f = join(d, n)
      if (statSync(f).isDirectory()) walk(f)
      else out.set(relative(base, f).split(sep).join('/'), readFileSync(f))
      if (out.size > MAX_FILES) throw new Error('文件太多')
    }
  }
  walk(base)
  return out
}

/** Minimal zip reader (stored + deflate). The skill root is the folder that holds SKILL.md. */
export function readZip(buf: Buffer): FileMap {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('不是有效的 zip 文件')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const all: FileMap = new Map()
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 目录损坏')
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nlen = buf.readUInt16LE(p + 28); const xlen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8')
    p += 46 + nlen + xlen + clen
    if (name.endsWith('/') || name.startsWith('__MACOSX/')) continue
    if (usize > MAX_BYTES) throw new Error(`${name} 太大`)
    const lnlen = buf.readUInt16LE(local + 26); const lxlen = buf.readUInt16LE(local + 28)
    const data = buf.subarray(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize)
    all.set(name, method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : (() => { throw new Error(`不支持的压缩方式 ${method}`) })())
    if (all.size > MAX_FILES * 2) throw new Error('文件太多')
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
  if (!m) throw new Error('GitHub 地址格式不对，例如 https://github.com/<owner>/<repo>/tree/main/skills/<name>')
  return { owner: m[1], repo: m[2], ref: m[3], path: m[4] ?? '' }
}

export async function fetchGithubSkill(url: string, fetchFn: typeof fetch = fetch): Promise<{ files: FileMap; origin: string }> {
  const g = parseGithubUrl(url)
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'EvoScholar' }
  const repoInfo = await fetchFn(`https://api.github.com/repos/${g.owner}/${g.repo}`, { headers })
  if (!repoInfo.ok) throw new Error(`读取仓库失败：HTTP ${repoInfo.status}`)
  const ref = g.ref ?? ((await repoInfo.json()) as { default_branch: string }).default_branch
  const tree = await fetchFn(`https://api.github.com/repos/${g.owner}/${g.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { headers })
  if (!tree.ok) throw new Error(`读取目录失败：HTTP ${tree.status}`)
  const prefix = g.path ? `${g.path}/` : ''
  const blobs = ((await tree.json()) as { tree: { path: string; type: string; size?: number }[] }).tree
    .filter((t) => t.type === 'blob' && t.path.startsWith(prefix) && (TEXT_OK.test(t.path) || BIN_OK.test(t.path) || /\/LICENSE[^/]*$|^LICENSE/.test(t.path)))
  if (!blobs.some((b) => b.path === `${prefix}SKILL.md`)) throw new Error(`${g.path || '仓库根目录'} 下没有 SKILL.md`)
  if (blobs.length > MAX_FILES) throw new Error('文件太多')
  const files: FileMap = new Map()
  for (const b of blobs) {
    const r = await fetchFn(`https://raw.githubusercontent.com/${g.owner}/${g.repo}/${encodeURIComponent(ref)}/${b.path.split('/').map(encodeURIComponent).join('/')}`, { headers: { 'user-agent': 'EvoScholar' } })
    if (!r.ok) throw new Error(`下载 ${b.path} 失败：HTTP ${r.status}`)
    files.set(b.path.slice(prefix.length), Buffer.from(await r.arrayBuffer()))
  }
  // Repository-level license applies when the skill folder has none.
  if (![...files.keys()].some((k) => /^LICENSE/i.test(k))) {
    for (const lic of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
      const r = await fetchFn(`https://raw.githubusercontent.com/${g.owner}/${g.repo}/${encodeURIComponent(ref)}/${lic}`, { headers: { 'user-agent': 'EvoScholar' } })
      if (r.ok) { files.set('LICENSE.repo.md', Buffer.from(await r.arrayBuffer())); break }
    }
  }
  return { files, origin: `https://github.com/${g.owner}/${g.repo}/tree/${ref}/${g.path}` }
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
  const meta = listSkills(rt.ws.root).find((s) => s.name === name)
  if (!meta) throw new Error(`没有技能 ${name}`)
  const g = rt.genomes.load()
  const has = (g.skills ?? []).some((s) => s.name === name)
  if (has === on) return g
  return rt.genomes.deriveManual((x) => {
    x.skills = on ? [...(x.skills ?? []), { name, version: meta.version }] : (x.skills ?? []).filter((s) => s.name !== name)
  }, `${on ? '启用' : '停用'}技能 ${name}（用户在插件页操作）`)
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
const PREVIEW_VERSION = 'v2'
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

export function skillDetail(root: string, name: string) {
  const s = readSkillFile(root, name)
  return s ? { name, version: s.meta.version, description: s.meta.description, source: skillSource(root, name) } : undefined
}
