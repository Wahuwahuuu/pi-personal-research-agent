# 本地科研检索模块

本包将 AsterCite 的 Python 检索、重排、结构化原文读取和本地记忆存储代码封装为独立模块，遵循原 MIT 许可。Node 连接程序默认使用本包的 retriever/worker.py；也可显式配置兼容 worker。

运行时仍需由本机配置提供语料、已验证索引及模型目录；这些资料不随源码分发。模块不运行第二个主 Agent，也不接收云端模型密钥。对外科研工具沿用 search_papers 与 retrieve_chunks，原文读取由受限宿主接口调用。

使用 Python 3.12。依赖版本锁定在 pyproject.toml；需要检索模型时安装 retrieval extra。Windows CUDA 使用所列 PyTorch CUDA 12.8 软件源，其他环境按兼容的 PyTorch 运行平台安装相同版本。

在本目录执行 python -m unittest discover -s tests 可以验证结构化原文解析，测试无需下载模型或论文。真实检索还需要完整索引和模型；未配置时不能把解析测试视为检索能力验收。

## 动态本地论文库

安装 library extra 后可从包目录运行 python -m retriever.library --root <本机绝对目录>，通过标准输入传递 JSON 操作。支持 register_pdf、register_arxiv、run、status、list、cancel、retry、active 和 rollback。此命令只供受信任的本机连接程序或操作者使用，不能作为远程 shell 暴露。

PDF 由本机用户选择；源码不携带论文。register_pdf 接受 requestId、path、metadata；register_arxiv 接受 requestId、明确带 vN 的 arxivId、metadata。远程导入只能从 arXiv 固定来源下载，不接受任意 URL。元数据支持 title、authors、abstract。

run 接受本机 models 目录与 cpu/cuda 设备，复用 P2 的解析位置、分块、向量、重排和索引验证契约。发布前先写独立快照并校验，再原子更新 active.json；旧索引保留以便正在执行的任务继续使用。run 启动时恢复发布中断的日志；取消不会发布迟到构建。后台重处理和检索应由连接程序统一调度，避免抢占本机模型资源。

首版逐页提取文本层，保留页码和无文本页列表；扫描件、加密文件、超限输入明确失败。逐页文本不等于已恢复 PDF 表格结构。混合扫描页面标为覆盖缺口。结构化表格和公式仍由独立原文阅读器提供。解析后的全文、PDF、索引和入库日志全部保存于本机资料目录。

动态库使用独立的 library-full-chunks-v1 配方，词法检索支持规范化后的英文词元及汉字单字、双字词元。原 pipaper 固定索引继续使用原配方与分词，不重建或修改旧索引；新旧版本都由同一受限 worker 校验后读取。
