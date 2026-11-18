// Creates data/pyenv with the scientific stack used by run_python. Uses uv when available.
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
const root = process.cwd()
const venv = join(root, 'data', `pyenv-${process.platform}-${process.arch}`)
const pkgs = 'numpy pandas scipy matplotlib scienceplots python-docx bibtexparser pymupdf openpyxl'
const has = (cmd) => { try { execSync(`${cmd} --version`, { stdio: 'ignore' }); return true } catch { return false } }
const sh = (cmd) => { console.log('$ ' + cmd); execSync(cmd, { stdio: 'inherit' }) }
if (has('uv')) {
  if (!existsSync(venv)) sh(`uv venv "${venv}"`)
  sh(`uv pip install --python "${join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')}" ${pkgs}`)
} else {
  const py = has('python3') ? 'python3' : 'python'
  if (!existsSync(venv)) sh(`${py} -m venv "${venv}"`)
  const pip = join(venv, process.platform === 'win32' ? 'Scripts/pip' : 'bin/pip')
  sh(`"${pip}" install ${pkgs}`)
}
console.log('Python 环境就绪：' + venv)
