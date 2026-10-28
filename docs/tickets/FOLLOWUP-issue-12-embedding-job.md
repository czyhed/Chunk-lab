# Follow-up: Issue 12 选择 Embedding 模型并执行可观察任务

日期：2026-08-16

来源：`.scratch/rag-document-chunking-workbench-v2/issues/12-embedding-selection-and-job.md`。Issue 01-13 是唯一排期与验收来源；PRD/V21-G* 仅为历史资料。

## 完成范围

- 新增服务端 `GET /api/embedding-profiles` 模型目录；前端只渲染服务端返回的 profile，不硬编码供应商产品。
- 新增文档级向量任务创建、查询和失败项重试 API；任务保存 profile、模型、维度、版本、状态、次数和脱敏失败原因。
- 任务幂等键覆盖文档、profile、模型和 Chunk 的最终文本、资格、Context 状态；相同输入重复提交复用现有任务。
- 仅将具备资格的 Chunk 交给模型。确认或人工修改的 Context 与最终文本组合；stale、失败、未确认 Context 不进入输入；排除和无资格 Chunk 显式跳过。
- 每个 Chunk 独立校验 token 上限和向量维度，并区分超时、限流、维度不匹配及请求失败；重试只处理失败项。
- Draft 页面显示 Chunk 级成功、失败、跳过原因和重试次数；刷新后由公开批次响应恢复最近任务及原 profile 选择。
- 本 Ticket 只产出 `schemaVersion: 1.0` 的向量记录，不写入目标数据库。

## 验收结果

- HTTP：`output/issue12-embedding-job/http-acceptance.json`。
- 浏览器：`output/issue12-embedding-job/browser-acceptance.json`，截图同目录。
- 首次任务：成功 2、失败 1、跳过 1；重试后：成功 3、失败 0、跳过 1；原失败项尝试次数为 2。
- 刷新后显示“已恢复最近一次任务”，保留 `deterministic-partial` 选择并显示“再次检查”。
- 浏览器 Console：0 error / 0 warning。
- 真实付费 Embedding 调用 0 次。

## 验证命令

- `npx tsx src/embedding-job.test.ts`
- `npx tsx src/model-workflow-ui.test.ts`
- `node qa/run-issue12-http-acceptance.mjs`
- `npm test`
- `npm run typecheck`
- `npm run build`
- `node --check app.js`
- `node --check qa/run-issue12-http-acceptance.mjs`

## 边界与剩余风险

- DashScope Embedding 的模型名称和 OpenAI-compatible 地址已有现存配置，但固定输出维度、token 限制、限流/重试发布值尚未形成确认的 `EMBEDDING_PROFILES_JSON` 生产 profile。本 Ticket 没有猜测这些值，也没有发起付费调用。
- 向量值仅保留在工作区任务记录中，尚未写入数据库；数据库 schema、索引、更新删除语义和生产凭证归属属于 Issue 13 的显式阻塞项。
- 未部署服务器、PostgreSQL 或生产迁移，未修改 Parsed Document 契约，也未把图片二进制写入向量记录或导出。
