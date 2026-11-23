import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import {
  checkKernelCode, consolidate, fetchGithubSkill, installSkillFiles, kernelTools, openRuntime, openWorkspace, parseGithubUrl,
  promote, readFolder, readUserRules, readZip, recordCandidateVerification, setSkillEnabled, skillSource, verifyCandidateOffline,
  kernelIndex, readSkillText, rollbackKernel, setKernelEnabled, setSkillTrusted, skillDetail, skillUntrusted, TOOL_FACTORIES,
  listStyles, stylePreview, PREVIEW_VERSION,
  type ExecutionBackend, type ToolEnv
} from './index'

const REPO = resolve(__dirname, '../../..')
function ws() {
  const dir = mkdtempSync(join(tmpdir(), 'evo-p4-'))
  for (const d of ['genomes', 'prompts', 'skills']) cpSync(join(REPO, d), join(dir, d), { recursive: true })
  cpSync(join(REPO, 'evoscholar.config.json'), join(dir, 'evoscholar.config.json'))
  mkdirSync(join(dir, 'data'))
  const kind = process.platform === 'win32' ? 'junction' : 'dir'
  symlinkSync(join(REPO, 'python'), join(dir, 'python'), kind)
  const venv = join(REPO, 'data', `pyenv-${process.platform}-${process.arch}`)
  if (existsSync(venv)) symlinkSync(venv, join(dir, 'data', `pyenv-${process.platform}-${process.arch}`), kind)
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

test('forged skills need approval after two successful reuses; patch_skill and propose_rule', async (t) => {
  const dir = ws()
  const rt = openRuntime(openWorkspace(dir))
  t.after(() => { rt.db.close(); rmSync(dir, { recursive: true, force: true }) })
  const cwd = mkdtempSync(join(tmpdir(), 'evo-kernel-project-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  writeFileSync(join(cwd, 'm.csv'), 'a,b\n1,2\n3,4\n')
  const events: { kind: string; text: string }[] = []
  const executor: ExecutionBackend = {
    available: async () => true,
    start: async () => { throw new Error('Unexpected daemon') },
    run: async (_env, job) => {
      assert.ok(job.skillDir)
      const verify = job.emptyWorkspace
      assert.ok(job.sandbox.some((arg) => arg.startsWith('/control/skill')))
      const fail = verify && readFileSync(join(job.skillDir, 'test_kernel.py'), 'utf8').includes('3.0')
      const revised = readFileSync(join(job.skillDir, 'kernel.py'), 'utf8').includes('# revision two')
      const out = verify ? (fail ? 'fixture mismatch' : '__EVO_PASS__ 1') : `__EVO_RESULT__{"n": 2, "sum_b": 6.0, "revised": ${revised}}`
      return { code: fail ? 1 : 0, signal: null, out, stdout: out, timedOut: false }
    }
  }
  const make = (sid: string, approve?: ToolEnv['approve'], projectId = 'a') => {
    const env: ToolEnv = { ws: rt.ws, cwd, projectId, ledger: rt.ledger, category: () => 'dev', approve, executor }
    const tools = [TOOL_FACTORIES.read_skill(env), ...kernelTools({ store: rt.evolve, sessionId: sid, env, emit: (e) => events.push(e), addOverlay: (op, target, value, reason) => rt.evolve.addOverlay({ sessionId: sid, op, target, value, reason }) })]
    return (name: string, args: unknown) => tools.find((x) => x.name === name)!.execute(args as never, {} as never) as Promise<{ content: { type: string; text?: string }[]; isError?: boolean }>
  }
  const a = make('s-a')
  const code = 'import csv\n\ndef run(path):\n    rows = list(csv.DictReader(open(path)))\n    return {"n": len(rows), "sum_b": sum(float(r["b"]) for r in rows)}\n'
  const testCode = 'import os\nfrom kernel import run\n\ndef test_sum():\n    open("t.csv", "w").write("a,b\\n1,2\\n")\n    assert run("t.csv") == {"n": 1, "sum_b": 2.0}\n'
  const forge = { name: 'csv-sum', description: '读 CSV 并对 b 列求和', code, test: testCode,
    input_format: { argument: 'path', extension: '.csv', header: ['a,b'] } }
  const args = { name: forge.name, version: 1, args: { path: 'm.csv' } }
  const bad = await a('forge_skill', { ...forge, test: testCode.replace('2.0', '3.0') })
  assert.equal(bad.isError, true)
  assert.match(text(bad), /测试没有通过/)
  const blocked = await a('forge_skill', { ...forge, code: 'import subprocess\ndef run():\n    pass', test: 'def test_a():\n    pass' })
  assert.match(text(blocked), /静态检查不通过/)
  const ok = await a('forge_skill', forge)
  assert.equal(ok.isError, undefined, text(ok))
  assert.equal(skillSource(dir, 'csv-sum').status, 'trial')
  assert.match(kernelIndex(dir, 'project:a'), /csv-sum v1（试用）/)
  assert.doesNotMatch(kernelIndex(dir, 'project:b'), /csv-sum/)
  const outside = make('s-x', undefined, 'b')
  assert.equal((await outside('run_skill', args)).isError, true)
  assert.equal((await outside('read_skill', { name: forge.name, version: 1 })).isError, true)
  assert.equal((await outside('forge_skill', forge)).isError, true)
  assert.match(text(await a('run_skill', { ...args, version: undefined })), /须指定有效的 version/)
  assert.match(text(await a('run_skill', args)), /"sum_b": 6\.0/)
  assert.equal(skillSource(dir, 'csv-sum').status, 'trial', 'reuse in the forging session does not count')
  await make('s-b')('run_skill', args)
  await make('s-c')('run_skill', args)
  assert.equal(skillSource(dir, 'csv-sum').status, 'trial', 'unattended reuse never promotes a skill')
  const approvals: string[] = []
  const accept = async (tool: string, _summary: string, kind?: string) => {
    approvals.push(`${tool}/${kind}`)
    return true
  }
  await make('s-c', accept)('run_skill', args)
  assert.deepEqual(approvals, ['run_skill/evolution'])
  assert.equal(skillSource(dir, 'csv-sum').status, 'active')
  assert.ok(events.some((e) => e.kind === 'learned' && /转正/.test(e.text)))
  assert.equal((await a('forge_skill', { ...forge, code: `# revision two\n${code}` })).isError, undefined)
  assert.match(kernelIndex(dir, 'project:a'), /csv-sum v1（生效）[\s\S]*csv-sum v2（试用）/)
  assert.match(text(await a('run_skill', args)), /"revised": false/)
  const args2 = { ...args, version: 2 }
  assert.match(text(await a('run_skill', args2)), /"revised": true/)
  assert.match(text(await a('read_skill', { name: forge.name, version: 2, file: 'kernel.py' })), /^# revision two/)
  assert.throws(() => rollbackKernel(rt, forge.name, 2), /已批准/)
  await make('s-b')('run_skill', args2)
  await make('s-c', accept)('run_skill', args2)
  assert.equal(skillSource(dir, forge.name).releases?.active, 2)
  assert.equal((await a('run_skill', args)).isError, true, 'an inactive version cannot silently resolve to v2')
  rollbackKernel(rt, forge.name, 1)
  assert.equal(skillDetail(dir, forge.name)?.kernel?.['kernel.py'], code)
  assert.equal((await a('run_skill', args2)).isError, true)
  assert.match(text(await a('run_skill', args)), /"revised": false/)

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

test('scoped spectral operator transfers to held-out spectra and preserves the normal-spectrum result', { timeout: 90000 }, async (t) => {
  const dir = ws()
  const cwd = mkdtempSync(join(tmpdir(), 'evo-spectral-holdout-'))
  const rt = openRuntime(openWorkspace(dir))
  const sessions = new Set<string>()
  t.after(async () => {
    try { await Promise.allSettled([...sessions].map((id) => rt.executor.disposeSession?.(id))) }
    finally { rt.db.close(); rmSync(dir, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }) }
  })
  if (!(await rt.executor.available())) return t.skip('Linux sandbox image unavailable')
  const name = 'instrument-spectrum'
  const header = ['Lab Spectrometer,Export 2', 'Wavelength,Signal', 'nm,linear a.u.']
  const training = header.join('\n') + '\n1549.8,0.17\n1549.9,0.67\n1550.0,1.17\n1550.1,0.67\n1550.2,0.17\n'
  const metrics = `
import numpy as np
import evoscholar_data as D

def measure(x, y):
    peak = D.find_peaks(x, y, n=1)[0]
    result = D.fwhm(x, y, index=peak['index'], baseline=0.17)
    return {'center_nm': result['center'], 'fwhm_nm': result['fwhm']}
`
  const traces: Record<string, unknown>[] = []
  const evolution: Parameters<Parameters<typeof kernelTools>[0]['emit']>[0][] = []
  const envFor = (sessionId: string, projectId = 'spectra') => ({
    ws: rt.ws, cwd, sessionId, projectId, ledger: rt.ledger, category: () => 'dev' as const,
    executor: rt.executor, trace: (event: Record<string, unknown>) => traces.push(event)
  })
  const call = async (env: ToolEnv & { sessionId: string }, toolName: string, input: Record<string, unknown>) => {
    sessions.add(env.sessionId)
    const tool = toolName === 'run_python' ? TOOL_FACTORIES.run_python(env)
      : kernelTools({ store: rt.evolve, env, sessionId: env.sessionId, emit: (e) => evolution.push(e), addOverlay: () => '' }).find((entry) => entry.name === toolName)!
    const result = await tool.execute(tool.validate!(input as never), { signal: AbortSignal.timeout(30000) } as never)
    assert.ok('content' in result)
    return { error: result.isError, text: text(result) }
  }
  writeFileSync(join(cwd, 'training.csv'), training)
  const originalFailure = await call(envFor('spec-original'), 'run_python', {
    code: "import numpy as np\nnp.loadtxt('training.csv', delimiter=',', skiprows=1, unpack=True)"
  })
  assert.ok(originalFailure.error)
  assert.match(originalFailure.text, /ValueError:.*'Wavelength'/)

  const code = `${metrics}\ndef run(path):\n    x, y = np.loadtxt(path, delimiter=',', skiprows=3, unpack=True)\n    return measure(x, y)\n`
  const testCode = `
from pathlib import Path
from kernel import run

def test_training_fixture():
    Path('training.csv').write_text(${JSON.stringify(training)})
    result = run('training.csv')
    assert result['center_nm'] == 1550.0
    assert abs(result['fwhm_nm'] - 0.2) < 1e-9
`
  const forge = await call(envFor('spec-forge'), 'forge_skill', {
    name, description: '读取指定仪器导出的波长和线性信号，测量主峰及半高全宽',
    input_format: { argument: 'path', extension: '.csv', header }, code, test: testCode
  })
  assert.ok(!forge.error, forge.text)
  assert.match(forge.text, /v1/)
  const spectra = [
    { file: 'held-a.csv', center: 1550.205, width: 0.118, headers: header },
    { file: 'held-b.csv', center: 1549.875, width: 0.196, headers: header },
    { file: 'normal.csv', center: 1550.045, width: 0.084, headers: header },
    { file: 'plain.csv', center: 1550.045, width: 0.084, headers: ['wavelength_nm,signal_au'] }
  ]
  for (const { file, center, width, headers } of spectra) {
    const points = Array.from({ length: 481 }, (_, i) => {
      const x = 1549.4 + i * 0.0025
      const y = 0.17 + 0.7 * Math.exp(-4 * Math.log(2) * ((x - center) / width) ** 2)
      return `${x.toFixed(6)},${y.toFixed(12)}`
    })
    writeFileSync(join(cwd, file), [...headers, ...points, ''].join('\n'))
  }
  const originals = spectra.map(({ file }) => readFileSync(join(cwd, file)))
  const baseline = await call(envFor('spec-baseline'), 'run_python', { code: `
import json
${metrics}
def reference(path, rows):
    return measure(*np.loadtxt(path, delimiter=',', skiprows=rows, unpack=True))
results = {}
for path in ('held-a.csv', 'held-b.csv'):
    try:
        results[path] = reference(path, 1)
    except ValueError as error:
        results[path] = {'error': type(error).__name__, 'message': str(error)}
results['normal'] = reference('normal.csv', 3)
results['plain'] = reference('plain.csv', 1)
print('BASELINE=' + json.dumps(results))` })
  assert.ok(!baseline.error, baseline.text)
  const before = JSON.parse(/^BASELINE=(.*)$/m.exec(baseline.text)![1])
  const results = []
  const runRecords = []
  for (const [i, { file, center, width }] of spectra.slice(0, 3).entries()) {
    const result = await call(envFor(`spec-run-${i}`), 'run_skill', { name, version: 1, args: { path: file } })
    assert.ok(!result.error, result.text)
    const observed = JSON.parse(/^结果：(.*)$/m.exec(result.text)![1])
    assert.ok(Math.abs(observed.center_nm - center) <= 0.00125, JSON.stringify(observed))
    assert.ok(Math.abs(observed.fwhm_nm - width) <= 0.001, JSON.stringify(observed))
    results.push({ file, ...observed })
    runRecords.push({
      id: `spec-run-${i}`, label: file, text: result.text,
      data: { expected: { center_nm: center, fwhm_nm: width }, tolerance_nm: { center: 0.00125, fwhm: 0.001 },
        trace: traces.at(-1) }
    })
  }
  assert.equal(before['held-a.csv'].error, 'ValueError')
  assert.equal(before['held-b.csv'].error, 'ValueError')
  assert.deepEqual(before.normal, before.plain)
  assert.deepEqual(results[2], { file: 'normal.csv', ...before.normal })
  const mismatch = await call(envFor('spec-format'), 'run_skill', { name, version: 1, args: { path: 'plain.csv' } })
  assert.equal(mismatch.error, true)
  assert.match(mismatch.text, /文件表头不匹配/)
  const outOfProject = await call(envFor('spec-other-project', 'other'), 'run_skill', { name, version: 1, args: { path: 'held-a.csv' } })
  assert.equal(outOfProject.error, true)
  assert.equal(traces.filter((e) => e.kind === 'kernel.run' && e.version === 1 && e.ok).length, 3)
  const source = skillSource(dir, name)
  assert.equal(source.status, 'trial')
  assert.deepEqual(spectra.map(({ file }) => readFileSync(join(cwd, file))), originals)
  const heldOut = ['held-a.csv', 'held-b.csv']
  const ordinaryCsvHeldOutPasses = heldOut.filter(file => !before[file].error).length
  const scopedOperatorHeldOutPasses = results.filter(result => heldOut.includes(result.file)).length
  t.diagnostic(JSON.stringify({ ordinaryCsvHeldOutPasses, scopedOperatorHeldOutPasses, results, normalReference: before.normal }))
  const evidenceFile = process.env.EVOSCHOLAR_SPECTRAL_EVIDENCE
  if (evidenceFile) writeFileSync(evidenceFile, JSON.stringify({
    title: '光谱算子迁移验证', badge: '合成光谱样例', recordedAt: new Date().toISOString(),
    summaries: {
      trigger: '单表头 CSV 读取在波长列名处报 ValueError',
      version: `${name} v${source.releases?.trial}，试用 · 待人工批准`,
      result: `留出通过 ${ordinaryCsvHeldOutPasses}/${heldOut.length} → ${scopedOperatorHeldOutPasses}/${heldOut.length}，正常谱峰位和线宽一致`
    },
    records: {
      trigger: [{ id: 'spec-original', label: '训练样本的首次读取报错', text: originalFailure.text, data: { input: 'training.csv', firstLines: header, skiprows: 1 } }],
      version: [
        { id: 'spec-forge', label: '锻造与沙箱测试', text: forge.text, data: evolution[0] },
        { id: 'spec-release', label: '版本与审批状态', data: source },
        { id: 'kernel.py', label: 'v1 源码', text: code },
        { id: 'test_kernel.py', label: 'v1 的训练样本测试', text: testCode }
      ],
      result: [
        { id: 'spec-baseline', label: '留出基线与正常谱参考值', text: baseline.text },
        ...runRecords,
        { id: 'spec-format', label: '异格式正常谱', text: mismatch.text },
        { id: 'spec-other-project', label: '跨项目调用', text: outOfProject.text },
        { id: 'spec-integrity', label: '原始文件检查', data: { byteIdentical: true, files: spectra.map(({ file }) => file) } }
      ]
    }
  }, null, 2) + '\n')
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
  const sha = 'a'.repeat(40)
  const treeSha = 'b'.repeat(40)
  const gh = (async (url: string, init?: RequestInit) => {
    assert.equal(init?.redirect, 'error')
    if (url.endsWith('/commits/main')) return Response.json({ sha, commit: { tree: { sha: treeSha } } })
    if (url.endsWith('/repos/o/r')) return Response.json({ default_branch: 'main' })
    if (url.includes(`/git/trees/${treeSha}?`)) return Response.json({ tree: [{ path: 'skills/foo/SKILL.md', type: 'blob', mode: '100644' }, { path: 'skills/foo/references/x.md', type: 'blob', mode: '100644' }, { path: 'other/SKILL.md', type: 'blob', mode: '100644' }] })
    assert.match(url, new RegExp(sha))
    if (url.endsWith('skills/foo/SKILL.md')) return new Response(skillMd('foo'))
    if (url.endsWith('references/x.md')) return new Response('x')
    if (url.endsWith('/LICENSE')) return new Response('MIT License')
    return new Response('', { status: 404 })
  }) as unknown as typeof fetch
  const fetched = await fetchGithubSkill('https://github.com/o/r/tree/main/skills/foo', gh)
  assert.match(fetched.origin, new RegExp(sha))
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
  assert.throws(() => promote(rt, c.genome), /未通过离线验证/)
  promote(rt, c.genome, { confirmUnverified: true })
  assert.equal(rt.genomes.activeId(), c.genome)
  assert.ok(readFileSync(join(dir, cand.instructions.system), 'utf8').includes('经用户批准'))
})

test('consolidated candidates require offline loopback gateway for verification and record evidence', async (t) => {
  const dir = ws()
  const rt = openRuntime(openWorkspace(dir))
  t.after(() => { rt.db.close(); rmSync(dir, { recursive: true, force: true }) })
  const oid = rt.evolve.addOverlay({ sessionId: 's-ver', op: 'prompt.note', value: '输出 JSON 保持数值类型', reason: 'test' })
  rt.evolve.setOverlay(oid, 'kept', 0.9)
  const c = consolidate(rt, { overlayIds: [oid] })
  // Remote default endpoint is refused by offline verifier.
  await assert.rejects(() => verifyCandidateOffline(rt, c.genome), /离线 mock 网关/)
  // Recording offline verification evidence allows promotion without confirmUnverified.
  recordCandidateVerification(rt, c.genome, { runId: 'verify-offline-1', pass: 3, total: 3, scope: '公开示例评测集（3 题）' })
  promote(rt, c.genome)
  assert.equal(rt.genomes.activeId(), c.genome)
})

test('folder imports skip linked directories and enforce the input byte limit', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'evo-import-'))
  const sibling = mkdtempSync(join(tmpdir(), 'evo-import-sibling-'))
  t.after(() => {
    rmSync(folder, { recursive: true, force: true })
    rmSync(sibling, { recursive: true, force: true })
  })
  writeFileSync(join(folder, 'SKILL.md'), '---\nname: sample\ndescription: Sample\n---\n')
  writeFileSync(join(sibling, 'note.md'), 'fixture')
  symlinkSync(sibling, join(folder, 'reference'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.deepEqual([...readFolder(folder).keys()], ['SKILL.md'])
  writeFileSync(join(folder, 'large.md'), Buffer.alloc(8 * 1024 * 1024))
  assert.throws(() => readFolder(folder), /太大/)
})

test('approval requires a pending candidate record after an interrupted write', (t) => {
  const dir = ws()
  const rt = openRuntime(openWorkspace(dir))
  t.after(() => { rt.db.close(); rmSync(dir, { recursive: true, force: true }) })
  const active = rt.genomes.load()
  const candidate = { ...active, id: rt.genomes.nextId(), parent: active.id, createdBy: 'consolidate/manual', status: 'candidate' as const }
  rt.genomes.save(candidate)
  assert.throws(() => promote(rt, candidate.id), /缺少.*记录/)
  assert.equal(rt.genomes.activeId(), active.id)
})

test('bundled and trusted skills do not taint memories; forged skills can be switched off; detail is readable', (t) => {
  const dir = ws()
  const rt = openRuntime(openWorkspace(dir))
  t.after(() => { rt.db.close(); rmSync(dir, { recursive: true, force: true }) })
  // Skills shipped with the app are reviewed with each release.
  assert.equal(skillSource(dir, 'matplotlib').bundled, true)
  assert.equal(skillUntrusted(skillSource(dir, 'matplotlib')), false)
  assert.throws(() => setSkillTrusted(rt, 'matplotlib', false), /只有导入的技能/)
  assert.throws(() => setSkillTrusted(rt, 'data-tables', true), /只有导入的技能/)
  // A user import stays untrusted until the user vouches for it.
  const files = (o: Record<string, string>) => new Map(Object.entries(o).map(([k, v]) => [k, Buffer.from(v)]))
  installSkillFiles(dir, files({ 'SKILL.md': '---\nname: third-party\ndescription: x\n---\nbody', 'scripts/run.py': 'print(1)' }), { type: 'zip', importedAt: new Date().toISOString() })
  writeFileSync(join(dir, 'skills', 'third-party', 'bin.dat'), 'x')
  assert.equal(skillUntrusted(skillSource(dir, 'third-party')), true)
  setSkillTrusted(rt, 'third-party', true)
  assert.equal(skillUntrusted(skillSource(dir, 'third-party')), false)
  const detail = skillDetail(dir, 'third-party')!
  assert.match(detail.body, /body/)
  assert.deepEqual(detail.files.map((f) => [f.path, f.text]), [['bin.dat', false], ['scripts/run.py', true]])
  assert.equal(readSkillText(dir, 'third-party', 'scripts/run.py'), 'print(1)')
  assert.throws(() => readSkillText(dir, 'third-party', 'bin.dat'), /文本文件/)
  assert.throws(() => readSkillText(dir, 'third-party', '../matplotlib/SKILL.md'))
  // Forged skills: switched off, they leave the model's list and run_skill refuses them.
  installSkillFiles(dir, files({ 'SKILL.md': '---\nname: fit-peaks\ndescription: 拟合峰\n---\n', 'kernel.py': 'def run():\n    return 1\n', 'test_kernel.py': 'def test_run():\n    pass\n' }), { type: 'forged', kernel: true, status: 'active' })
  assert.match(kernelIndex(dir, 'project:a'), /fit-peaks v1（生效）/)
  assert.equal(skillDetail(dir, 'fit-peaks')!.kernel!['kernel.py'], 'def run():\n    return 1\n')
  setKernelEnabled(rt, 'fit-peaks', false)
  assert.equal(kernelIndex(dir, 'project:a'), '')
  assert.throws(() => setKernelEnabled(rt, 'third-party', false), /锻造/)
})

test('every figure style has a bundled preview for the current preview version', async (t) => {
  const dir = ws()
  cpSync(join(REPO, 'assets'), join(dir, 'assets'), { recursive: true })
  const rt = openRuntime(openWorkspace(dir))
  t.after(() => { rt.db.close(); rmSync(dir, { recursive: true, force: true }) })
  const styles = await listStyles(rt) as { id: string }[]
  assert.ok(styles.length >= 20)
  for (const s of styles) {
    const path = await stylePreview(rt, s.id)
    assert.equal(path, join(dir, 'assets', 'style-previews', PREVIEW_VERSION, `${s.id}.png`), `bundled preview for ${s.id}`)
  }
})
