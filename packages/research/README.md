# Research module
Independent AsterCite research engine with a single package entry point.
The host supplies a validated catalog, source identities, a restricted research transport,
model configuration, an in-memory credential loader and a private storage directory.

```ts
import { createResearchModule } from "@personal-research/research";
const research = await createResearchModule(options);
const session = await research.openSession(); // keep session.id for later reopening
await session.configure(["paper-id"]);
const state = await session.ask("Explain this paper", {
  requestId: crypto.randomUUID(),
  events: { answer: update => render(update.text) }
});
await session.close();
await research.close();
```

Public operations: openSession, ask, state, configure, cancel, close, readPdf,
and translate (restricted to sources delivered in the selected turn).
Optional memory and structured-reading ports preserve the original integrations.
The transport and memory implementations remain owned by the host; close does not
terminate a shared transport. Session state and budget survive close/reopen.
Credentials are loaded into memory and are not configuration fields.

This release is the **Node compatibility adapter**, pinned to Pi 1.0.4 in an
independent package. Do not import it into a Cloudflare Worker or start it on the
local research node. The existing cloud application is unchanged. A Pi Durable
adapter must be implemented and verified before cloud cutover; this package does
not claim cross-device recovery or physical deletion of cloud transcripts.

The adapter preserves AsterCite's existing request and comparison budgets,
file-based sessions and translation budget. These are not yet the cloud application's
global quota. Production cloud admission must cover all model calls before cutover.
PDF reading supports the original fixed-source policy; arbitrary URL/path ingestion
is not exposed. No corpus, historical conversation, personal memory or model is bundled.

Run independently:
```sh
npm ci --prefix packages/research
npm run check --prefix packages/research
npm test --prefix packages/research
```
Only the package root is exported. Internal imports are reserved for implementation
and regression tests. Source code is derived from AsterCite under the included MIT
license. Tests use synthetic inputs and mock providers; they are not research quality
measurements.


## DO 适配入口

./core 提供不依赖旧会话运行时的工具参数、结果与证据校验，以及执行完成判定基础逻辑。云端使用根项目的 Pi Durable 运行时，不能在 Worker 中导入 Node 会话 facade。

./catalog 为本地节点提供 loadCorpusIndex(corpusRoot,indexRoot,device)，复用原目录、哈希和原文范围验证。返回公开论文目录与来源身份映射；不会读取密钥或运行模型。此入口使用 Node 文件系统，不能在 Worker 中运行。
