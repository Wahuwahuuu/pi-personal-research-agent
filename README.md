# Pi Personal Research Agent

Cloudflare Worker + SQLite Durable Object + 官方 PiHarness / Pi Durable / Pi AI，连接 Windows 本地科研检索节点。默认使用确定性模拟模型，不产生模型 API 费用。当前正在建设个人科研产品；动态入库和主动科研已接入，真实科研质量及长期稳定性验收仍在进行。

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

## Windows 运行环境安装

准备 uv 0.10.12 和已有的 embedding／重排模型目录后，运行：

```powershell
node scripts/install-runtime.ts --models "F:\Models\research" --device cuda
```

使用 CPU 时将 device 改为 cpu。默认由 uv 查找或安装 Python 3.12，也可以通过 --python 指定已有 Python 3.12 的绝对路径；需要代理时显式传入 --proxy http://127.0.0.1:7890，不支持在代理地址中携带凭证。

安装器使用 packages/retrieval/uv.lock，以 --locked 安装检索、PDF 和托盘依赖。每次新建 .local/runtimes 下的独立环境，校验固定依赖、Python、模型资源及 CUDA 可用性后才将 status.json 标记为 ready。返回的 python 路径用于节点模板中的 python.executable 和 libraryPython。模型文件由部署者准备，安装器只读取和校验，不下载或更改它们。

此步骤不启动服务、不修改已有节点配置，也不切换现有 Python 环境。失败会保留 failed 状态和规范错误代码供检查；再次安装会使用新目录。切换和回滚使用下方的独立命令。

已按当前配置模板安装的节点，可使用以下命令切换到安装器返回的 ready 清单：

```powershell
node scripts/switch-runtime.ts --config ".local/node.json" --manifest ".local/runtimes/ENVIRONMENT_ID/status.json"
node scripts/switch-runtime.ts --config ".local/node.json" --rollback ".local/runtime-switches/RECEIPT_ID/receipt.json"
```

切换先校验新环境，再停止指定节点与托盘，保存原配置并原子更新两个 Python 路径。命令返回回滚记录的位置；之后显式启动托盘。回滚会重新检查旧环境，并核对当前配置是否仍等于切换后的版本，发现后续手工修改时拒绝覆盖。更新互斥锁由 SQLite 管理，进程退出后自动释放；未写完完成标记的切换仍可使用记录回滚。原环境、资料库及凭证文件保留。

此流程管理本机 Python 依赖环境；应用源码和云端发布版本的回退需要对应版本的迁移兼容检查。

## 本地节点

先复制 `local/node.example.json` 到 `.local/node-install.json`，填入云端地址、本机 Python、模型和论文库目录，再运行 `powershell -NoProfile -File scripts/setup-node.ps1`。脚本先检查 Python 3.12、固定依赖、CUDA（如选用）、模型文件及已有索引，再以隐藏输入接收网页设置中生成的设备凭证。支持已启用 Passkey 的账户，不读取管理员密码或模型密钥。凭证经只读接口验证后使用 Windows DPAPI 保存，配置写入 `.local/node.json`；已有配置、密钥和数据目录不会被覆盖。独立安装可指定 `-Template` 与 `-Config`。默认模板使用显式空论文库：配置 Python、模型和 libraryRoot 路径后即可启动，首次导入后才建立索引并加载检索模型。已有索引可使用 local/node-existing-index.example.json，填入论文库、索引路径和 YOUR_INDEX_VERSION；CPU/CUDA 身份必须与原构建一致。缺失的已有索引不会静默改成空库，已有本机配置也不会自动覆盖。

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

PDF 文本提取使用锁定的 pypdf 与 fontTools。遇到损坏的字符映射时，只依据同一 PDF 内嵌字体的唯一字符映射及明确的数学上下标变体恢复；歧义或缺失映射仍报告不支持。原 PDF 不改写，解析记录保留修复来源哈希。新的解析器还启用 pypdf 的嵌入 CFF 字体支持，可能修正旧版提取中的公式符号；已有索引与引用快照保持原版本。

本机管理接口绑定 127.0.0.1，需要独立 Bearer 凭证；Windows 首次启动会在节点数据目录生成当前用户 DPAPI 加密的 local.secret。该凭证与云端设备凭证独立，不写 URL 或日志。管理接口提供状态、暂停、重连、PDF/arXiv 导入、重试、取消和回滚；文件路径只由受信任本机操作者提交，云端不接受任意本地路径。原生托盘复用这些接口。网页论文库可登记带版本的 arXiv 编号，本机离线时保存待办；具备动态库配置的节点连接后处理并回传获取、解析、索引和校验状态。新目录校验完成后才显示已入库。取消和显式重试使用独立代际，重复回传不会重复交付；同一论文的本机独立导入不会被另一项目取消误停。项目删除会清理关联入库元数据，并保留拒绝迟到结果的墓碑。

### Windows 托盘与本地全文

安装 packages/retrieval 的 desktop extra，并完成节点配置后，可运行：

```powershell
powershell -NoProfile -File scripts/start-desktop.ps1 -Show
```

文本 PDF 需具备可解析的文字映射。合法 Unicode 代理对会合并为原字符；缺失映射、孤立代理码元会明确报告 PDF_TEXT_ENCODING_INVALID，停止入库并保留文件，不猜测或替换原文。扫描件仍不支持。

托盘窗口展示连接、检索模型加载和入库阶段。可从原生文件选择器导入文本 PDF，或输入带 vN 的 arXiv 标识；失败可重试，处理中可取消。论文页支持搜索、分页及指定 PDF 页码打开全文。完整文件只通过经过本机鉴权的接口读取，在独立本地窗口展示，未配置私人全文远程传输。

网页论文详情与证据面板提供“在已连接电脑打开”。该操作通过已配对节点交给 Windows 托盘，手机上点击也会在目标电脑打开，不向当前网页传输完整文件。引用具有经过核对的 PDF 页码时定位到对应页，否则明确打开首页。网页等待实际窗口回执后才显示已打开；请求过期、连接断开或设备撤销时可见失败，不会在稍后重新连接时突然打开旧窗口。关闭证据面板或刷新网页会恢复尚未结束的打开请求。

删除关联会话时，原节点会关闭由该会话打开的阅读窗口，并清除对应临时 PDF 和请求记录；云端收到该设备的清理回执后才结束待清理状态。离线节点重连后继续处理，旧版节点未报告清理能力时保持待处理。论文库原件、独立打开的窗口和用户保存的副本不受影响；托盘重启时会清理上次异常退出遗留的阅读缓存。

关闭窗口会保留托盘与节点；再次运行带 -Show 的启动命令可重开已有窗口。`stop-node.ps1` 会协同停止节点与托盘，主动停止后不自动拉起；下次登录或手动启动托盘会恢复。管理独立配置可传入 `-Config "完整配置路径"`，不会停止其他配置的节点。托盘“停止本机服务并退出”先请求停止，失败时保留操作入口。节点意外退出后尝试重新启动；导出诊断只含运行状态和计数，不含凭证、路径或论文原文。

登录启动脚本默认启动托盘；纯后台节点仍可用 install-startup.ps1 -NodeOnly 注册。现有计划任务只有在重新运行安装脚本时才改变。实际 Windows 登录、休眠与恢复行为仍需在部署机器验收。

## 关注主题与主动科研

在收件箱选择“管理关注主题”，可以输入关注要求生成可编辑草稿，再核对 arXiv 英文检索词、研究目标、所属项目和每轮处理篇数。草稿不会直接启用计划；中文目标没有提供英文检索词时，需要手工补齐。当前固定每日上海时间 09:00 检查，首次启用会先检查一次。

只有勾选自动处理权限，计划才会在预算内安排下载、索引、原文阅读和研究记录整理。每轮深入处理最多三篇，未处理候选保留至后续周期。所有阶段共用同一长期任务的累计预算与 Pi 会话；离线入库等待不反复调用模型。后台研究在步骤边界让位于前台请求。

主题记录分别展示新发现、入库、阅读、未覆盖内容与阶段简报。只有评估为值得关注且带有效原文引用的变化进入收件箱；无重要变化的简报仍可从批次查看。模型对“重要变化”的判断需要结合原文审阅，不等于独立科研验证。

暂停计划会阻止新步骤，已发出的本地入库步骤可能完成。任务自身的暂停不会因恢复计划被自动解除。修改研究方向会暂停旧方向的任务；关闭自动处理权限立即阻止新步骤，启用权限和调整篇数从下一发现批次生效。来源失败保留成功检查位置并重试，不把未完成补查标记为全覆盖。

运行主动链的软件检查使用 node scripts/proactive-check.ts。已构建网页后，在 PowerShell 设置 $env:PRA_PROACTIVE_BROWSER='1' 可同时执行桌面和手机浏览器流程。测试使用独立存储、模拟模型和可控来源/节点，不产生付费模型调用；产物保存在本地忽略目录。

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

- arXiv 发现、候选筛选、本地入库、原文阅读、结构化记忆及证据简报已串联；元数据发现与深入处理分别记录。真实主题周期、研究意义和长期费用仍需验收，模拟模型的简报不能当作科研结论。
- 应用状态使用 SQLite 实体表、增量写入、分页与事件游标。会话历史正文按会话读取；启动、普通保存和无正文搜索的会话列表使用元数据与持久计数。首次升级至应用 schema 2 会在初始化事务内建立计数，不改写已有消息；旧版完整导出及正文搜索仍会读取所需历史。删除实体保留其他行的排序位置；仅新增、删除或实际改变的行落盘，显式重排及插入位置耗尽时才重新分配该集合的位置。任务、工具操作与记忆等执行状态仍整体装载，长期增长与免费额度仍需实测。应用 schema 2 不能直接回滚到仅支持 schema 1 的旧构建。
- 服务端认证后路由到独立个人 DO；邀请制 Passkey、单次恢复码和逐设备撤销已接入。真实设备认证、云端隔离与长期运行仍需部署验收。
- 长期记忆复用原有结构化摘要、偏好提取与原文校验，主数据存于云端；使用中文分词 + FTS5、项目/论文范围与时效排序，不依赖本机在线。研究结论附原文引文与 Unicode 位置，原文匹配不等于人工语义评审。修订记录仅供查看，纠正和删除不进入新的召回结果。整理计入原任务预算，无剩余额度时保留未整理状态。删除记忆会影响以后新任务的上下文，不等于删除 Pi 中已有任务的原始会话。会话删除使用锁定 Pi 存储版本的适配器清理关联记录，离线结果由持久墓碑拒绝；未知版本会拒绝删除。跨会话派生数据和备份恢复的完整删除传播仍待验收。
- 长期稳定性、断网与唤醒、共享免费额度和科研质量需要在部署者自己的环境中分别验收；短测试不能替代。

状态订阅事件保留最近 10,000 个序号窗口，旧库每次追加或读取变更页最多清理 200 条，逐步消化积压。此策略仅清理失效通知，不删除会话、研究成果或删除标记。`GET /api/changes` 返回 `oldestCursor`、`resetRequired`；窗口外或超过最新位置的游标必须重新读取实体分页，不能直接跳过漏失事件。网页重连会自动刷新当前工作区。

本仓库只发布产品源码、配置模板、软件测试和使用部署说明。敏感信息、AI 对话历史、AI 工具配置与指令文件、开发规划、研究数据及运行记录仅保留本地，不随源码发布。

任务卡支持暂停、继续、优先级和暂停后的方向调整。已启动步骤结束后保存检查点，再停止；取消仍可立即中断。前台任务在步骤边界优先于后台任务。每一段使用已有完成与证据检查，澄清或无进展不会自动消耗下一段，达到总上限时保留部分成果并暂停。

模型验证配额由整个应用共享：最多 500 次调用、600 万输入 token、100 万计费输出 token；与月度人民币预算同时检查，跨月和切换账户不重置。所有已注册账户的旧累计用量先完成迁移，再允许新付费调用。旧记录无法区分模拟与真实调用时按全部已用保守计入；新模拟调用不进入付费验证账本。调用失联按预留上限结算，迟到回执不会退回已保守结算的额度。

设备配对支持请求标识：同一账户以同一 requestId 和设备名称重试，会取得原设备凭证及原过期时间，不新增设备。凭证仅在返回时生成，云端只保存哈希。配对使用已有 Worker ADMIN_TOKEN 作用途隔离的 HMAC 派生；轮换该 Secret 后，旧配对请求需重新生成，已经安装的有效设备仍按原有效期验证。请保留此 Secret，即使账户已启用 Passkey。

删除会话会沿已记录的记忆来源清理其他会话中的派生回答、成果版本和运行时上下文，保留独立的用户提问及计费计数。依赖已删来源的旧任务不能继续；可以在清理后的会话重新提问。旧版只记录记忆 ID 的数据会保守清理其后续记忆消费者结果。未知 Pi 存储结构会拒绝删除，并阻止受影响上下文继续执行；删除状态未完成时不能视为数据已经全部清除。论文库原件和用户另外保存的副本不属于会话删除范围。

工具结果的删除按设备核验：同一操作曾派发给多台电脑时，每台都需要确认本机缓存清理。撤销、离线或未升级的设备没有回执时，不能显示全部删除。旧版本没有完整设备派发历史的记录会保留“本地副本待核验”，即使旧界面曾标为完成；已删内容继续由墓碑阻止回传，云端不会重新生成它们。

发布脚本要求干净的已提交源码，并在上传前校验现有部署身份。启用 Passkey 后优先读取匹配部署地址的本机设备凭证，通过只读接口检查，不会挤掉节点连接；也可通过环境变量 PRA_DEPLOY_DEVICE_TOKEN、PRA_DEPLOY_SESSION 或 DPAPI 文件 .local/deployment-session.secret 提供部署校验身份。初始化登录已关闭且没有有效凭证时会在上传前停止。上传使用独立构建快照，并核对代码、静态资源和配置的内容哈希；路径越界、目录链接或构建内容变化会阻止发布确认。只有实际个人 Agent 返回对应构建标识后，才更新 .local/deployment.json。未通过的上传保留在 deployment-pending.json，不能视为已验证发布。

删除研究成果会清除该成果的全部版本、关联通知和旧保存请求缓存，并留下不含正文的删除标记。自动任务重放不会重新生成已删成果；你仍可从原任务主动保存一份新成果。删除成果本身不删除原会话或论文。恢复仅可通过下述检查点入口进行。

设置 → 数据提供检查点保存、有效期和恢复状态。恢复前需确认影响范围；断网后刷新会继续查询同一请求，必要时可用同一请求重试。研究概览不可用时仍可查看恢复状态，不会因刷新再次回退。

恢复检查点接口使用 Cloudflare SQLite DO 的 PITR。POST /api/recovery/checkpoints 接收 requestId、label；GET /api/recovery 查看可用检查点和恢复状态；POST /api/recovery/restore 接收 requestId、checkpointId。仅接受本账户、29 天内、相同构建和存储结构的检查点，最多保留 30 个可用记录。保存前会初始化 Pi 存储结构，不发起模型请求。模型或本机操作正在执行时返回 RECOVERY_BUSY，稍后用同一请求标识重试。

恢复前将当前删除标记、修订记忆、设备权限、导入队列和计费数据暂存到独立身份对象；保护记录超过 750 KB 时拒绝开始，不丢弃记录。时间回退后先重放这些保护规则，再开放访问；旧任务请求、已删除会话及成果不会通过本入口重建。完成后清除临时保护正文，保留恢复状态。失败时维持访问门禁；GET /api/recovery 仍可查看状态。未完任务取消并保留已有部分结果，关注计划暂停，原 Pi 会话重新从应用历史建立；不会自动重做恢复点之后的工作。

检查点依赖平台的有限保留窗口，不是永久离线备份。此协议不覆盖绕过应用入口的控制台整库回退、身份对象同时回退或平台备份物理清除。既有历史中未记录的删除请求标识无法补造。平台机制见 [Cloudflare PITR 文档](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)。

鉴权诊断接口 GET /api/recovery/schema 返回当前构建、存储结构指纹和表/索引定义，仅用于排查版本兼容性；不返回行数据、恢复书签或凭证，不接受任意 SQL。

## 平台资源观测

登录 Wrangler 后运行 `node scripts/observe-platform.ts WORKER_NAME [YYYY-MM-DD]`。工具只读查询 Cloudflare GraphQL 和 namespace 清单，分别保存项目与账户共享用量，结果仅在忽略跟踪的 `.local/platform-metrics/`。默认 UTC 当日，可查询最近七日；模型费用仍按上海自然月结算。凭证只在进程内使用，不写入报告。

请求、GB-s、SQLite 行读写来自平台统计；DO 请求采用不折算 WebSocket 优惠的保守估算，存储为各 namespace 窗口峰值之和。数据可能采样或延迟，缺失、无权限、空结果和截断显示未知；估算剩余额度不是保证。达到项目目标或账户 80% 免费额度时建议暂停后台并返回退出码 2，数据不全返回 3；此命令本身不暂停任务、不修改套餐。口径见 [DO 指标](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/) 和 [DO 免费额度](https://developers.cloudflare.com/durable-objects/platform/pricing/)。

### 后台资源保护与云端监测

`node scripts/publish-platform.ts .local/deployment.json .local/deployment-session.secret` 使用现有 Wrangler 登录读取真实统计，再以应用所有者会话上传；服务端按固定额度重新计算，其他账户和设备不能改变资源保护。手动发布只是一份快照：启用后超过 75 分钟、跨 UTC 日、统计未知或达到阈值，新的后台发现、模型步骤和入库派发会等待。前台对话、查询、取消和删除继续可用；新鲜统计恢复余量后接续原任务，人工暂停与累计预算保留。

若需要本机离线时继续监测，在 [Cloudflare API Token 页面](https://dash.cloudflare.com/profile/api-tokens) 创建限定本账户的专用只读 Token，权限为 Account Analytics Read 与 Workers Scripts Read，然后运行：

```powershell
.\scripts\configure-platform-monitor.ps1 -DeploymentRecord .local\deployment.json -SessionSecret .local\deployment-session.secret
```

本地提示框隐藏输入，通过标准输入直接交给配置程序；程序先检查账户、目标构建、应用所有者和读取权限，再只写入 Worker Secrets，不保存明文 Token。不要使用部署 OAuth 凭证或模型密钥。云端每 30 分钟读取统计，失败或过期时保留待办并暂停后台，不会自动改套餐。设置完成还会验证一次真实云端读取；缺少凭证时不宣称持续监测已就绪。

对话支持直接输入“暂停当前研究”“继续刚才的任务”“取消这个任务”“现在做到哪了”“查看任务进度”。这些短句调用宿主状态机，不消耗模型请求；仅作用于当前会话。多项任务时先列出最多五项，序号选择五分钟有效。恢复保留原任务的累计预算，当前步骤未结束或额度耗尽时会说明原因。普通科研追问继续由 Pi 选择科研工具。

每轮讨论可展开“对话上下文范围”，区分当时保存的历史与本步准备的近期文字、约束和记忆。窗口优先最近内容，中文与 emoji 按完整字符截短，并明确标记截短；原始会话不改写。该清单描述步骤开始前的应用投影，执行中新读取的论文仍在证据面板中查看。

科研完成检查沿用原版 AsterCite 的执行状态与论文/片段标识摘要。原文不会在这一检查步骤中重复发送；空结果、未完成与结果未记录分别保留，省略的操作和标识有明确计数。摘要不能代替原文证据或科研正确性验收。

Cloudflare 默认允许活跃 Durable Object 延后最多 300 秒更新代码。普通发布保留这个宽限期，按配置延迟加确认窗口等待实际构建切换；未确认时仍保存为待核实发布。可在 Wrangler 配置的 durable_objects.code_update_strategy 中调整策略，详见 [官方代码更新说明](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/)。

发布会固定实际生效的非秘密模型配置，并通过鉴权接口 `GET /api/deployment` 核对构建与兼容契约。契约包含应用/Pi 存储版本、节点协议、锁定运行时依赖以及独立维护的回滚兼容族；部署记录和冻结目录中的校验收据保存在本地。未知或不匹配的契约不能标记为验证成功。相同数据库结构不代表旧代码能保留新的删除、计费及恢复语义；破坏这些语义的升级必须更换兼容族。旧构建没有声明契约时不自动认定为可回退版本。代码版本回退不恢复数据，平台边界见 [Cloudflare 回滚说明](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)。

回退云端代码时，先预览经过验证的旧发布目录：

```powershell
node scripts/rollback-release.ts --record .local/deployment.json --target ".local/releases/BUILD-TIMESTAMP" --session-file .local/deployment-session.secret
```

将目录替换为原始冻结发布目录；确认输出的来源和目标构建后，在同一命令末尾加 `--apply` 执行。也可用 `--device-secret-file` 指定独立设备的 DPAPI 凭证文件，不传明文密钥。命令核验实际 Cloudflare 账户域名、当前构建、两版完整兼容契约、冻结摘要和全部有效配置；模型、绑定或兼容族不同均拒绝。未保存契约和账户归属的旧发布不能自动回退。

执行会重新发布目标目录中的已验证代码与静态资源，不重新编译、不改数据库、不更新 Secret 或套餐。正常发布与回退对同一账户/Worker 使用本机系统锁，进程退出后自动释放；跨电脑或控制台发布仍需由维护者协调。上传与确认失败会在部署记录旁留下 `deployment-rollback-pending.json`；恢复凭证或网络后用原命令重试，已在服务的目标只补做确认，不重复上传。只有实际构建和契约确认通过才推进部署记录；回退之后可用同一工具重新发布原来的较新冻结目录。该功能覆盖云端代码和网页，本地节点源码升级、跨数据版本回退不在此命令范围内。

准备一个可核验的本地程序版本：

```powershell
node scripts/prepare-node-release.ts
```

命令要求干净且已提交的源码，将产品所需源码和锁定的 Node 生产依赖保存到 `.local/node-releases`，安装依赖时不执行生命周期脚本。配置、设备凭证、论文、索引与开发材料不进入程序目录。每次校验覆盖源码和依赖的全部文件；失败目录没有可选用的完成收据。此步骤只准备程序版本，不启动或切换节点。Python 环境继续使用独立的安装与切换工具。
