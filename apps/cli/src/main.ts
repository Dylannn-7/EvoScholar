#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import {
  BudgetError,
  listProviders,
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
    default:
      console.log(`用法：evoscholar <命令>
  chat [--category usage|dev] [--session ID] [--cwd DIR] [--yes]   交互式对话
  ask  <问题> [--category dev] [--cwd DIR] [--yes]                  单轮提问（--yes 自动允许执行代码）
  budget                                                        查看 API 花费与预算
  providers                                                     查看模型厂商与 Key 状态
  genome [ID]                                                   查看当前 harness genome`)
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
