// Executable skills and rule proposals produced inside the loop (docs/in-loop-evolution.md §5, PLAN §3.3).
// forge_skill: a working procedure becomes kernel.py + test_kernel.py (static check + sandboxed test, trial);
// run_skill: call it (promoted to active after successful reuse in two other sessions and human approval);
// patch_skill: add a point to a document skill as a new revision (session overlay until approved);
// propose_rule: a writing rule for the user's own rule pack (trial until the user accepts it).
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, extname, join, relative, sep } from 'node:path'
import YAML from 'yaml'
import type { AgentTool, Json } from '@evoscholar/harness'
import { atomicWriteFile } from '../atomic-file'
import { inside, modelPath } from '../tools/sandbox'
import { pythonBin, runModelProcess } from '../tools/exec'
import { objectArgs, textResult, type ToolEnv } from '../tools/types'
import {
  extraSkills, kernelProject, kernelRevisionPath, readSkillFile, saveSkillRevision, skillNameValid, skillSource,
  visibleKernelRevisions, writeSkillSource, type KernelInputFormat, type KernelReleases, type SkillSource
} from '../skills'
import { validateMemoryText, type EvolveEvent, type EvolveStore } from './store'

const BANNED: [RegExp, string][] = [
  [/^\s*(import|from)\s+(subprocess|socket|requests|urllib\d?|http|httpx|aiohttp|ftplib|smtplib|telnetlib|paramiko|ctypes|multiprocessing|asyncio\.subprocess)\b/m, '不允许联网或启动子进程的模块'],
  [/\bos\.(system|popen|exec\w*|spawn\w*|fork|kill|remove|unlink|rmdir|removedirs|chmod|chown)\s*\(/, '不允许 os 级别的进程或删除操作'],
  [/\bshutil\.(rmtree|move|chown)\s*\(/, '不允许删除或移动目录'],
  [/(?<![\w.])(eval|exec|compile|__import__)\s*\(/, '不允许动态执行代码'],
  [/['"](\/(Users|home|etc|var|tmp|private|opt|root|mnt|Volumes|usr|bin|System|Library)\b|[A-Za-z]:[\\/]|~[\\/])/, '不允许写死绝对路径；路径请作为 run() 的参数传入，并使用相对路径'],
  [/['"](\.\.[\\/]|[^'"]*[\\/]\.\.[\\/])/, '不允许访问上级目录（..）'],
  [/(?<![\w.])(open|Path)\s*\(\s*['"][^'"]*\.(env|ssh)/, '不允许读取凭据文件']
]
/** Static policy for forged kernels and their tests. Returns violations with the offending line (empty = ok). */
export function checkKernelCode(code: string, file = 'kernel.py'): string[] {
  const out: string[] = []
  const lines = code.split(/\r?\n/)
  for (const [re, msg] of BANNED) {
    const flat = new RegExp(re.source, re.flags.replace('m', ''))
    const i = lines.findIndex((l) => flat.test(l))
    if (i >= 0) out.push(`${file} 第 ${i + 1} 行「${lines[i].trim().slice(0, 80)}」：${msg}`)
    else if (re.test(code)) out.push(`${file}：${msg}`)
  }
  return out
}

const RUNNER = `import importlib.util, json, sys
from pathlib import Path

args = json.loads(sys.argv[3])
input_format = json.loads(sys.argv[4])
if input_format:
    expected = input_format['header']
    try:
        path = Path(args[input_format['argument']])
        if path.suffix.lower() != input_format['extension']:
            raise ValueError('文件后缀不匹配')
        with path.open('r', encoding='utf-8-sig') as source:
            actual = [source.readline(513).removesuffix('\\n') for _ in expected]
        if actual != expected:
            raise ValueError('文件表头不匹配')
    except (OSError, ValueError) as error:
        sys.exit('输入格式不匹配：' + str(error))

spec = importlib.util.spec_from_file_location('evo_kernel_' + sys.argv[2], sys.argv[1])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
res = mod.run(**args)
print('__EVO_RESULT__' + json.dumps(res, ensure_ascii=False, default=str))`
const TEST_RUNNER = `import sys
sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else '.')
import test_kernel as t
fns = [getattr(t, n) for n in sorted(dir(t)) if n.startswith('test') and callable(getattr(t, n))]
assert fns, '测试文件里没有 test_ 开头的函数'
for f in fns:
    f()
print('__EVO_PASS__', len(fns))`

export type KernelHooks = {
  store: EvolveStore
  sessionId: string
  env: ToolEnv
  emit: (e: EvolveEvent) => void
  lastFailure?: () => { invocationId: string; tool: string } | undefined
  addOverlay: (op: string, target: string, value: string, reason: string) => string
}

export function userRulesFile(dataDir: string) { return join(dataDir, 'rulepacks', 'user.yaml') }
type UserRule = { id: string; check: 'pattern'; status: 'trial' | 'active' | 'disabled'; description: string; params: Record<string, unknown>; note?: string; source?: string; proposed_at?: string; example?: string }
export function readUserRules(dataDir: string): UserRule[] {
  const f = userRulesFile(dataDir)
  if (!existsSync(f)) return []
  try { return ((YAML.parse(readFileSync(f, 'utf8')) as { rules?: UserRule[] })?.rules ?? []) } catch { return [] }
}
export function writeUserRules(dataDir: string, rules: UserRule[]): void {
  mkdirSync(inside(dataDir, 'rulepacks'), { recursive: true })
  atomicWriteFile(inside(dataDir, userRulesFile(dataDir)), YAML.stringify({ id: 'user', name: '我的规则', status: 'verified', description: '你在使用中沉淀的写作规则（来自智能体提案或你的纠正）', sources: [{ id: 'user', title: '用户在 EvoScholar 中确认的规则' }], rules }))
}

function kernelInputFormat(value: unknown): KernelInputFormat {
  const { argument, extension, header } = objectArgs(value, ['argument', 'extension', 'header'], ['argument', 'extension', 'header'])
  if (typeof argument !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(argument))
    throw new Error('输入格式的 argument 须为 Python 文件路径参数名')
  if (typeof extension !== 'string' || !/^\.[a-zA-Z0-9]{1,12}$/.test(extension))
    throw new Error('输入格式的 extension 须形如 .csv')
  if (!Array.isArray(header) || !header.length || header.length > 8 ||
      !header.every((line) => typeof line === 'string' && line.length <= 512 && !/[\r\n\0]/.test(line)) ||
      !header.some((line) => line.trim()))
    throw new Error('输入格式的 header 须为 1–8 条逐行匹配的 UTF-8 表头')
  return { argument, extension: extension.toLowerCase(), header }
}

function publishTrial(root: string, name: string, src: SkillSource, scope: KernelReleases['scope'], session: string,
                      files: { code: string; test: string; description: string; usage?: string }) {
  const dir = inside(root, join('skills', name))
  const parent = dirname(dir)
  mkdirSync(parent, { recursive: true })
  const fresh = !existsSync(dir)
  const dest = fresh ? mkdtempSync(join(parent, '.forge-')) : dir
  try {
    const revisions = join(dest, 'revisions')
    mkdirSync(revisions, { recursive: true })
    // An interrupted metadata update can leave an unreferenced revision. Never reuse its number.
    const version = 1 + Math.max(0, ...readdirSync(revisions).map((entry) => Number(/^v(\d+)$/.exec(entry)?.[1] ?? 0)))
    const releaseId = randomUUID()
    const draft = mkdtempSync(join(revisions, '.draft-'))
    const body = `---\n${YAML.stringify({ name, version, description: files.description })}---\n\n# ${name}\n\n${files.description}\n\n${files.usage ?? ''}\n\n用 run_skill 调用，指定 name、version=${version}，args 传入 run() 的关键字参数。\n`
    try {
      writeFileSync(join(draft, 'kernel.py'), files.code)
      writeFileSync(join(draft, 'test_kernel.py'), files.test)
      writeFileSync(join(draft, 'SKILL.md'), body)
      writeFileSync(join(draft, '.release-id'), releaseId)
      renameSync(draft, join(revisions, `v${version}`))
    } finally { rmSync(draft, { recursive: true, force: true }) }
    if (!existsSync(join(dest, 'SKILL.md'))) atomicWriteFile(join(dest, 'SKILL.md'), body)
    const next: SkillSource = {
      ...src, type: 'forged', kernel: true, status: src.releases?.active === undefined ? 'trial' : 'active',
      sessions: [session], reuses: [], importedAt: new Date().toISOString(),
      releases: { ...src.releases, scope, approved: src.releases?.approved ?? [], trial: version }
    }
    atomicWriteFile(join(dest, '.source.json'), JSON.stringify(next, null, 2) + '\n')
    if (fresh) renameSync(dest, dir)
    return { version, releaseId }
  } finally {
    if (fresh) rmSync(dest, { recursive: true, force: true })
  }
}

export function kernelTools(h: KernelHooks): AgentTool[] {
  const root = h.env.ws.root
  const tool = (name: string, description: string, properties: Record<string, Json>, required: string[], run: (a: Record<string, any>, signal?: AbortSignal) => Promise<string>, kind: 'exec' | 'edit' = 'edit'): AgentTool => ({
    name, version: '1', description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    scheduling: 'exclusive',
    validate: (i) => objectArgs(i, Object.keys(properties), required) as Json,
    authorize: async (args, ctx) => h.env.approve?.(name, summaryOf(name, args as Record<string, any>), kind, ctx.signal) ?? true,
    async execute(args, ctx) {
      try { return textResult(await run(args as Record<string, any>, ctx.signal)) }
      catch (e) {
        if (ctx.signal?.aborted) throw e
        return textResult(`${name} 未完成：${(e as Error).message}`, true)
      }
    }
  })
  const summaryOf = (name: string, a: Record<string, any>) => name === 'forge_skill' ? `为当前项目锻造可执行技能 ${a.name}，并在沙箱里运行测试：\n${String(a.code).slice(0, 500)}` : name === 'run_skill' ? `运行技能 ${a.name}${a.version ? ` v${a.version}` : ''}：${JSON.stringify(a.args ?? {}).slice(0, 300)}`
    : name === 'patch_skill' ? `保存技能 ${a.skill} 的试用版本` : `保存写作规则 ${a.id} 的试用提案`

  return [
    tool('forge_skill', '把本会话跑通的文件处理流程封装为 run(**kwargs) 和 test_ 测试函数。指定稳定的 UTF-8 表头和文件后缀，试用版本只在当前项目可用。测试在空目录运行，请内联输入样例。文件路径使用相对路径。不允许联网、子进程或动态执行代码。后续版本可与已生效版本并存，在另外两个会话执行成功后请求人工确认转正。',
      {
        name: { type: 'string', description: '小写字母、数字和 -，如 parse-lumerical-csv' },
        description: { type: 'string', description: '一句话：做什么、输入什么、输出什么' },
        code: { type: 'string', description: 'kernel.py 的完整内容，必须定义 run(**kwargs)' },
        test: { type: 'string', description: 'test_kernel.py 的完整内容（from kernel import run）' },
        input_format: {
          type: 'object', properties: {
            argument: { type: 'string', description: 'run 接收输入文件相对路径的参数名' },
            extension: { type: 'string', description: '文件后缀，例如 .csv' },
            header: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8, description: '稳定且有区分度的 UTF-8 文件开头各行，逐行精确匹配' }
          }, required: ['argument', 'extension', 'header'], additionalProperties: false
        },
        usage: { type: 'string', description: '参数说明和示例调用' }
      }, ['name', 'description', 'code', 'test', 'input_format'], async (a, signal) => {
        const name = String(a.name)
        if (!skillNameValid(name)) throw new Error('名称只能用小写字母、数字和 -')
        const scope = { project: kernelProject(h.env), input: kernelInputFormat(a.input_format) }
        const src = skillSource(root, name)
        if ((src.type !== 'forged' && existsSync(inside(root, join('skills', name)))) ||
            (src.type === 'forged' && src.status === 'active' && !src.releases))
          throw new Error(`已有同名技能 ${name}，请为新的项目算子使用不同名称`)
        if (src.releases && JSON.stringify(src.releases.scope) !== JSON.stringify(scope))
          throw new Error('该名称已绑定其他项目或输入格式，请使用不同名称')
        if (!/^\s*def\s+run\s*\(/m.test(a.code)) throw new Error('code 里必须定义 run(**kwargs)')
        const bad = [...checkKernelCode(a.code), ...checkKernelCode(a.test, 'test_kernel.py')]
        if (bad.length) throw new Error(`静态检查不通过：${bad.join('；')}`)
        validateMemoryText(String(a.description))
        const scratch = inside(h.env.ws.dataDir, 'forge')
        mkdirSync(scratch, { recursive: true })
        const tmp = mkdtempSync(join(scratch, `${name}-`))
        try {
          writeFileSync(join(tmp, 'kernel.py'), a.code)
          writeFileSync(join(tmp, 'test_kernel.py'), a.test)
          const job = {
            host: [pythonBin(h.env), ['-c', TEST_RUNNER]] as [string, string[]],
            sandbox: ['python', '-c', TEST_RUNNER, '/control/skill'],
            skillDir: tmp, emptyWorkspace: true
          }
          const r = await runModelProcess({ ...h.env, cwd: tmp }, job, 120, signal)
          if (r.code !== 0 || !/__EVO_PASS__/.test(r.stdout)) throw new Error(`测试没有通过：\n${r.out.trim().split('\n').slice(-12).join('\n')}`)
          const n = Number(/__EVO_PASS__ (\d+)/.exec(r.stdout)?.[1] ?? 0)
          const current = skillSource(root, name)
          signal?.throwIfAborted()
          if ((current.type !== 'forged' && existsSync(inside(root, join('skills', name)))) ||
              current.type !== src.type || current.importedAt !== src.importedAt ||
              current.releases?.trial !== src.releases?.trial) throw new Error('技能已被其他会话更新，请重新检查')
          const { version, releaseId } = publishTrial(root, name, current, scope, h.sessionId, {
            code: a.code, test: a.test, description: a.description, usage: a.usage
          })
          h.emit({ kind: 'adjust', text: `锻造可执行技能 ${name} v${version}（试用，${n} 个测试通过）：${a.description}`,
            refs: [`K:${name}@v${version}`], data: { action: 'kernel.forge', releaseId, skill: name, version, scope,
              status: 'trial', tests: r.stdout.trim().slice(-2000), trigger: h.lastFailure?.() } })
          return `已加入技能库：${name} v${version}（当前项目，${scope.input.extension} 表头匹配时试用）。${n} 个测试通过。用 run_skill 指定 version=${version} 调用。`
        } finally {
          rmSync(tmp, { recursive: true, force: true })
        }
      }, 'exec'),
    tool('run_skill', '指定可执行技能的名称和版本调用 run。执行前核对项目、实际文件后缀和表头。args 传给 run。导入技能仍用 file 和 argv 运行已启用的 Python 脚本。',
      {
        name: { type: 'string' }, args: { type: 'object' }, file: { type: 'string' },
        argv: { type: 'array', items: { type: 'string' } }, version: { type: 'integer', minimum: 1 }
      }, ['name'], async (a, signal) => {
        const name = String(a.name)
        if (!skillNameValid(name)) throw new Error('技能名无效')
        const src = skillSource(root, name)
        const dir = inside(root, join('skills', name))
        if (a.file !== undefined) {
          if (!['zip', 'github', 'folder'].includes(src.type) || !h.env.skills?.some((skill) => skill.name === name))
            throw new Error('只有已启用的导入技能可以运行附带脚本')
          if (typeof a.file !== 'string' || extname(a.file).toLowerCase() !== '.py')
            throw new Error('只支持运行技能目录中的 Python 脚本')
          const file = inside(dir, a.file)
          const argv: unknown = a.argv ?? []
          if (!Array.isArray(argv) || argv.length > 64 || argv.some((arg) => typeof arg !== 'string'))
            throw new Error('argv 必须为最多 64 项的字符串数组')
          const path = relative(dir, file).split(sep).join('/')
          const result = await runModelProcess(h.env, {
            host: [pythonBin(h.env), [file, ...argv]], sandbox: ['python', `/control/skill/${path}`, ...argv], skillDir: dir
          }, 300, signal)
          if (result.code !== 0) throw new Error(result.out.slice(-2000) || '附带脚本执行失败')
          return result.out.slice(-6000) || '脚本执行完成'
        }
        const version: unknown = a.version ?? (src.releases ? undefined : 1)
        if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1)
          throw new Error('可执行技能须指定有效的 version')
        const selected = visibleKernelRevisions(src, kernelProject(h.env)).find((revision) => revision.version === version)
        if (!selected) throw new Error(`当前项目没有可执行技能 ${name} v${version}；请检查作用域、版本和启用状态`)
        const kernel = inside(root, join(kernelRevisionPath(name, src, version), 'kernel.py'))
        if (!existsSync(kernel)) throw new Error(`缺少技能 ${name} v${version} 的代码`)
        const releaseFile = inside(root, join(dirname(kernel), '.release-id'))
        const releaseId = src.releases && existsSync(releaseFile) ? readFileSync(releaseFile, 'utf8').trim() : undefined
        const input = src.releases?.scope.input
        if (a.args !== undefined && (a.args === null || typeof a.args !== 'object' || Array.isArray(a.args)))
          throw new Error('args 须为关键字参数对象')
        const kwargs = { ...(a.args ?? {}) }
        if (input) {
          const path = kwargs[input.argument]
          if (typeof path !== 'string' || !path || /^[\\/]|^[A-Za-z]:/.test(path))
            throw new Error(`args.${input.argument} 须为项目相对文件路径`)
          const pathInProject = modelPath(h.env, path)
          if (!statSync(pathInProject, { throwIfNoEntry: false })?.isFile())
            throw new Error('输入文件不存在或不是普通文件')
          kwargs[input.argument] = relative(realpathSync(h.env.cwd), pathInProject).split(sep).join('/')
        }
        const args = [name.replace(/-/g, '_') + '_v' + version, JSON.stringify(kwargs), JSON.stringify(input ?? null)]
        const r = await runModelProcess(h.env, {
          host: [pythonBin(h.env), ['-c', RUNNER, kernel, ...args]],
          sandbox: ['python', '-c', RUNNER, '/control/skill/kernel.py', ...args], skillDir: dirname(kernel)
        }, 300, signal)
        const m = /__EVO_RESULT__(.*)$/m.exec(r.stdout)
        h.env.trace?.({ kind: 'kernel.run', skill: name, version, releaseId, status: selected.status,
          input: input && kwargs[input.argument], ok: r.code === 0 && !!m, exitCode: r.code, output: r.out.trim().slice(-6000) })
        if (r.code !== 0 || !m) throw new Error(r.out.trim().split('\n').slice(-10).join('\n') || `退出码 ${r.code}`)
        const current = skillSource(root, name)
        const currentReleases = current.releases
        if (selected.status === 'trial' && currentReleases?.trial === version && !current.disabled &&
            !(current.sessions ?? []).includes(h.sessionId)) {
          const reuses = [...new Set([...(current.reuses ?? []), h.sessionId])]
          if (reuses.length !== (current.reuses ?? []).length) writeSkillSource(root, name, { ...current, reuses })
          if (reuses.length >= 2 &&
            await h.env.approve?.('run_skill', `进化确认：${name} v${version} 已在另外 ${reuses.length} 个会话执行成功。核对结果后可批准在当前项目生效。`, 'evolution', signal)) {
            signal?.throwIfAborted()
            const latest = skillSource(root, name)
            const releases = latest.releases
            if (releases?.trial === version && releases.active === currentReleases.active && !latest.disabled) {
              writeSkillSource(root, name, { ...latest, status: 'active',
                releases: { ...releases, trial: undefined, active: version, approved: [...releases.approved, version] } })
              h.emit({ kind: 'learned', text: `可执行技能 ${name} v${version} 已经用户批准转正`, refs: [`K:${name}@v${version}`],
                data: { action: 'kernel.approve', releaseId, skill: name, version, reuses } })
            }
          }
        }
        const out = r.stdout.slice(0, m.index).trim()
        return `${name} v${version}\n${out ? `${out.slice(-2000)}\n` : ''}结果：${m[1].slice(0, 6000)}`
      }, 'exec'),
    tool('patch_skill', '给一个文档技能（SKILL.md）补充一条要点，例如它漏掉的坑或更好的做法。生成新版本文件，在本会话立即试用；持久化到 genome 需要用户批准。',
      { skill: { type: 'string' }, addition: { type: 'string', description: '要补充的一条要点' }, reason: { type: 'string' } }, ['skill', 'addition', 'reason'], async (a) => {
        const s = readSkillFile(root, String(a.skill))
        if (!s) throw new Error(`没有技能 ${a.skill}`)
        if (skillSource(root, s.meta.name).type === 'forged') throw new Error('可执行技能请用 forge_skill 更新（会重新跑测试）')
        validateMemoryText(String(a.addition))
        const latest = readSkillFile(root, s.meta.name)!
        const ref = saveSkillRevision(root, s.meta.name, latest.meta.description, `${latest.body.trim()}\n\n## 补充（自进化 ${new Date().toISOString().slice(0, 10)}）\n- ${String(a.addition).trim()}`)
        const oid = h.addOverlay('skill.version', s.meta.name, String(ref.version), String(a.reason))
        h.emit({ kind: 'adjust', text: `补丁技能 ${s.meta.name} → v${ref.version}（本会话试用）：${a.addition}`, refs: [oid], data: { overlay: oid, revertable: true } })
        return `已生成 ${s.meta.name} v${ref.version}，本会话下一回合起使用（${oid}）。`
      }),
    tool('propose_rule', '为写作规范检查提出一条新规则（例如稿件检查漏掉的问题、用户反复纠正的写法）。规则先以「试用」加入用户自己的规则包，检查结果里以提示出现；用户在「插件 → 规则包」确认后生效。',
      {
        id: { type: 'string', description: '简短英文标识，如 no-we-in-abstract' },
        description: { type: 'string', description: '规则说明（中文）' },
        phrases: { type: 'array', items: { type: 'string' }, description: '要提示的短语（与 regex 二选一）' },
        regex: { type: 'string', description: 'Python 正则（可选）' },
        scope: { type: 'string', enum: ['all', 'abstract', 'captions'] },
        message: { type: 'string', description: '命中时给用户的提示' },
        severity: { type: 'string', enum: ['warning', 'info', 'error'] },
        reason: { type: 'string', description: '为什么需要这条规则（证据）' },
        example: { type: 'string', description: '命中的原文示例' }
      }, ['id', 'description', 'message', 'reason'], async (a) => {
        const slug = String(a.id).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
        if (!slug) throw new Error('id 无效')
        const phrases = (Array.isArray(a.phrases) ? a.phrases : []).map(String).filter(Boolean).slice(0, 20)
        if (!phrases.length && !a.regex) throw new Error('phrases 和 regex 至少要有一个')
        if (a.regex) { try { new RegExp(String(a.regex)) } catch (e) { throw new Error(`正则无效：${(e as Error).message}`) } }
        validateMemoryText(`${a.description} ${a.message}`)
        const rules = readUserRules(h.env.ws.dataDir)
        const id = `user.${slug}`
        const rule: UserRule = { id, check: 'pattern', status: 'trial', description: String(a.description), params: { ...(phrases.length ? { phrases } : {}), ...(a.regex ? { regex: String(a.regex) } : {}), scope: a.scope ?? 'all', message: String(a.message), severity: a.severity ?? 'warning' }, note: String(a.reason), source: h.sessionId, proposed_at: new Date().toISOString(), ...(a.example ? { example: String(a.example).slice(0, 200) } : {}) }
        const i = rules.findIndex((r) => r.id === id)
        if (i >= 0 && rules[i].status === 'active') throw new Error('正式规则需要用户修改，请为提案使用新编号')
        if (i >= 0) rules[i] = rule
        else rules.push(rule)
        writeUserRules(h.env.ws.dataDir, rules)
        h.emit({ kind: 'adjust', text: `提出写作规则 ${id}（试用）：${a.description}`, refs: [id], data: { rule: id, revertable: true } })
        return `已加入你的规则包：${id}（试用）。之后的稿件检查会以提示的形式应用它；用户确认后转为正式规则。`
      })
  ]
}

/** Index of forged executable skills for the system prompt. */
export function kernelIndex(root: string, project: string): string {
  const rows = extraSkills(root, project)
  if (!rows.length) return ''
  return `\n\n## 可执行技能（用 run_skill 指定名称和 version；有适用的生效版本时优先使用）\n${rows.map((x) =>
    `- ${x.name} v${x.version}（${x.status === 'trial' ? '试用' : '生效'}）：${x.description}${x.input ? ` 输入格式 ${JSON.stringify(x.input)}` : ''}`).join('\n')}`
}
