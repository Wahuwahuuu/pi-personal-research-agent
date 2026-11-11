# 本地科研检索模块

本包将 AsterCite 的 Python 检索、重排、结构化原文读取和本地记忆存储代码封装为独立模块，遵循原 MIT 许可。Node 连接程序默认使用本包的 retriever/worker.py；也可显式配置兼容 worker。

运行时仍需由本机配置提供语料、已验证索引及模型目录；这些资料不随源码分发。模块不运行第二个主 Agent，也不接收云端模型密钥。对外科研工具沿用 search_papers 与 retrieve_chunks，原文读取由受限宿主接口调用。

使用 Python 3.12。依赖版本锁定在 pyproject.toml；需要检索模型时安装 retrieval extra。Windows CUDA 使用所列 PyTorch CUDA 12.8 软件源，其他环境按兼容的 PyTorch 运行平台安装相同版本。

在本目录执行 python -m unittest discover -s tests 可以验证结构化原文解析，测试无需下载模型或论文。真实检索还需要完整索引和模型；未配置时不能把解析测试视为检索能力验收。
