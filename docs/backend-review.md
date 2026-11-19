# EvoScholar 后端审查

审查基线为 `85365e3`，下表行号指向该版本。按 `CLAUDE.md`、PLAN 的 A1–A9 和 §3 核对 core、HTTP 服务、CLI 和 Python 工具。所有测试使用临时工作区、mock `fetch` 或回环服务。安全条目的触发条件描述边界失效的场景。

最需要复核的是命令工具的宿主权限。文件工具和报告路径已加固，但 Shell、Python 与锻造技能仍以应用账户执行。工作台也仍以同一操作系统用户为信任边界。两项方案在「需要用户决定」中。

## 已修

| 编号 / 严重程度 | 位置 | 问题和触发条件 | 修复及回归 |
| --- | --- | --- | --- |
| 01 高 | `packages/core/src/tools/sandbox.ts:4`、`packages/core/src/tools/fs.ts:32`、`packages/core/src/tools/exec.ts:127`、`packages/core/src/session.ts:94` | 路径检查把悬空链接当成未创建路径。目录遍历、轨迹、Python cell 及部分其他宿主输出没有统一检查。项目中的链接或 junction 指向外部时，读取或写入可能越界。 | 使用 `lstat` 区分悬空链接，检查真实路径和 Windows 路径形式。目录遍历跳过链接。轨迹、报告、预览、文献缓存和技能资源使用受限路径。回归检查目录链接与悬空链接。 |
| 02 高 | `apps/server/src/http.ts:33`、`apps/server/src/server.ts:699`、`apps/server/src/routes-v2.ts:230` | 浏览器直接打开项目的 HTML 或 SVG 时，活动内容从工作台同源响应加载。文件在响应前消失时，读取流也缺少错误处理。 | 项目文件返回 CSP sandbox 和 `nosniff`，HTML / JS 以附件处理。流打开成功后再发送 200，以 pipeline 清理中断的传输。HTTP 测试校验响应策略和文件内容。 |
| 03 高 | `apps/server/src/routes-v2.ts:45`、`packages/core/src/tools/exec.ts:21`、`packages/core/src/providers.ts:274`、`packages/core/src/gemini.ts:122` | 多行密钥影响 dotenv 解析。子进程按大小写过滤环境变量。模型列表可能跟随重定向，Gemini HTTP 错误可能透传上游响应正文。 | 密钥接受单行字符串和 `*_API_KEY` 变量名，原子替换 dotenv。子进程过滤忽略大小写。模型列表、DeepSeek 工具和本机 HTTP 禁止自动跳转。Gemini 错误只输出 HTTP 状态。测试使用占位密钥。 |
| 04 高 | `packages/core/src/evolve/store.ts:128`、`packages/core/src/evolve/kernels.ts:179` | 外部内容与可信记忆相似时可合并进已生效条目。新规则提案与正式规则同名时继承正式状态。 | 按来源信任级别和作用域匹配记忆，隔离外部条目和用户记录。拒绝用同名提案替换正式规则。测试确认相似外部记忆保持独立试用。 |
| 05 高 | `apps/server/src/server.ts:580`、`apps/server/src/server.ts:653`、`packages/core/src/session.ts:174` | 并发请求可在读取各自请求体前通过同一会话的忙碌检查。等待权限或选项时取消，宿主 Promise 可能悬挂。 | 解析请求后占用会话，合并同 ID 的加载，核心在开启轨迹回合前拒绝并发。取消与超时传递给等待中的确认卡，审批值要求布尔类型。模拟网关测试校验并发状态和取消后没有副作用。 |
| 06 高 | `packages/core/src/plugins.ts:66`、`packages/core/src/plugins.ts:84`、`packages/core/src/plugins.ts:123` | 本地导入跟随目录链接。归档解压信任声明大小，路径校验忽略 Windows 特殊名称。GitHub 导入在可变 ref 上分别读取树和文件。 | 跳过链接，限制本地读取量和实际解压量，校验归档路径。GitHub 固定提交、验证树与 blob 形态，只访问 GitHub API 和 raw 主机，设总下载字节数和超时。测试覆盖链接目录、大小边界及固定提交的模拟下载。 |
| 07 高 | `python/evoscholar_write.py:156`、`python/evoscholar_write.py:262`、`python/evoscholar_write.py:1654` | 主文件通过检查后，LaTeX 包含文件、参考文献和批注可解析到检查范围之外。 | 二级引用限制在主稿目录，批注和报告限制在各自输出目录。通过 Python 测试验证外部引用被忽略，原有相对路径检查和批注测试通过。 |
| 08 高 | `packages/core/src/permissions.ts:18`、`packages/core/src/tools/literature.ts:220`、`packages/core/src/tools/writing.ts:46`、`packages/core/src/evolve/loop.ts:220` | 无人工回调时，计划模式失效。若干工具会在直接放行后写文件或改变学习状态。 | `plan` 优先于无人值守配置。文献检索仍可返回结果，保存缓存才走确认。稿件报告、图形和 PDF 预览、导入、后台停止及模型发起的记忆、覆盖层和规则提案接入权限门。测试覆盖计划模式及四种模式的既有路径。 |
| 09 高 | `packages/core/src/session.ts:191`、`packages/core/src/evolution/evolve.ts:239`、`packages/core/src/evolve/consolidate.ts:49` | 自检开启第二次 harness prompt 时重获完整步数。生成候选 YAML 后若在插入 SQLite 记录前中断，沉淀版本仍可能上线。 | 主回合与自检共享生产请求步数。上线要求待审批记录，并与父版本和现行版本比较步数。测试覆盖步数耗尽和孤立候选文件，原有批准、回滚用例继续通过。 |
| 10 中 | `apps/server/src/http.ts:38`、`apps/server/src/server.ts:568`、`apps/server/src/server.ts:785` | 非法 JSON 返回 500，分块请求超限时连接可能先被销毁。慢读 SSE 和会话重开有订阅积压或遗留。 | 请求体错误返回 400 / 413，限流覆盖 Content-Length 和分块传输。SSE 在响应关闭时清理定时器，对积压断开连接，应用关闭时结束订阅。用本地测试验证状态码与连接释放。 |
| 11 中 | `packages/core/src/tools/exec.ts:72`、`packages/core/src/tools/exec.ts:185`、`packages/core/src/tools/exec.ts:224` | 短命令输出无限累积。预取消仍启动进程。后台启动错误缺少监听，回收计时器可在进程结束后继续运行。 | stdout 限制为 8 MiB，启动前检查取消，处理后台 spawn 错误，结束后清理计时器及监听器。补充预取消和输出超限测试。后代进程隔离列在 18。 |
| 12 中 | `packages/core/src/genome.ts:38`、`packages/core/src/genome.ts:81`、`packages/core/src/config.ts:124`、`packages/core/src/tools/fs.ts:116` | ACTIVE、设置和工作文件使用原地截断写入。磁盘写失败可能留半份文件。提示词路径只比字符串前缀。 | 同目录临时文件写完并同步后再原子替换。用于设置、密钥、genome、规则、技能元数据和文本工具。提示词引用复用路径边界。跨文件提交与恢复依然见 16。 |
| 13 中 | `packages/core/src/gemini.ts:65`、`packages/core/src/gemini.ts:129`、`packages/core/src/providers.ts:235` | Gemini 流被截断后可能生成完成事件，提前退出迭代只释放读取锁。模型列表假定所有记录都是对象。 | 缺少正常结束状态时失败，取消和提前退出会停止读取。长度截断时丢弃未完成的工具调用。跳过异常模型条目。用模拟流验证截断并保留已有的工具与签名回放测试。 |
| 14 中 | `packages/core/src/session.ts:100`、`packages/core/src/metering.ts:61`、`packages/core/src/budget.ts:145`、`apps/cli/src/main.ts:81` | A2 的旧开关可为日常请求启用人民币硬限。即使关闭，仍按价格表记录日常费用，CLI 普通回合还会打印累计金额。 | 日常模型请求记录 token，忽略旧金额开关。日常搜索和抓取跳过金额预留。CLI 普通回合只显示状态，开发和离线验证费用仍受现有约束。测试验证旧配置带硬限时，日常请求始终可记录零金额用量，开发限制仍有效。 |
| 15 高 | `packages/core/src/evolve/kernels.ts:113`、`packages/core/src/evolve/kernels.ts:129` | 锻造技能在两个会话复用后自动转正，也能覆盖已生效的技能版本。PLAN §3 要求技能转正有人确认。 | 复用达标后使用现有确认卡。完全放行模式也走人工批准，未批准的技能继续试用。替换已生效的可执行技能也需确认。测试先验证无人值守复用不转正，再验证批准后转正。 |
| 17 低 | `packages/core/src/projects.ts:77`、`apps/server/src/server.ts:86`、`apps/server/src/server.ts:699` | 部分文件列表跟随链接，冷重启后的文件接口把项目会话误当草稿会话。附件同名候选耗尽时可覆盖最后一个文件。 | 文件列表跳过链接与特殊文件，冷会话从 SQLite 读 cwd。附件用独占创建，重名耗尽返回 409。补充冷会话下载测试，原有上传和资料库测试通过。 |

## 未修

| 编号 / 严重程度 | 位置 | 问题和触发条件 | 建议修法 |
| --- | --- | --- | --- |
| 16 中 | `packages/core/src/db.ts:226`、`packages/core/src/evolution/evolve.ts:249`、`packages/core/src/evolve/consolidate.ts:49`、`packages/core/src/plugins.ts:57` | SQLite 迁移已有事务。genome 切换、候选沉淀和技能替换涉及多个文件与 SQLite，进程在中途退出或多个宿主同时写入仍可能使状态分叉。开发预算预留在崩溃后也缺少对账流程。 | 定义提交点和重启对账规则，给进程中断和双宿主写入补测试。已修的单文件替换、无候选记录拒绝上线是相关子集。 |
| 23 高 | `packages/core/src/evolve/loop.ts:257`、`packages/core/src/evolve/store.ts:194` | 标成 untrusted 的记忆不会自动转正，也不会混进可信记录。来源判断仍根据本回合工具名近似。模型依据先前回合、普通文件、导入技能或压缩摘要提炼时，来源可能漏标。 | 从历史消息、导入资源和投影块传递来源，给合并和自动晋级做端到端测试。在来源缺失时采用何种默认信任策略，应与现有可信经验自动试用流程一并评估。 |
| 24 中 | `packages/core/src/tools/literature.ts:46`、`packages/core/src/providers.ts:274`、`packages/core/src/tools/exec.ts:306` | 部分网络读取先缓冲整个响应再截断，文献 429 的固定等待没有观察取消信号。陌生网关、超大文献元数据或取消中的重试会增加等待和内存。 | 对响应读取设字节限额，取消时关闭响应流并结束退避。按来源保留合法的重试策略。 |
| 25 高 | `packages/core/src/tools/fs.ts:68`、`packages/core/src/projects.ts:25`、`packages/core/src/session.ts:101` | 选择 EvoScholar 源码目录或它的上级目录作项目时，应用自己的配置、凭据和状态文件也可能落在项目边界内。路径检查和实际打开之间也存在文件系统并发替换窗口。 | 为模型可见的文件入口增加应用私有文件边界。对目录句柄、真实文件身份和系统隔离方案做统一防护，覆盖本地并发替换。 |
| 26 中 | `packages/core/src/evolution/evolve.ts:239`、`packages/core/src/evolve/consolidate.ts:49`、`apps/server/src/server.ts:734` | 沉淀现有候选步骤可以直接进入审批，未实现 PLAN 的统一「验证并提交审批」。当前验证仍使用离线演进入口。 | 增加候选到回放任务的一致记录，审批页标明验证证据和适用范围。开发验证继续使用 mock 或由用户安排真实 API 花费。 |
| 27 中 | `packages/core/src/gemini.ts:31`、`packages/core/src/gemini.ts:132`、`packages/core/src/providers.ts:192` | 多工具调用的完整关联和多段思考签名还缺少跨回合模拟覆盖。通用协议与 Gemini 的鉴权及参数组合也有边界未测。 | 按协议补并行工具响应、被截断的调用、混合附件和非默认鉴权头的 fixture。用 core 包装修正行为，保留 harness fork。 |
| 28 中 | `packages/core/src/usage.ts:22`、`packages/core/src/providers.ts:382` | 用量总计以最多 400 个模型聚合行求和。模型数量更多时总计会偏小。连接探针的 token 返回给调用方，但未归档到用量。 | 总计使用独立 SQL 聚合。明确探针是否计入无会话用量后覆盖两条路径。 |

## 需要用户决定

| 编号 / 严重程度 | 位置 | 问题和触发条件 | 待选方案 |
| --- | --- | --- | --- |
| 18 高 | `packages/core/src/tools/sandbox.ts:23`、`packages/core/src/tools/exec.ts:72`、`packages/core/src/evolve/kernels.ts:15` | Shell、Python 和生成的技能以宿主账户运行。项目 cwd、静态正则和父进程回收都无法约束任意代码访问宿主文件、网络或启动后代进程。进化对配置和 guard 的保护仍依赖该执行边界。 | 选择 macOS 和 Windows 的系统级隔离后端并定义项目挂载、依赖、网络和后台服务范围。另一种方案是在隔离后端不可用时停用任意代码执行。 |
| 19 高 | `apps/server/src/main.ts:17`、`apps/server/src/server.ts:388`、`packages/core/src/tools/exec.ts:284`、`packages/core/src/providers.ts:264` | 默认绑定回环，无 CORS 放行，Host、Origin 与自定义头挡住浏览器跨站请求。其他本地进程仍可直接请求 API。自定义网关和模型访问本机测试服务是既有功能，也扩大了内网访问面。 | 为本机访问选择启动令牌或沿用操作系统用户边界。决定是否把 `http_get` 限定到本会话启动的服务，以及是否按厂商单独允许私有网关。 |
| 20 中 | `packages/core/src/providers.ts:157`、`packages/core/src/providers.ts:309`、`apps/server/src/routes-v2.ts:60` | Azure 已覆盖 `api-key` 请求头及现有路径形态。版本化的部署 URL 缺少 `api-version` 配置通道。Gemini、Anthropic 数值型思考预算与字符串 effort 共用的能力结构还未定。 | 明确 Azure 版本化部署的端点和版本字段。决定数值预算的类型、显示及已有字符串设置的兼容方式后，再加对应模拟测试。 |
| 21 中 | `packages/core/src/usage.ts:22`、`apps/server/src/server.ts:412`、`apps/cli/src/main.ts:37` | 旧账本和 token 用量共用 SQLite。历史金额及查询仍可读取。上游统一 usage 类型只有输入、输出、缓存计数，无法直接报告独立的推理 token。 | 保留历史查询、降为开发入口或移除旧接口并迁移。若要补推理维度，决定是在 core 内采集有协议支持的字段，还是等上游适配器统一支持。 |
| 22 低 | `packages/core/src/tools/fs.ts:84`、`apps/server/src/server.ts:609` | 文本工具先读全文件再分页，会话图片只限制单项。一组较大图片或超长日志会放大内存。 | 确定单文件和单回合总量及超限反馈，再统一 CLI、HTTP、工具与流式分页行为。 |

## 保护项核对

- `evoscholar.config.json`、权限和 guards。声明式变异与会话覆盖层只选择特定字段，权限门和 guard 由宿主装配。任意 Shell / Python 仍能触达宿主账户可访问的文件，见 18、25。
- 步数上限。genome 加载要求有效上限，候选上线不能提高父版本或现行版本上限。自检复用主回合的剩余步数。工作流子代理仍各自使用原有独立上限。
- 持久化。沉淀写候选，激活要求待审批记录和显式操作。可执行技能转正、替换已生效的可执行技能及正式规则生效由人工操作触发。会话试用产物仍可落盘。
- Untrusted。已标记的外部记忆保持试用或由用户显式处置，不能自动转为 active，也不能作为可信经验沉淀；来源识别的缺口见 23。
- 协议。离线套件覆盖 Chat Completions 工具回合、Messages 与 Responses 上下文适配、Azure 请求头和 Gemini SSE。版本化 Azure 及真机 Windows 路径行为留待验证。

## 验证

- 基线 46 项 Node 测试、44 项 Python 测试通过。系统 Python 缺少 SciPy、python-docx 等项目依赖。Python 验证使用项目已有的 macOS 虚拟环境，通过 PATH 运行同一条 `python3 -m unittest`。
- 最终构建通过，Node 63/63、Python 45/45。各批均运行构建与两套离线测试。真实 API 调用 0 次。未新增依赖，未提交或推送。harness 源码与分支基线逐字节一致，受保护配置文件哈希与基线一致。
