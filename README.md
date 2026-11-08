# Pi Personal Research Agent — 技术验证原型

Cloudflare Worker + SQLite Durable Object + 官方 PiHarness / Pi Durable / Pi AI，连接 Windows 本地科研检索节点。默认使用确定性模拟模型，不产生模型 API 费用。当前为技术预览版本，尚不代表完整产品或生产可用性承诺。

## 本地验证

要求 Node.js 24.11.1 或更新版本。依赖已精确锁定，安装使用 `npm ci`。

```powershell
npm run check
npm test
npm run build
node scripts/integration.ts
```

集成测试启动并停止自己的本地 workerd 和夹具节点，使用随机凭证，结束后清除临时 `.dev.vars`。现有 `.dev.vars` 不会被覆盖。测试记录写入本地忽略目录 `docs/validation/`。

软件测试使用确定性夹具，不需要论文库或模型 API 密钥。真实检索需要单独安装兼容的 AsterCite Python worker、论文库、模型和索引；这些数据与依赖不包含在本仓库中。

## 云端

`wrangler.jsonc` 仅配置 SQLite DO、静态资源和 workers.dev，不使用 R2、容器或付费套餐配置。登录 Cloudflare 后，确认账户为 Workers Free，再运行：

```powershell
node scripts/cloud-preflight.ts
node scripts/deploy-free.ts
```

部署脚本拒绝覆盖不认识的同名 Worker，创建独立应用，登录凭证通过 stdin 写入 Worker Secret；本机只保存当前 Windows 用户 DPAPI 加密版本。套餐查询可能因 OAuth 权限不足返回 403，此时不能从空结果判断套餐。部署成功不等于免费负载验收通过。

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

节点只执行 `search_papers` / `retrieve_chunks`，云端不能发任意路径或 shell。结果先写本地 SQLite outbox，得到云端确认再登记；断线重连先重发未确认结果。完整论文与索引不上传，必要证据片段会进入云端。

## 模型与费用

仓库默认 `MODEL_MODE=mock`，也提供可配置的 OpenAI-compatible 模型适配器。启用前需明确授权并配置 `ALLOW_PAID_CALLS=explicitly-authorized`、`MODEL_API_KEY`、`MODEL_BASE_URL`、`MODEL_ID`，同时修改模型模式。密钥只放 Worker Secret。软件测试使用模拟 HTTP；实际可用性和科研质量需要分别验证。

低成本配置模板位于 `config/model.qwen.example.json`，模型为 `qwen3.7-flash`。复制到忽略跟踪的 `.local/model-settings.json` 后，`scripts/deploy-free.ts` 会保留该模型选择，后续部署不会自动退回 mock。模板及本地模型设置只允许模式、模型 ID、Base URL 和 `thinking: "off"`；不接受 API Key。请通过 Cloudflare Worker Secret 配置 `MODEL_API_KEY` 和授权标志，勿在聊天任务、配置模板或源码中保存密钥。

Qwen 请求显式发送 `enable_thinking=false`、`preserve_thinking=false`，输出上限保持 2,048 token。网页登录后展示实际运行模型；仓库默认和软件测试仍为 mock，不会因为存在本机模型部署配置而调用真实模型。切换为其他提供方前，应单独验证其思考参数、价格与兼容性。

适配器仅向 Pi 转交可见文本，不转交 provider reasoning 字段；未知 usage 按预留量计费。当前是“应用先检索，再交给 Pi 回答”的验证路径，尚未实现模型自主选择工具、多项目多轮对话或生产审批流程。

## 边界

- arXiv 元数据分页、去重、重叠补查、站内通知已实现；全文自动下载、解析、增量入库及深度筛选尚未接通。
- 应用状态为 SQLite 单行 JSON，适合当前小型验证；增长、写放大和平台免费额度仍需实测。不能拿应用计数替代 Cloudflare 账单。
- 单用户服务端固定身份，设备凭证分离；多用户入口与两个真实租户的隔离测试尚未实现。
- 删除记忆会影响以后新任务的上下文，不等于删除 Pi 中已有任务的原始会话。目前没有对原始会话作删除承诺。
- 长期稳定性、断网与唤醒、共享免费额度和科研质量需要在部署者自己的环境中分别验收；短测试不能替代。

本仓库只发布产品源码、配置模板、软件测试和使用部署说明。敏感信息、AI 对话历史、AI 工具配置与指令文件、开发规划、研究数据及运行记录仅保留本地，不随源码发布。
