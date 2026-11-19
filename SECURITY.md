# 安全说明

EvoScholar 是运行在你自己电脑上的单用户应用。下面说明它信任什么、隔离什么，以及目前已知的限制。

[English summary](#english-summary)

## 本机接口

- 工作台只监听 `127.0.0.1`，并检查 Host 和 Origin，网页无法跨站调用。
- 每次启动都会签发新的令牌，所有接口（包括事件流、预览和下载）都要求这个令牌。本机其他程序只知道端口也调不通。
- 桌面版由应用自己把令牌附加到窗口发出的请求上，没有配对步骤；文件预览里的内容拿不到令牌。从源码用 `npm start` 运行时，浏览器通过一次性配对码取得令牌。
- 同一个系统账户下能控制你的浏览器、读取进程内存的程序，仍在信任范围之内。

## 模型写的代码

- 默认在离线 Linux 容器里运行：没有网络、根文件系统只读、非 root 用户、移除全部 capabilities，并限制进程数、内存、CPU 和运行时间。
- 容器只看到项目的工作副本（不含 `.env`、`.git` 和隐藏文件），产出只写回 `evoscholar-out/<会话>/`，不会直接改动原文件。
- 容器不挂载 Docker 套接字、应用目录、数据目录或用户主目录。
- **宿主模式**是可选的退路：没有 Docker 时，代码会以你的账户权限运行，可以读写项目之外的文件。它默认关闭，开启需要确认，每次执行都要你批准，并且在完全放行模式下无效。

## 文件与密钥

- 文件工具只能访问当前项目文件夹，并会拒绝指向外部的链接；即使项目文件夹包含应用本身，也访问不到应用的代码、配置、密钥和数据。
- API Key 只保存在本机 `.env`，运行代码的子进程拿不到任何 `*_API_KEY` 环境变量。
- 自定义网关需要在设置里逐个授权地址；访问内网地址要单独勾选，不跟随重定向，并在建连时固定校验过的 IP。更换网关地址后需要重新填写密钥。

## 自进化

- 进化不能修改 `evoscholar.config.json`、权限策略、guards，也不能提高步数上限。
- 持久的 harness 改动都会先成为候选版本，经你批准才上线，并且可以回滚；未经离线验证的候选需要确认两次。
- 来自网页、PDF、上传文件或未信任的导入技能的内容，只能生成需要人工处理的试用条目，不会自动转为生效的经验。随应用附带的技能和你标记为信任的技能除外。
- 锻造出来的可执行技能先进入试用；转正必须由你批准，也可以随时停用。

## 已知限制

- 安装包暂未代码签名，首次打开需要手动确认。
- 宿主模式下，路径检查和实际打开文件之间存在被并发替换的时间窗口（Node 没有可移植的 `openat`）。默认的容器模式下，模型代码碰不到宿主上的项目文件。
- 容器隔离依赖 Docker Desktop 及其虚拟机；Linux 内核或虚拟化层的漏洞不在本项目的防护范围内。

## 报告安全问题

请通过本仓库 Security 页面的「Report a vulnerability」私下报告，不要公开提交 issue。

## English summary

- The workbench listens on `127.0.0.1`, checks Host and Origin, and requires a per-launch token on every API call. The desktop app attaches it to its own requests; `npm start` pairs the browser once.
- Model-written code runs in an offline, read-only, non-root container on a working copy of the project; results are written back to `evoscholar-out/<session>/`. Host mode is an opt-in fallback that asks before every run and is ignored in bypass mode.
- File tools stay inside the project folder and never reach the app's own code, config, keys or data. API keys never reach child processes. Custom gateways are approved per origin with pinned addresses.
- Evolution cannot change config, permissions, guards or step limits; persistent harness changes need your approval and can be rolled back. Content from the web, PDFs, uploads or untrusted imported skills never becomes an active memory on its own.
- Known limits: unsigned installers; a check-then-open window in host mode; container isolation relies on Docker Desktop's VM.
- Report vulnerabilities privately via the repository's Security tab ("Report a vulnerability").
