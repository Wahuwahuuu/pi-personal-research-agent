# Pi Personal Research Agent

Cloudflare Worker + SQLite Durable Object + 官方 PiHarness / Pi Durable / Pi AI，连接 Windows 本地科研检索节点。默认使用确定性模拟模型，不产生模型 API 费用。当前正在建设个人科研产品；长期主动科研、动态入库和完整稳定性验收仍在进行。

## 网页工作区

React + TypeScript + Vite 网页包含持续讨论、项目、任务、论文目录、版本化成果、记忆、收件箱和设置。引用打开原文侧栏，手机使用单列布局与导航抽屉。旧验证页面保留在 `/legacy.html`。

首次使用以初始化凭证进入并创建通行密钥，恢复码仅显示一次。日常登录使用通行密钥；邀请制账户拥有独立研究数据，设备可逐个撤销。通行密钥依赖 HTTPS 或 localhost 安全上下文。

`npm run dev` 先构建网页再启动本地 Worker；前端开发时可另外运行 `npm run web:dev`。浏览器功能测试 `npm run test:web` 使用已安装 Microsoft Edge 和虚拟 WebAuthn 认证器，模拟模型不产生付费请求。测试截图与运行记录留在忽略目录中。

## 本地验证

要求 Node.js 24.11.1 或更新版本。依赖已精确锁定，安装使用 `npm ci`。

```powershell
npm ci
npm ci --prefix packages/research
npm run check
npm test
npm run research:check
npm run research:test
npm run build
node scripts/integration.ts
```

集成测试启动并停止自己的本地 workerd 和夹具节点，使用随机凭证，结束后清除临时 `.dev.vars`。现有 `.dev.vars` 不会被覆盖。测试记录写入本地忽略目录 `docs/validation/`。

软件测试使用确定性夹具，不需要论文库或模型 API 密钥。真实检索使用仓库内 packages/retrieval 的 Python worker，并需单独安装 Python 依赖、模型与已验证索引。论文、模型和运行数据不包含在本仓库中。

## 云端

`wrangler.jsonc` 仅配置 SQLite DO、静态资源和 workers.dev，不使用 R2、容器或付费套餐配置。登录 Cloudflare 后，确认账户为 Workers Free，再运行：

```powershell
node scripts/cloud-preflight.ts
node scripts/deploy-free.ts
```

部署脚本拒绝覆盖不认识的同名 Worker，创建独立应用，登录凭证通过 stdin 写入 Worker Secret；本机只保存当前 Windows 用户 DPAPI 加密版本。套餐查询可能因 OAuth 权限不足返回 403，此时不能从空结果判断套餐。部署脚本核对实际个人 DO 返回的构建标识后才报告部署就绪。部署成功不等于免费负载验收通过。

登录凭证可在自己的终端使用 `powershell -NoProfile -File scripts/read-secret.ps1 .local/admin.secret` 读取。请勿贴入聊天、截图、任务正文或日志。建议用登录辅助脚本复制到剪贴板并登录网页。

若本机直连 workers.dev 不可用，可显式使用已有 HTTP 代理。测试脚本的 Node fetch 使用 `HTTPS_PROXY` 和 `NODE_USE_ENV_PROXY=1`；本地 WebSocket 使用配置的 `proxy` 或 `HTTPS_PROXY`。不要关闭 TLS 校验。

## 本地节点

可运行 `node scripts/setup-node.ts` 自动配对由本仓库部署的 Worker，生成 `.local/node.json`。也可复制 `local/node.example.json` 后在网页配对，运行 `scripts/store-secret.ps1` 保存设备凭证。启动前必须将 Python、论文库、模型、索引路径和 `YOUR_INDEX_VERSION` 占位值替换为本机实际配置；CPU/CUDA 身份必须与索引原构建一致。已有本机配置不会被自动覆盖。

```powershell
node local/node.ts .local/node.json
# 登录 Windows 后启动；脚本配置普通用户权限、失败重启
powershell -NoProfile -File scripts/install-startup.ps1
# 移除自启动
powershell -NoProfile -File scripts/install-startup.ps1 -Remove
# 立即停止当前节点（云端继续运行）
powershell -NoProfile -File scripts/stop-node.ps1
```

节点只执行 `search_papers` / `retrieve_chunks`，云端不能发任意路径或 shell。结果先写本地 SQLite outbox，得到云端确认再登记；断线重连先重发未确认结果。完整论文和检索索引文件留在本地。论文目录、来源映射的 ID/位置/哈希及必要证据片段会进入云端；不能宣称所有科研数据均留本地。节点复用 AsterCite 的索引验证器，校验源文件和原文范围后才同步目录。目录按页传输，最多 16 MB；超限会明确拒绝，完整数据库的迁移需要另行设计。

本地动态论文库由 libraryRoot 指定，libraryPython 指定安装了 retrieval 和 library 依赖的 Python 3.12。节点默认使用仓库内检索模块。导入后建立新快照并校验，再原子发布；已有语料会保留。后台构建与前台检索共用单执行位，构建期间任务等待，恢复后继续使用各自的索引版本。发布失败保留旧版本；支持显式重试、取消和空闲时回滚。

本机管理接口绑定 127.0.0.1，需要独立 Bearer 凭证；Windows 首次启动会在节点数据目录生成当前用户 DPAPI 加密的 local.secret。该凭证与云端设备凭证独立，不写 URL 或日志。管理接口提供状态、暂停、重连、PDF/arXiv 导入、重试、取消和回滚；文件路径只由受信任本机操作者提交，云端不接受任意本地路径。原生托盘和云端导入交互仍在建设。

## 模型与费用

仓库默认 `MODEL_MODE=mock`，也提供可配置的 OpenAI-compatible 模型适配器。启用前需明确授权并配置 `ALLOW_PAID_CALLS=explicitly-authorized`、`MODEL_API_KEY`、`MODEL_BASE_URL`、`MODEL_ID`，同时修改模型模式。密钥只放 Worker Secret。软件测试使用模拟 HTTP；实际可用性和科研质量需要分别验证。

低成本配置模板位于 `config/model.qwen.example.json`，模型为 `qwen3.7-flash`。复制到忽略跟踪的 `.local/model-settings.json` 后，`scripts/deploy-free.ts` 会保留该模型选择，后续部署不会自动退回 mock。模板及本地模型设置只允许模式、模型 ID、Base URL 和 `thinking: "off"`；不接受 API Key。请通过 Cloudflare Worker Secret 配置 `MODEL_API_KEY` 和授权标志，勿在聊天任务、配置模板或源码中保存密钥。

Qwen 请求显式发送 `enable_thinking=false`、`preserve_thinking=false`，日常输出上限为 2,048 token，原文翻译为 8,192 token，并在发起前预留对应预算。网页登录后展示实际运行模型；仓库默认和软件测试仍为 mock，不会因为存在本机模型部署配置而调用真实模型。切换为其他提供方前，应单独验证其思考参数、价格与兼容性。

适配器通过 SSE 向 Pi 转交可见文本和受限工具调用，不转交 provider reasoning 字段；未知 usage 按预留量计费。可见草稿合并到约一秒更新一次，最终回答仍需引用与完成校验。问题准备、科研执行、比较、完成检查和翻译各自使用持久化的 Pi 系统指令，避免输出协议冲突。

## DO 科研执行入口

默认入口使用 `RESEARCH_ENGINE=durable`。例如在本地运行：

```powershell
npx wrangler dev --var RESEARCH_ENGINE:durable
```

在新入口中，Pi 模型自行选择 `search_papers` / `retrieve_chunks`，DO 负责操作派发、预算和恢复。复用科研模块的参数、索引和引用验证器，不在应用层固定搜索顺序。统一输入入口先复用科研 NLU 识别需求；普通交流可在本机离线时完成，原文需求进入等待本机状态。各轮复用相同的 Pi 会话、主记忆和任务管理；尚无本地节点或论文目录时也可连续对话。软件集成测试使用相同入口和模拟模型。需要回退旧执行路径时可显式配置 `RESEARCH_ENGINE=legacy`，已有任务保留各自的执行引擎。

模型请求只携带当前有界宿主投影和本轮工具观察，完整 Pi 记录仍独立保存；旧归档不会绕过记忆纠正重复下发。每个业务会话对应一个 Pi 会话，后续任务通过 conversationId 继续该会话；任务各自保留调用预算。原有 NLU、领域记忆、逐项进度、多论文覆盖检查和完成判定通过独立科研模块调用。工具操作先持久化，再发给本机；等待期间结束当前模型轮次。结果通过校验后，以明确标记的延迟观察输入继续原会话，不把等待结果当成研究完成。同一个操作重复回传只接收一次，取消后的迟到结果不会重新启动模型。

累计限制跨恢复保持：普通任务最多 6 次模型请求、10 次工具调用、180 秒活跃时间。选择长期研究目标后，同一任务最多四段、累计 24 次模型请求、40 次工具调用、720 秒活跃时间；本地操作最多 3 次投递尝试。首个任务尚无已验证目录时先等待节点注册。节点保留已发布索引快照并报告可用版本；运行中的任务继续使用原版本，缺失快照时明确等待或失败，不能混用旧证据。缺少显式完成状态会进行语义完成检查；仍有缺项或引用无法核验时继续执行或明确保留部分结果。当前已支持文本续读、section=abstract 完整摘要，以及 content_type=table/equation/all 的原始结构阅读和分页；结构化结果由本地原始 HTML 缓存核验后回传。节点的 /papers/论文ID 只提供已登记公开 arXiv 论文 PDF，本地缓存复用原实现，不将完整 PDF 存入云端。普通 Markdown 输出进入原有完成检查；比较覆盖以每篇论文的有效原文核对。原文翻译复用原来的提示与校验，计入原任务预算，并按来源文本和模型缓存。网页复用原来的 Markdown、公式、引用和逐项进度组件。

## 边界

- arXiv 元数据分页、去重、重叠补查、站内通知已实现；全文自动下载、解析、增量入库及深度筛选尚未接通。
- 应用状态已拆为 SQLite 实体表，增量写入并提供分页与事件游标；部分执行状态仍在内存中整体装载。长期增长与免费额度必须实测。
- 服务端认证后路由到独立个人 DO；邀请制 Passkey、单次恢复码和逐设备撤销已接入。真实设备认证、云端隔离与长期运行仍需部署验收。
- 长期记忆复用原有结构化摘要、偏好提取与原文校验，主数据存于云端；使用中文分词 + FTS5、项目/论文范围与时效排序，不依赖本机在线。研究结论附原文引文与 Unicode 位置，原文匹配不等于人工语义评审。修订记录仅供查看，纠正和删除不进入新的召回结果。整理计入原任务预算，无剩余额度时保留未整理状态。删除记忆会影响以后新任务的上下文，不等于删除 Pi 中已有任务的原始会话。会话删除使用锁定 Pi 存储版本的适配器清理关联记录，离线结果由持久墓碑拒绝；未知版本会拒绝删除。跨会话派生数据和备份恢复的完整删除传播仍待验收。
- 长期稳定性、断网与唤醒、共享免费额度和科研质量需要在部署者自己的环境中分别验收；短测试不能替代。

本仓库只发布产品源码、配置模板、软件测试和使用部署说明。敏感信息、AI 对话历史、AI 工具配置与指令文件、开发规划、研究数据及运行记录仅保留本地，不随源码发布。

任务卡支持暂停、继续、优先级和暂停后的方向调整。已启动步骤结束后保存检查点，再停止；取消仍可立即中断。前台任务在步骤边界优先于后台任务。每一段使用已有完成与证据检查，澄清或无进展不会自动消耗下一段，达到总上限时保留部分成果并暂停。
