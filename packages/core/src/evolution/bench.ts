import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type BenchCase = {
  id: string
  title: string
  category: 'literature' | 'data' | 'writing' | string
  default_split: 'development' | 'acceptance'
  phases: number
  trace: boolean
  manual_review: boolean
}
export type Grade = { id: string; phase: number; machine_status: 'pass' | 'fail'; failures: string[]; manual_review: string[] }

/** Thin adapter over the user's private evals/bench.py (stdlib-only Python). */
export class Bench {
  readonly dir: string
  constructor(root: string, readonly python = process.env.EVOSCHOLAR_BENCH_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')) {
    this.dir = join(root, 'evals')
  }
  available(): boolean {
    return existsSync(join(this.dir, 'bench.py')) && existsSync(join(this.dir, 'manifest.json'))
  }
  cases(split?: 'development' | 'acceptance'): BenchCase[] {
    const m = JSON.parse(readFileSync(join(this.dir, 'manifest.json'), 'utf8')) as { cases: BenchCase[] }
    return m.cases.filter((c) => !split || c.default_split === split)
  }
  private run(args: string[]): Promise<{ code: number; out: string; err: string }> {
    return new Promise((resolve) => {
      const p = spawn(this.python, [join(this.dir, 'bench.py'), ...args], { cwd: this.dir, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      p.stdout.on('data', (b) => (out += b))
      p.stderr.on('data', (b) => (err += b))
      p.on('close', (code) => resolve({ code: code ?? 2, out, err }))
      p.on('error', (e) => resolve({ code: 2, out, err: e.message }))
    })
  }
  async prepare(id: string, dir: string): Promise<void> {
    const r = await this.run(['prepare', id, dir])
    if (r.code !== 0) throw new Error(`bench prepare ${id} 失败：${r.err || r.out}`)
  }
  async advance(dir: string): Promise<void> {
    const r = await this.run(['advance', dir])
    if (r.code !== 0) throw new Error(`bench advance 失败：${r.err || r.out}`)
  }
  async grade(dir: string): Promise<Grade> {
    const r = await this.run(['grade', dir])
    if (r.code === 2) throw new Error(`bench grade 配置错误：${r.err || r.out}`)
    const start = r.out.indexOf('{')
    return JSON.parse(r.out.slice(start)) as Grade
  }
}
