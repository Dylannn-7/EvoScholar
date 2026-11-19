#!/usr/bin/env node
// Build the offline Linux image used for model-authored code (run_python, run_command,
// start_process, executable skills).  Usage: npm run sandbox:build
//   EVOSCHOLAR_ENGINE=podman       container command (default: docker)
//   EVOSCHOLAR_IMAGE=name:tag       image tag (default: evoscholar-sandbox:1)
//   BASE_IMAGE / DEBIAN_MIRROR / PIP_INDEX_URL   forwarded as build args (mirrors)
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const engine = process.env.EVOSCHOLAR_ENGINE || 'docker'
const image = process.env.EVOSCHOLAR_IMAGE || 'evoscholar-sandbox:1'
if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(engine)) { console.error('EVOSCHOLAR_ENGINE 只能是 PATH 中的命令名'); process.exit(2) }

const info = spawnSync(engine, ['info', '--format', '{{.OSType}}'], { encoding: 'utf8', windowsHide: true })
if (info.error || info.status !== 0) {
  console.error(`无法连接容器引擎（${engine}）。请先启动 Docker Desktop 或兼容引擎，再重试。`)
  process.exit(1)
}
if (info.stdout.trim() && info.stdout.trim() !== 'linux') {
  console.error('容器引擎当前处于 Windows 容器模式，请切换到 Linux 容器后重试。')
  process.exit(1)
}

const args = ['build', '-f', join('sandbox', 'Dockerfile'), '-t', image]
for (const name of ['BASE_IMAGE', 'DEBIAN_MIRROR', 'PIP_INDEX_URL']) {
  if (process.env[name]) args.push('--build-arg', `${name}=${process.env[name]}`)
}
args.push('.')
console.log(`==> ${engine} ${args.join(' ')}`)
const build = spawnSync(engine, args, { cwd: root, stdio: 'inherit', windowsHide: true })
if (build.status !== 0) {
  console.error('镜像构建失败。网络受限时可设置 DEBIAN_MIRROR、PIP_INDEX_URL 或 BASE_IMAGE 指向镜像源；')
  console.error(`也可以在能联网的机器上构建后用 ${engine} save / ${engine} load 离线导入。`)
  process.exit(build.status ?? 1)
}
console.log(`完成。镜像 ${image} 已就绪，重启工作台后模型代码将在离线容器中运行。`)
