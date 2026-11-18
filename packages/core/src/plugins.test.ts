import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import {
  checkKernelCode, consolidate, fetchGithubSkill, installSkillFiles, kernelTools, openRuntime, openWorkspace, parseGithubUrl,
  promote, readFolder, readUserRules, readZip, setSkillEnabled, skillSource, type ToolEnv
} from './index'

const REPO = resolve(__dirname, '../../..')
function ws() {
  const dir = mkdtempSync(join(tmpdir(), 'evo-p4-'))
  for (const d of ['genomes', 'prompts', 'skills']) cpSync(join(REPO, d), join(dir, d), { recursive: true })
  cpSync(join(REPO, 'evoscholar.config.json'), join(dir, 'evoscholar.config.json'))
  mkdirSync(join(dir, 'data'))
  symlinkSync(join(REPO, 'python'), join(dir, 'python'))
  const venv = join(REPO, 'data', `pyenv-${process.platform}-${process.arch}`)
  if (existsSync(venv)) symlinkSync(venv, join(dir, 'data', `pyenv-${process.platform}-${process.arch}`))
  return dir
}
const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('')

/** Hand-built zip (deflate) so the test does not depend on a zip binary. */
function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let off = 0
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content); const data = deflateRawSync(raw); const n = Buffer.from(name)
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26)
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42)
    locals.push(lh, n, data); centrals.push(ch, n); off += 30 + n.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16)
  return Buffer.concat([...locals, cd, eocd])
}

test('kernel static policy blocks network, processes, dynamic code and path escapes', () => {
  assert.deepEqual(checkKernelCode('import numpy as np\ndef run(path):\n    return np.loadtxt(path).mean()'), [])
  for (const bad of ['import subprocess', 'from requests import get', 'os.system("ls")', 'eval(x)', "open('/etc/passwd')", "open('../x.csv')", 'shutil.rmtree(d)'])
    assert.ok(checkKernelCode(bad).length, bad)
})

test('forge -> trial, reuse in two other sessions -> active; patch_skill and propose_rule', async (t) => {
  const dir = ws()
  const rt = openRuntime(openWorkspace(dir))
  t.after(() => { rt.db.close(); rmSync(dir, { recursive: true, force: true }) })
  const cwd = join(dir, 'work'); mkdirSync(cwd)
  writeFileSync(join(cwd, 'm.csv'), 'a,b\n1,2\n3,4\n')
  const events: { kind: string; text: string }[] = []
  const make = (sid: string) => {
    const env: ToolEnv = { ws: rt.ws, cwd, ledger: rt.ledger, category: () => 'dev' }
    const tools = kernelTools({ store: rt.evolve, sessionId: sid, env, emit: (e) => events.push(e), addOverlay: (op, target, value, reason) => rt.evolve.addOverlay({ sessionId: sid, op, target, value, reason }) })
    return (name: string, args: unknown) => tools.find((x) => x.name === name)!.execute(args as never, {} as never) as Promise<{ content: { type: string; text?: string }[]; isError?: boolean }>
  }
  const a = make('s-a')
  const code = 'import csv\n\ndef run(path):\n    rows = list(csv.DictReader(open(path)))\n    return {"n": len(rows), "sum_b": sum(float(r["b"]) for r in rows)}\n'
  const testCode = 'import os\nfrom kernel import run\n\ndef test_sum():\n    open("t.csv", "w").write("a,b\\n1,2\\n")\n    assert run("t.csv") == {"n": 1, "sum_b": 2.0}\n'
  const bad = await a('forge_skill', { name: 'csv-sum', description: '读 CSV 并对 b 列求和', code, test: testCode.replace('2.0', '3.0') })
  assert.equal(bad.isError, true)
  assert.match(text(bad), /测试没有通过/)
  const blocked = await a('forge_skill', { name: 'csv-sum', description: 'x', code: 'import subprocess\ndef run():\n    pass', test: 'def test_a():\n    pass' })
  assert.match(text(blocked), /静态检查不通过/)
  const ok = await a('forge_skill', { name: 'csv-sum', description: '读 CSV 并对 b 列求和', code, test: testCode })
  assert.equal(ok.isError, undefined, text(ok))
  assert.equal(skillSource(dir, 'csv-sum').status, 'trial')
  assert.match(text(await a('run_skill', { name: 'csv-sum', args: { path: 'm.csv' } })), /"sum_b": 6\.0/)
  assert.equal(skillSource(dir, 'csv-sum').status, 'trial', 'reuse in the forging session does not count')
  await make('s-b')('run_skill', { name: 'csv-sum', args: { path: 'm.csv' } })
  await make('s-c')('run_skill', { name: 'csv-sum', args: { path: 'm.csv' } })
  assert.equal(skillSource(dir, 'csv-sum').status, 'active')
  assert.ok(events.some((e) => e.kind === 'learned' && /转正/.test(e.text)))

  const p = await a('patch_skill', { skill: 'figure-style', addition: '图例放在不遮挡数据的位置', reason: '用户两次手动移动图例' })
  assert.match(text(p), /v\d+/)
  const ov = rt.evolve.overlays('s-a')
  assert.equal(ov[0].op, 'skill.version')
  assert.ok(existsSync(join(dir, 'skills', 'figure-style', `SKILL@v${ov[0].value}.md`)))

  const r = await a('propose_rule', { id: 'No We', description: '摘要不用第一人称复数', phrases: ['我们'], scope: 'abstract', message: '摘要建议不用「我们」', reason: '用户纠正过两次' })
  assert.equal(r.isError, undefined, text(r))
  const rules = readUserRules(rt.ws.dataDir)
  assert.equal(rules[0].id, 'user.no-we')
  assert.equal(rules[0].status, 'trial')
})

test('skill import from folder, zip and GitHub; enable/disable is a genome change; consolidate -> approve', async (t) => {
  const dir = ws()
  const rt = openRuntime(openWorkspace(dir))
  t.after(() => { rt.db.close(); rmSync(dir, { recursive: true, force: true }) })
  const skillMd = (name: string) => `---\nname: ${name}\ndescription: 测试技能 ${name}\nlicense: MIT\n---\n# ${name}\n`
  const folder = join(dir, 'ext', 'my-skill'); mkdirSync(join(folder, 'references'), { recursive: true })
  writeFileSync(join(folder, 'SKILL.md'), skillMd('my-skill')); writeFileSync(join(folder, 'references', 'a.md'), 'ref')
  const r1 = installSkillFiles(dir, readFolder(folder), { type: 'folder', origin: folder })
  assert.equal(r1.name, 'my-skill')
  assert.throws(() => installSkillFiles(dir, readFolder(folder), { type: 'folder' }), /已经导入过/)
  assert.throws(() => installSkillFiles(dir, new Map([['SKILL.md', Buffer.from(skillMd('figure-style'))]]), { type: 'zip' }), /内置技能/)
  const zipped = readZip(makeZip({ 'pkg/zip-skill/SKILL.md': skillMd('zip-skill'), 'pkg/zip-skill/scripts/x.py': 'print(1)', '__MACOSX/junk': 'x' }))
  assert.deepEqual([...zipped.keys()].sort(), ['SKILL.md', 'scripts/x.py'])
  assert.equal(installSkillFiles(dir, zipped, { type: 'zip' }).name, 'zip-skill')
  assert.deepEqual(parseGithubUrl('https://github.com/o/r/tree/main/skills/foo'), { owner: 'o', repo: 'r', ref: 'main', path: 'skills/foo' })
  const gh = (async (url: string) => {
    if (url.endsWith('/repos/o/r')) return Response.json({ default_branch: 'main' })
    if (url.includes('/git/trees/')) return Response.json({ tree: [{ path: 'skills/foo/SKILL.md', type: 'blob' }, { path: 'skills/foo/references/x.md', type: 'blob' }, { path: 'other/SKILL.md', type: 'blob' }] })
    if (url.endsWith('skills/foo/SKILL.md')) return new Response(skillMd('foo'))
    if (url.endsWith('references/x.md')) return new Response('x')
    if (url.endsWith('/LICENSE')) return new Response('MIT License')
    return new Response('', { status: 404 })
  }) as unknown as typeof fetch
  const fetched = await fetchGithubSkill('https://github.com/o/r/tree/main/skills/foo', gh)
  assert.deepEqual([...fetched.files.keys()].sort(), ['LICENSE.repo.md', 'SKILL.md', 'references/x.md'])

  const before = rt.genomes.activeId()
  const g = setSkillEnabled(rt, 'my-skill', true)
  assert.notEqual(g.id, before)
  assert.ok(g.skills!.some((s) => s.name === 'my-skill'))

  // Consolidate one kept overlay and one trusted active lesson into a pending candidate, then approve it.
  const oid = rt.evolve.addOverlay({ sessionId: 's1', op: 'prompt.note', value: '写文件后先重读一遍再回答', reason: 'x' })
  rt.evolve.setOverlay(oid, 'kept', 0.8)
  const { item } = rt.evolve.upsert({ kind: 'lesson', trigger: '读取数据文件前', content: '先列目录确认真实文件名', source: 'user' })
  const c = consolidate(rt, { overlayIds: [oid], memoryIds: [item.id] })
  const cand = rt.genomes.load(c.genome)
  assert.equal(cand.status, 'candidate')
  assert.match(rt.genomes.text(cand.instructions.system), /写文件后先重读一遍[\s\S]*先列目录确认真实文件名/)
  assert.equal(rt.evolve.overlays(undefined, true).find((o) => o.id === oid)!.status, 'promoted')
  assert.throws(() => consolidate(rt, { overlayIds: [oid] }), /至少一项/)
  promote(rt, c.genome)
  assert.equal(rt.genomes.activeId(), c.genome)
  assert.ok(readFileSync(join(dir, cand.instructions.system), 'utf8').includes('经用户批准'))
})
