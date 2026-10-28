# Follow-up: Issue 13 本地 PostgreSQL 持久化验收

日期：2026-08-16

来源：`.scratch/rag-document-chunking-workbench-v2/issues/13-database-persistence.md`。本 Ticket 只推进已获授权的本地 Docker PostgreSQL + pgvector 测试，不改变生产部署边界。

## 完成范围

- `compose.postgres.yml` 使用 `pgvector/pgvector:pg16`，仅绑定 `127.0.0.1:54329`，具名卷 `rag_pg_data`，健康检查和扩展版本 `vector 0.8.6` 已验证。
- 数据库 profile 由 `DATABASE_PROFILES_JSON` 提供；凭证只通过 `RAG_PG_USER`、`RAG_PG_PASSWORD`、`RAG_PG_DATABASE` 环境变量引用，公开目录不返回连接字段。
- 新增数据库任务创建、查询、失败项重试和记录查询 API；任务状态和 Chunk 级写入/未变化/删除/失败/跳过原因可见，公共批次刷新恢复最近任务。
- 本地 schema `rag_vector_records_v1` 保存文本/表格结构化 payload、图片对象引用、向量、来源、策略 hash、Context 版本和 schema 版本；向量值不从公开记录查询返回。
- 主键幂等 upsert、内容哈希变化判断、单项失败隔离、排除项隔离和单 Chunk 重生成均已自动化与 HTTP 验收。

## 验收结果

- 自动化：`npx tsx src/database-job.test.ts` 通过，覆盖 fake repository、维度/schema/图片二进制保护、局部失败重试、幂等未变化、删除替换。
- HTTP：`output/issue13-database-persistence/http-acceptance.json`。
- PostgreSQL 重启：`output/issue13-database-persistence/postgres-restart-acceptance.json`，重启后公开查询 200，仍返回 7 条记录。
- 浏览器：`output/issue13-database-persistence/browser-acceptance.json`，截图同目录。
- 付费调用：真实 Embedding 0 次，真实 VLM 0 次。

## 未扩展部分

- 没有服务器部署、生产 PostgreSQL、生产迁移、数据删除或 MinIO 生产 bucket/URL/保留策略决策。
- 本地 schema 和 `pgvector` 索引只用于当前验收；生产 schema、索引参数、连接方式、删除/替换语义和凭证归属仍需单独确认后才能作为生产合同。
