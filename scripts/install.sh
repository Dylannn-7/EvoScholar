#!/usr/bin/env sh
# EvoScholar one-step install for macOS / Linux.  Usage: sh scripts/install.sh
set -e
cd "$(dirname "$0")/.."

need_node="22.13.0"
if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js >= $need_node：https://nodejs.org/ （或 brew install node / nvm install 22）"; exit 1
fi
ver=$(node -p 'process.versions.node')
if [ "$(printf '%s\n%s\n' "$need_node" "$ver" | sort -V | head -n1)" != "$need_node" ]; then
  echo "当前 Node.js $ver，需要 >= $need_node"; exit 1
fi

echo "==> 安装依赖"; npm ci
echo "==> 构建";     npm run build
echo "==> Python 环境（文献、数据处理和出图需要）"
if command -v uv >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1; then
  npm run setup:python || echo "Python 环境没有装好，可以稍后重新运行：npm run setup:python"
else
  echo "没有找到 python3 或 uv，跳过。装好 Python 3.10+ 后运行：npm run setup:python"
fi
[ -f .env ] || cp .env.example .env

echo ""
echo "完成。启动工作台：npm start   然后打开 http://127.0.0.1:4317"
echo "第一次使用：在「设置 → 模型与密钥」里选厂商、填 API Key、获取模型。"
echo "不想先填 Key：npm run demo 打开一个用本地脚本模拟的演示（不联网、不花钱）。"
