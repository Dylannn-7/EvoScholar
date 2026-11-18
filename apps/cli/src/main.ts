#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import {
  BudgetError,
  candidateDetail,
  checkFeedbackStats,
  feedbackEvents,
  readCheckReport,
  recordCheckFeedback,
  VERDICTS,
  evaluate,
  evolveRound,
  listCandidates,
  listProviders,
  promote,
  reject,
  renderDiff,
  rollback,
  openResearchSession,
  openRuntime,
  openWorkspace,
  type BudgetCategory,
  type Runtime
} from '@evoscholar/core'
import type { AgentEvent } from '@evoscholar/harness'

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

function printBudget(rt: Runtime) {
  const s = rt.ledger.summary()
  console.log(`总花费  ¥${s.totalCny.toFixed(4)} / ¥${s.capCny}`)
  if (s.reservedCny > 0) console.log(`待结算预留 ¥${s.reservedCny.toFixed(4)}`)
  for (const [k, v] of Object.entries(s.byCategory)) console.log(`  ${k.padEnd(10)} ¥${v.toFixed(4)} / ¥${s.categoryCaps[k as BudgetCategory]}`)
  console.log(`今日使用 ¥${s.usageTodayCny.toFixed(4)}（软上限 ¥${s.dailyUsageSoftCny}）  今日联网 ${s.webCallsToday}/${s.webCallsPerDay} 次`)
}

function streamPrinter() {
  return (e: AgentEvent) => {
    if (e.type !== 'model' || e.purpose === 'compaction') return
    const ev = e.event
    if (ev.type === 'text-delta') stdout.write(ev.text)
    else if (ev.type === 'finish' && ev.calls?.length)
      for (const c of ev.calls) stdout.write(dim(`\n↳ ${c.name} ${JSON.stringify(c.arguments).slice(0, 160)}\n`))
  }
}

async function chat(rt: Runtime, args: string[], oneShot?: string) {
  const category = (flag(args, 'category') ?? 'usage') as BudgetCategory
  const yes = args.includes('--yes')
  let rlRef: ReturnType<typeof createInterface> | undefined
  const approve = async (tool: string, summary: string) => {
    if (yes) return true
    if (!stdin.isTTY) { console.log(yellow(`\n已拒绝 ${tool}（非交互模式；加 --yes 自动允许）`)); return false }
    const rl = rlRef ?? createInterface({ input: stdin, output: stdout })
    const ans = (await rl.question(yellow(`\n需要确认 · ${tool}\n${summary}\n允许执行吗？[y/N] `))).trim().toLowerCase()
    if (!rlRef) rl.close()
    return ans === 'y' || ans === 'yes'
  }
  const rs = await openResearchSession(rt, {
    approve,
    cwd: flag(args, 'cwd'),
    sessionId: flag(args, 'session'),
    category,
    stage: flag(args, 'stage'),
    onEvent: streamPrinter(),
    onWarning: (m) => console.log(yellow(`\n⚠ ${m}`))
  })
  console.log(dim(`会话 ${rs.id} · genome ${rs.genome.id} · ${rs.genome.routing.roles.main} · 预算分类 ${category}`))
  const run = async (text: string) => {
    try {
      const { status } = await rs.ask(text)
      const s = rt.ledger.summary()
      console.log(dim(`\n[${status}] 累计 ¥${s.totalCny.toFixed(4)} / ¥${s.capCny}`))
    } catch (e) {
      console.log(yellow(`\n${e instanceof BudgetError ? '预算拦截' : '出错'}：${(e as Error).message}`))
    }
  }
  if (oneShot !== undefined) {
    await run(oneShot)
    await rs.dispose()
    return
  }
  const rl = createInterface({ input: stdin, output: stdout })
  rlRef = rl
  console.log(dim(`工作目录 ${rs.cwd}`))
  console.log(dim('输入问题开始对话。命令：/budget  /good  /bad 备注  /exit'))
  for (;;) {
    const line = (await rl.question(cyan('\n你 › '))).trim()
    if (!line) continue
    if (line === '/exit' || line === '/quit') break
    if (line === '/budget') { printBudget(rt); continue }
    if (line.startsWith('/good')) { rs.recorder.feedback('thumb', 1, line.slice(5).trim() || undefined); console.log(dim('已记录 👍')); continue }
    if (line.startsWith('/bad')) { rs.recorder.feedback('thumb', -1, line.slice(4).trim() || undefined); console.log(dim('已记录 👎')); continue }
    stdout.write(cyan('EvoScholar › '))
    await run(line)
  }
  rl.close()
  await rs.dispose()
}

const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`

function showCandidate(rt: Runtime, id: string) {
  const d = candidateDetail(rt, id)
  const c = d.candidate
  console.log(`${d.genome.id}  parent=${d.genome.parent ?? '-'}  status=${d.genome.status}${c ? `  候选状态=${c.status}` : ''}`)
  if (c) {
    console.log(`修改：${c.target}\n诊断：${c.diagnosis ?? ''}`)
    console.log(`开发集 ${c.base_dev_pass} → ${c.dev_pass} / ${c.dev_total}${c.acc_total ? `   验收集 ${c.base_acc_pass} → ${c.acc_pass} / ${c.acc_total}` : ''}   评测花费 ¥${(c.cost_cny ?? 0).toFixed(3)}`)
    console.log(`结论：${c.reason ?? ''}`)
  }
  for (const p of d.promptDiffs) {
    console.log(cyan(`\n── ${p.key}: ${p.from ?? '(默认)'} → ${p.to}`))
    for (const l of p.diff) console.log(l.op === '+' ? green(`+ ${l.text}`) : l.op === '-' ? red(`- ${l.text}`) : dim(`  ${l.text}`))
  }
  for (const s of d.skillDiffs) {
    console.log(cyan(`\n── 技能 ${s.key}: ${s.from ?? '新增'} → ${s.to ?? '移除'}`))
    console.log(renderDiff(s.diff))
  }
  if (d.workflowDiff.some((line) => line.op !== ' ')) {
    console.log(cyan('\n── 工作流'))
    console.log(renderDiff(d.workflowDiff))
  }
  console.log(cyan('\n── genome diff'))
  console.log(renderDiff(d.genomeDiff))
  const changed = d.cases.filter((x) => x.base !== x.cand)
  if (changed.length) {
    console.log(cyan('\n── 通过情况变化'))
    for (const x of changed) console.log(`  ${x.caseId} ${x.base === undefined ? '?' : x.base ? '✓' : '✗'} → ${x.cand === undefined ? '?' : x.cand ? green('✓') : red('✗')}`)
  }
}

async function main() {
  const [cmd = 'help', ...args] = process.argv.slice(2)
  const ws = openWorkspace()
  const rt = openRuntime(ws, (m) => console.log(yellow(`⚠ ${m}`)))
  switch (cmd) {
    case 'chat':
      return chat(rt, args)
    case 'ask': {
      const words = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')))
      if (!words.length) throw new Error('用法：evoscholar ask <问题>')
      return chat(rt, args, words.join(' '))
    }
    case 'budget':
      return printBudget(rt)
    case 'providers':
      for (const p of listProviders(ws.config))
        console.log(`${p.hasKey ? '✓' : '·'} ${p.id.padEnd(12)} ${p.label.padEnd(18)} ${p.protocols.join(',').padEnd(34)} ${p.apiKeyEnv}  ${p.models.map((m) => m.id + (m.vision ? '👁' : '')).slice(0, 4).join(' ')}`)
      return
    case 'genome': {
      const g = rt.genomes.load(args[0])
      console.log(`${g.id}（hash ${rt.genomes.hash(g)}）parent=${g.parent ?? '-'} status=${g.status}\n${g.note ?? ''}`)
      console.log(JSON.stringify({ roles: g.routing.roles, tools: g.tools.enabled, budgets: g.budgets }, null, 2))
      return
    }
    case 'eval': {
      const sel = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))) ?? 'development'
      const g = rt.genomes.load(flag(args, 'genome'))
      console.log(dim(`评测 ${g.id}（hash ${rt.genomes.hash(g)}）：${sel}`))
      const rs = await evaluate(rt, g, sel, {
        concurrency: Number(flag(args, 'concurrency') ?? 2),
        useCache: !args.includes('--no-cache'),
        category: flag(args, 'category') === 'dev' ? 'dev' : 'evolution',
        capCny: flag(args, 'cap') ? Number(flag(args, 'cap')) : undefined,
        onCase: (r) => console.log(`${r.caseId} ${r.pass ? green('✓') : red('✗')} ${r.cached ? dim('（缓存）') : dim(`${r.steps} 步 ¥${r.costCny.toFixed(3)}`)}${r.error ? yellow(` ${r.error}`) : ''}${!r.pass && r.failures.length ? dim(`  ${r.failures[0].slice(0, 100)}`) : ''}`)
      })
      console.log(`通过 ${rs.filter((r) => r.pass).length}/${rs.length}`)
      return printBudget(rt)
    }
    case 'evolve': {
      const rep = await evolveRound(rt, {
        dryRun: args.includes('--dry-run'),
        force: args.includes('--force'),
        concurrency: Number(flag(args, 'concurrency') ?? 2),
        maxCandidates: flag(args, 'candidates') ? Number(flag(args, 'candidates')) : undefined,
        onProgress: (m) => console.log(`${dim(new Date().toTimeString().slice(0, 8))} ${m}`)
      })
      console.log(`\n本轮 ${rep.runId}：${rep.status}，花费 ¥${rep.costCny.toFixed(3)}\n报告：${rep.reportPath}`)
      const pending = rep.candidates.find((c) => c.status === 'pending')
      if (pending) console.log(yellow(`候选 ${pending.genome} 待审批：es candidates ${pending.genome} 查看，es promote ${pending.genome} 上线`))
      return
    }
    case 'candidates': {
      if (args[0]) return showCandidate(rt, args[0])
      const rows = listCandidates(rt)
      if (!rows.length) return console.log('还没有候选版本')
      for (const c of rows)
        console.log(`${c.genome_id}  ${c.status.padEnd(9)} ${c.target.padEnd(22)} 开发 ${c.base_dev_pass}→${c.dev_pass ?? '?'}/${c.dev_total}  ${c.acc_total ? `验收 ${c.base_acc_pass}→${c.acc_pass}/${c.acc_total}  ` : ''}${dim(c.reason ?? '')}`)
      return
    }
    case 'mark': {
      const [file, ids, verdict, ...note] = args
      if (!file || !ids || !VERDICTS[verdict ?? '']) throw new Error('用法：es mark <report.json> <F001,F003> <valid|fp|unsure> [原因]')
      const { events, missing } = feedbackEvents(readCheckReport(file), ids.split(','), VERDICTS[verdict], note.join(' ') || undefined)
      recordCheckFeedback(rt, events)
      console.log(`已记录 ${events.length} 条${missing.length ? `；报告里没有：${missing.join(', ')}` : ''}`)
      return
    }
    case 'check-stats': {
      const rows = checkFeedbackStats(rt)
      if (!rows.length) return console.log('还没有标记过稿件检查结果')
      const tot = rows.reduce((a, r) => ({ v: a.v + r.valid, f: a.f + r.false_positive }), { v: 0, f: 0 })
      console.log(`总计：有效 ${tot.v}，误报 ${tot.f}，误报率 ${tot.v + tot.f ? ((tot.f / (tot.v + tot.f)) * 100).toFixed(1) : '-'}%`)
      for (const r of rows) console.log(`  ${r.rule.padEnd(40)} 有效 ${String(r.valid).padStart(3)}  误报 ${String(r.false_positive).padStart(3)}  不确定 ${String(r.unsure).padStart(3)}  误报率 ${r.fp_rate === null ? '  -' : `${(r.fp_rate * 100).toFixed(0)}%`}`)
      return
    }
    case 'promote': {
      if (!args[0]) throw new Error('用法：es promote <genome-id>')
      const g = promote(rt, args[0])
      return console.log(green(`已上线 ${g.id}（父版本 ${g.parent} 已归档；es rollback 可回滚）`))
    }
    case 'reject': {
      if (!args[0]) throw new Error('用法：es reject <genome-id> [原因]')
      reject(rt, args[0], args.slice(1).join(' ') || undefined)
      return console.log(`已拒绝 ${args[0]}`)
    }
    case 'rollback': {
      const g = rollback(rt, args[0])
      return console.log(green(`已回滚，当前上线 ${g.id}`))
    }
    default:
      console.log(`用法：evoscholar <命令>
  chat [--category usage|dev] [--session ID] [--cwd DIR] [--yes]   交互式对话
  ask  <问题> [--category dev] [--cwd DIR] [--yes]                  单轮提问（--yes 自动允许执行代码）
  budget                                                        查看 API 花费与预算
  providers                                                     查看模型厂商与 Key 状态
  genome [ID]                                                   查看当前 harness genome
  eval [development|acceptance|all|L01,D02] [--genome ID] [--no-cache] [--category dev] [--cap 元]   跑评测集（默认计入 evolution 预算，每次 ≤ 每轮上限）
  evolve [--dry-run] [--force] [--candidates N] [--concurrency N]       跑一轮进化（--force 忽略高峰与每日轮数）
  candidates [ID]                                               候选列表 / 某个候选的 diff 和逐题变化
  promote <ID> · reject <ID> [原因] · rollback [ID]             上线 / 拒绝 / 回滚
  mark <report.json> <F001,F003> <valid|fp|unsure> [原因]          标记稿件检查结果有效 / 误报
  check-stats                                                   各规则的误报率`)
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
