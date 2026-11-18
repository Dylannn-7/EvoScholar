// Executable skills and rule proposals produced inside the loop (docs/in-loop-evolution.md §5, PLAN §3.3).
// forge_skill: a working procedure becomes kernel.py + test_kernel.py (static check + sandboxed test, trial);
// run_skill: call it (promoted to active after successful reuse in two other sessions);
// patch_skill: add a point to a document skill as a new revision (session overlay until approved);
// propose_rule: a writing rule for the user's own rule pack (trial until the user accepts it).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import type { AgentTool, Json } from '@evoscholar/harness'
import { pythonBin, runProcess } from '../tools/exec'
import { objectArgs, textResult, type ToolEnv } from '../tools/types'
import { readSkillFile, saveSkillRevision, skillNameValid, skillSource, writeSkillSource } from '../skills'
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
spec = importlib.util.spec_from_file_location('evo_kernel_' + sys.argv[2], sys.argv[1])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
args = json.loads(sys.argv[3])
res = mod.run(**args)
print('__EVO_RESULT__' + json.dumps(res, ensure_ascii=False, default=str))`
const TEST_RUNNER = `import sys
sys.path.insert(0, '.')
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
  mkdirSync(join(dataDir, 'rulepacks'), { recursive: true })
  writeFileSync(userRulesFile(dataDir), YAML.stringify({ id: 'user', name: '我的规则', status: 'verified', description: '你在使用中沉淀的写作规则（来自智能体提案或你的纠正）', sources: [{ id: 'user', title: '用户在 EvoScholar 中确认的规则' }], rules }))
}

export function kernelTools(h: KernelHooks): AgentTool[] {
  const root = h.env.ws.root
  const tool = (name: string, description: string, properties: Record<string, Json>, required: string[], run: (a: Record<string, any>) => Promise<string>, kind?: 'exec'): AgentTool => ({
    name, version: '1', description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    scheduling: 'exclusive',
    validate: (i) => objectArgs(i, Object.keys(properties), required) as Json,
    authorize: async (args) => (kind && h.env.approve ? h.env.approve(name, summaryOf(name, args as Record<string, any>), kind) : true),
    async execute(args) {
      try { return textResult(await run(args as Record<string, any>)) } catch (e) { return textResult(`${name} 未完成：${(e as Error).message}`, true) }
    }
  })
  const summaryOf = (name: string, a: Record<string, any>) => name === 'forge_skill' ? `锻造可执行技能 ${a.name}，并在沙箱里运行它的测试：\n${String(a.code).slice(0, 500)}` : `运行技能 ${a.name}：${JSON.stringify(a.args ?? {}).slice(0, 300)}`

  return [
    tool('forge_skill', '把本会话里已经跑通的一段处理流程封装成可复用的函数（可执行技能）。code 必须定义 run(**kwargs)，文件路径作为参数传入且用相对路径；test 写 test_ 开头的函数，用本会话真实输入的小片段验证 run。注意：测试在一个独立的空临时目录里运行，读不到项目文件——样例数据请内联在测试里（或在测试里用相对路径写一个小文件再读）。不允许联网、子进程、eval/exec、写死绝对路径或访问上级目录，违规时会指出具体行。宿主会做静态检查并在沙箱里跑测试，通过后以「试用」状态加入技能库，在其他会话成功复用两次后转正。',
      {
        name: { type: 'string', description: '小写字母、数字和 -，如 parse-lumerical-csv' },
        description: { type: 'string', description: '一句话：做什么、输入什么、输出什么' },
        code: { type: 'string', description: 'kernel.py 的完整内容，必须定义 run(**kwargs)' },
        test: { type: 'string', description: 'test_kernel.py 的完整内容（from kernel import run）' },
        usage: { type: 'string', description: '参数说明和示例调用' }
      }, ['name', 'description', 'code', 'test'], async (a) => {
        const name = String(a.name)
        if (!skillNameValid(name)) throw new Error('名称只能用小写字母、数字和 -')
        const existing = readSkillFile(root, name)
        const src = skillSource(root, name)
        if (existing && src.type !== 'forged') throw new Error(`已有同名技能 ${name}（${src.type === 'builtin' ? '内置' : '导入'}），请换个名字`)
        if (!/^\s*def\s+run\s*\(/m.test(a.code)) throw new Error('code 里必须定义 run(**kwargs)')
        const bad = [...checkKernelCode(a.code), ...checkKernelCode(a.test, 'test_kernel.py')]
        if (bad.length) throw new Error(`静态检查不通过：${bad.join('；')}`)
        validateMemoryText(String(a.description))
        const tmp = join(h.env.ws.dataDir, 'forge', `${name}-${Date.now().toString(36)}`)
        mkdirSync(tmp, { recursive: true })
        try {
          writeFileSync(join(tmp, 'kernel.py'), a.code)
          writeFileSync(join(tmp, 'test_kernel.py'), a.test)
          const r = await runProcess(pythonBin(h.env), ['-c', TEST_RUNNER], { ...h.env, cwd: tmp }, 120, AbortSignal.timeout(130_000))
          if (r.code !== 0 || !/__EVO_PASS__/.test(r.stdout)) throw new Error(`测试没有通过：\n${r.out.trim().split('\n').slice(-12).join('\n')}`)
          const n = Number(/__EVO_PASS__ (\d+)/.exec(r.stdout)?.[1] ?? 0)
          const dir = join(root, 'skills', name)
          mkdirSync(dir, { recursive: true })
          if (existsSync(join(dir, 'kernel.py'))) writeFileSync(join(dir, `kernel.prev.py`), readFileSync(join(dir, 'kernel.py')))
          writeFileSync(join(dir, 'kernel.py'), a.code)
          writeFileSync(join(dir, 'test_kernel.py'), a.test)
          const body = `# ${name}\n\n${a.description}\n\n## 用法\n${a.usage || '用 run_skill 调用，args 传入 run() 的关键字参数。'}\n\n调用：\`run_skill({"name": "${name}", "args": {...}})\`。源码见附带文件 kernel.py，测试见 test_kernel.py。\n`
          if (existing) saveSkillRevision(root, name, String(a.description), body)
          else writeFileSync(join(dir, 'SKILL.md'), `---\n${YAML.stringify({ name, version: 1, description: String(a.description) })}---\n\n${body}`)
          writeSkillSource(root, name, { type: 'forged', status: 'trial', sessions: [...new Set([...(src.sessions ?? []), h.sessionId])], reuses: [], kernel: true, importedAt: new Date().toISOString() })
          h.emit({ kind: 'adjust', text: `锻造可执行技能 ${name}（试用，${n} 个测试通过）：${a.description}`, refs: [`K:${name}`], data: { skill: name } })
          return `已加入技能库：${name}（试用）。${n} 个测试通过。以后用 run_skill 调用；在另外两个会话成功复用后会自动转正。`
        } finally {
          rmSync(tmp, { recursive: true, force: true })
        }
      }, 'exec'),
    tool('run_skill', '调用技能库里的可执行技能（自进化锻造的 kernel）。args 是传给 run() 的关键字参数，文件路径相对于工作目录。',
      { name: { type: 'string' }, args: { type: 'object' } }, ['name'], async (a) => {
        const name = String(a.name)
        const src = skillSource(root, name)
        const kernel = join(root, 'skills', name, 'kernel.py')
        if (!skillNameValid(name) || src.type !== 'forged' || !existsSync(kernel)) throw new Error(`没有可执行技能 ${name}`)
        const r = await runProcess(pythonBin(h.env), ['-c', RUNNER, kernel, name.replace(/-/g, '_'), JSON.stringify(a.args ?? {})], h.env, 300, AbortSignal.timeout(310_000))
        const m = /__EVO_RESULT__(.*)$/m.exec(r.stdout)
        if (r.code !== 0 || !m) throw new Error(r.out.trim().split('\n').slice(-10).join('\n') || `退出码 ${r.code}`)
        const sessions = src.sessions ?? []
        if (!sessions.includes(h.sessionId)) {
          const reuses = [...new Set([...(src.reuses ?? []), h.sessionId])]
          const status = src.status === 'trial' && reuses.length >= 2 ? 'active' : src.status
          writeSkillSource(root, name, { ...src, reuses, status })
          if (status !== src.status) h.emit({ kind: 'learned', text: `可执行技能 ${name} 在 ${reuses.length} 个会话复用成功，已转正`, refs: [`K:${name}`] })
        }
        const out = r.stdout.slice(0, m.index).trim()
        return `${out ? `${out.slice(-2000)}\n` : ''}结果：${m[1].slice(0, 6000)}`
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
        if (i >= 0) rules[i] = { ...rule, status: rules[i].status === 'active' ? 'active' : 'trial' }
        else rules.push(rule)
        writeUserRules(h.env.ws.dataDir, rules)
        h.emit({ kind: 'adjust', text: `提出写作规则 ${id}（试用）：${a.description}`, refs: [id], data: { rule: id, revertable: true } })
        return `已加入你的规则包：${id}（试用）。之后的稿件检查会以提示的形式应用它；用户确认后转为正式规则。`
      })
  ]
}

/** Index of forged executable skills for the system prompt. */
export function kernelIndex(root: string, names: string[]): string {
  const rows = names.map((n) => ({ n, s: skillSource(root, n), d: readSkillFile(root, n)?.meta.description ?? '' })).filter((x) => x.s.type === 'forged')
  if (!rows.length) return ''
  return `\n\n## 可执行技能（自进化锻造，用 run_skill 调用）\n${rows.map((x) => `- ${x.n}${x.s.status === 'trial' ? '（试用）' : ''}：${x.d}`).join('\n')}`
}
