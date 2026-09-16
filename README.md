# Chunk Lab

上传解析后可直接「向量化并入库」，不要求逐块审阅或绑定商品。支持父子分块、父块上下文展示与检索。操作及 API 参数见 [父子分块与入库](docs/parent-child-chunking.md)。

面向电商说明书、参数表和图文混排文档的 RAG 文档切分与人工审阅工作台 V2。

## 运行

安装依赖并启动 Fastify：

```powershell
npm install
npm run dev
```

复制 `.env.example` 的键名到本地 `.env`，填写服务端配置，然后打开 `http://127.0.0.1:4180`。不要把 `.env` 或密钥加入导出、日志或版本库。

必需配置：

- `MINERU_API_TOKEN`：PDF、Office 和图片解析。
- `EMBEDDING_BASE_URL`、`EMBEDDING_MODEL`、`EMBEDDING_API_KEY`：Semantic Boundary。调用失败会明确报错，不会静默降级。

可选配置：

- `CONTEXT_BASE_URL`、`CONTEXT_MODEL`、`CONTEXT_API_KEY`：选择性 Context Enhancement。未配置时其他切分、审阅、人工 Context 和导出仍可用。
- `CONTEXT_TIMEOUT_MS`：单项 Context 请求超时，默认 30000ms。
- `PORT`：本地端口，默认 4180。

## 当前能力

- 多文件上传、独立解析状态和文档切换
- MinerU 精准 API 批量签名上传、状态轮询和结果 ZIP 解析
- Markdown/TXT 本地解析
- Sentence、Token、Structure-Aware 和 Semantic Boundary 四种切分策略
- 跨 Block 聚合、可追踪 Overlap 和精确 Source Segment
- 服务端配置的 embedding 模型与 LlamaIndex cosine similarity 实现的 Semantic 切分
- PDF/图片原文件底图或解析 Block 页面、MinerU bbox 与 Chunk 双向高亮
- Preview 与已确认 Draft 分离；支持文本校正、拆分、合并、排除、来源调整、撤销和重做
- 确定性 Context Candidate 推荐、按选择生成、失败隔离、人工兜底、确认和失效状态
- 服务器权威 JSON 导出；只有 confirmed/human_modified Context 进入 `embeddingText`
- 图片、表格处理策略及批量/单文档配置界面
- 24 小时过期的磁盘 Temporary Workspace、桌面和移动端响应式布局
- 大文档按当前页与相邻页窗口渲染

## 边界

工作区数据保存在 `.workspace`，用于本机临时恢复，不是正式文档库。当前不包含账号、多用户审核、向量数据库、检索评测、重新 OCR、字符级 PDF 标注或部署能力。

解析失败可按单文档重试；重新解析会在确认后清空该文档旧 Parsed Document、Preview、Draft、Revision 和 Context。调整切分控件不会自动请求 Preview，必须点击“应用参数并生成预览”。

真实或脱敏电商样本的版权与授权由使用方负责。仓库内 `src/ecommerce-fixtures.ts` 和 `qa/ecommerce-upload-sample.md` 是确定性脱敏验收样本，不代表真实客户文档。
