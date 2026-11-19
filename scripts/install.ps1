# EvoScholar one-step install for Windows (PowerShell).  Usage: powershell -ExecutionPolicy Bypass -File scripts\install.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$need = [version]'22.13.0'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "需要 Node.js >= $need：https://nodejs.org/ （或 winget install OpenJS.NodeJS.LTS）"; exit 1 }
$ver = [version](node -p "process.versions.node")
if ($ver -lt $need) { Write-Host "当前 Node.js $ver，需要 >= $need"; exit 1 }

Write-Host '==> 安装依赖'; npm ci; if ($LASTEXITCODE) { exit 1 }
Write-Host '==> 构建'; npm run build; if ($LASTEXITCODE) { exit 1 }
Write-Host '==> Python 环境（文献、数据处理和出图需要）'
if ((Get-Command uv -ErrorAction SilentlyContinue) -or (Get-Command python -ErrorAction SilentlyContinue)) {
  npm run setup:python
  if ($LASTEXITCODE) { Write-Host 'Python 环境没有装好，可以稍后重新运行：npm run setup:python' }
} else {
  Write-Host '没有找到 python 或 uv，跳过。装好 Python 3.10+（winget install Python.Python.3.12）后运行：npm run setup:python'
}
if (-not (Test-Path .env)) { Copy-Item .env.example .env }

Write-Host ''
Write-Host '完成。启动工作台：npm start   然后打开 http://127.0.0.1:4317'
Write-Host '第一次使用：在「设置 → 模型与密钥」里选厂商、填 API Key、获取模型。'
Write-Host '不想先填 Key：npm run demo 打开一个用本地脚本模拟的演示（不联网、不花钱）。'
