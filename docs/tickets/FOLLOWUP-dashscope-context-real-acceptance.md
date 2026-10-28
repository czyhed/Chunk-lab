# Follow-up Ticket: DashScope Context 配置与真实验收

- 状态：complete
- 日期：2026-08-16
- 证据目录：`output/evidence/dashscope-context-followup/`
- 依赖：T9.5 complete；不修改 T9.5 Ticket 或历史 evidence

## 目标

复用既有 DashScope Embedding 凭证，配置一个浏览器可选择的 Context profile，并以最多一次真实付费调用验证中文 Context、审核生命周期、刷新恢复和 Contract 2.1 导出。随后按当前文件事实推进最早未完成的正式门禁，不扩展 T10/T11、VLM、图片资产、MinIO 或供应商策略。

## 配置方式

- 保留既有 `EMBEDDING_BASE_URL`、`EMBEDDING_MODEL` 和 `EMBEDDING_API_KEY`。
- `MODEL_PROFILES_JSON` 新增 `dashscope-context`，capabilities 仅含 `context`，base URL 为 DashScope OpenAI-compatible 端点，模型为 `qwen3.7-flash-2026-07-15`。
- profile 的 `apiKey` 使用 `${EMBEDDING_API_KEY}` 环境变量引用；服务端解析引用后只在内存中使用凭证，不复制凭证值。
- `GET /api/model-profiles` 仅公开 `id`、`name` 和 `capabilities`。

## 真实验收

- 真实 Context 付费调用：1 次；自动重试：0 次；VLM 调用：0 次。
- Draft 中合格文本 Chunk 的生成按钮启用，Context 模型下拉框显示并选中 `DashScope Context`。
- 单次调用成功返回中文 Context，状态由 `awaiting_review` 进入 `confirmed`；`contextProfileId=dashscope-context`、profile 名称和 `context-v1` prompt provenance 可见并持久化。
- 页面刷新后 Context 文本、`confirmed` 状态、profile 和 prompt provenance 恢复。
- Contract 2.1 导出与公开 review API 的 Context 状态、文本、profile、finalText 和 revisions 一致；导出 `embeddingText` 等于已确认 Context、空行和 finalText 的服务端权威组合。Source Segment 数量、身份、范围和页码一致。
- 1440x1000 与 390x844 均无页面横向溢出或越界控件；Console 错误/警告为 0。

## 验收中修复

真实验收发现 profile 调用正确使用 `profile.model`，但持久化 `contextModel` 曾写入 profile 显示名。服务端已改为写入真实模型 ID，并由 fake profile 集成测试断言 `contextModel`。按本 Ticket 的不迁移和单次付费边界，本轮已确认的临时验收记录未回写、未重新付费生成；其 profile provenance 和实际请求配置仍保留为本次 smoke 证据。

## 门禁与剩余风险

- profile env 引用、模型 API、Context 选择/资格、runtime export、T9.5 回归及完整 `npm test`、typecheck、build、`node --check app.js` 均通过。
- 最早未完成的正式门禁仍是 `V21-G3`。本 Ticket 已补齐真实供应商成功、刷新、导出和响应式证据，但不把真实成功链路冒充计划要求的 fake 失败隔离、重试、人工 fallback 和 stale 浏览器证据；G3 仍保持 `in_progress`。
- T10/T11 没有独立正式 Ticket/PRD/验收范围，且 G3 尚未闭合，因此未推进图片资产、MinIO、VLM 缓存或供应商策略，也未创建猜测性实现。

## 边界

- 不输出或复制 API Key，不记录 Authorization、请求头、供应商原始异常或服务器路径。
- 不迁移、删除或直接读取工作区文件证明持久化；持久化证据仅来自公开 HTTP API 和浏览器刷新。
- 不修改 Parsed Document、历史 T9.5 Ticket/evidence 或图片/VLM 范围。
