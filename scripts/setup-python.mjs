// Creates data/pyenv-<platform>-<arch> with the scientific stack used by the built-in tools.
// Prefers uv, which can provision a suitable Python itself; otherwise needs Python 3.10+ on PATH.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const venv = join(root, 'data', `pyenv-${process.platform}-${process.arch}`)
const venvPython = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const pkgs = readFileSync(join(root, 'scripts', 'requirements.txt'), 'utf8').split(/\r?\n/)
  .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
const MIN = [3, 10]

const run = (cmd, args) => { console.log(`$ ${cmd} ${args.join(' ')}`); execFileSync(cmd, args, { stdio: 'inherit', windowsHide: true }) }
const has = (cmd) => { try { execFileSync(cmd, ['--version'], { stdio: 'ignore', windowsHide: true }); return true } catch { return false } }
/** Version of a Python command as [major, minor], or undefined if it does not run. */
const version = (cmd) => {
  try {
    const out = execFileSync(cmd, ['-c', 'import sys; print("%d %d" % sys.version_info[:2])'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    return out.trim().split(' ').map(Number)
  } catch { return undefined }
}
const recent = (v) => !!v && (v[0] > MIN[0] || (v[0] === MIN[0] && v[1] >= MIN[1]))

// An environment built from an older interpreter cannot install the pinned stack; rebuild it.
if (existsSync(venv) && !recent(version(venvPython))) {
  console.log('现有环境的 Python 版本过旧，重新创建')
  rmSync(venv, { recursive: true, force: true })
}

if (has('uv')) {
  if (!existsSync(venv)) run('uv', ['venv', '--python', '3.12', venv])
  run('uv', ['pip', 'install', '--python', venvPython, ...pkgs])
} else {
  const candidates = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python']
  const python = candidates.find((cmd) => recent(version(cmd)))
  if (!python) {
    console.error('需要 Python 3.10 或更高版本。请安装 uv（https://docs.astral.sh/uv/）或新版 Python 后重试。')
    process.exit(1)
  }
  if (!existsSync(venv)) run(python, ['-m', 'venv', venv])
  run(venvPython, ['-m', 'pip', 'install', ...pkgs])
}
console.log('Python 环境就绪：' + venv)
