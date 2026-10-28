# Follow-up: 全量对象化、真实供应商与生产存储准备

- 状态：local-production-like-completed-remote-and-vlm-pending
- 日期：2026-08-16
- Evidence：`output/evidence/object-storage-real-suppliers-production-readiness/`
- 历史边界：不修改 Issues 01-13、T9.5 或既有 follow-up evidence

## 本轮已完成

- 审计现有 workspace、MinIO、PostgreSQL、MinerU、VLM、Context、Embedding、导出和诊断持久化边界。
- ADR 0006 固定对象合同 `1.0`、12 类资产、checksum key、私有 metadata 投影、版本、保留、软删除、引用检查、窄 prefix GC 和审计。
- 原始上传、MinerU 脱敏响应、结果 ZIP、可信结果、Parsed Document、Office Visual Copy、图片/裁剪、受控模型输入、导出和诊断包已接入统一对象合同。
- 配置真实 MinIO 时，workspace 批次只保存对象引用和状态元数据；deterministic 无 MinIO 测试保留隔离的 workspace fallback，避免伪造跨进程内存持久化。
- 新增公开对象 list/HEAD、显式文档软删除和 batch 限定 GC API；公开 Embedding job/database record 不返回向量值或连接信息。
- 新增显式确认、资产类/batch 双限定的 lifecycle sweep API：精确 key 引用保护，失败/孤儿 7 天 override，24 小时/30 天到期，混合 live/failed 引用保护，对象级失败隔离，过期工作区维护元数据读取和幂等重复扫描均已实现。
- PDF VLM 受控输入现将整页 PNG、精确裁剪和脱敏模型输入分别写为 `pdf_page_render`、`pdf_image_crop`、`model_input`；直接图片仅在模型需要时写 `extracted_image`。图片路径改用统一 AssetObjectStore，测试/MinIO 后端均进入同一公开清单、checksum/version/audit 合同。
- ADR 0007 和 schema `2.0` 实现维度绑定、`vector(<dimension>)`、cosine HNSW、迁移历史、文档/对象 FK、幂等 upsert、软删除和非破坏性兼容。历史 `rag_vector_records_v1` 未修改。
- 新增可重复迁移 CLI、专用 `rag_restore_` 数据库备份恢复脚本和生产部署 checklist/runbook。
- 真实 MinIO production-like 验收覆盖 source、trusted result、Parsed Document、PDF crop，S3 HEAD/checksum/version、应用/MinIO 重启、专用 prefix 软删除与幂等 GC 均通过；未触碰既有 key。
- 七个指定材料分别建立独立 batch 并各提交 MinerU 一次，7/7 均完成；PDF/DOCX/PPTX/XLSX/JPG/PNG 的 source、脱敏响应、ZIP、可信结果、Parsed Document 和三份 Office Visual Copy 均可由公开 API 与 S3 HEAD 恢复。
- `产品技术白皮书.pdf` 完成 14 Chunk 代表链路：真实中文 Context、人工修改、文本修订触发 stale、重新生成与确认、真实 1024 维 Embedding、schema 2.0 pgvector 14 条写入、刷新/重启和 Contract 2.1 导出。
- PostgreSQL 容器重启后公开记录恢复通过；专用 `rag_restore_20260816162051` 数据库恢复得到 1 条迁移记录、1 条向量记录和有效 cosine HNSW 索引。备份存放于隔离 `.workspace/acceptance-backups/`，不进入 evidence。
- 专用空库 `rag_init_20260816171638` 先确认无 `rag` schema，再连续运行两次迁移；最终只有 1 条迁移记录、0 向量行、`vector(1024)` typmod、有效 cosine HNSW 和 2 个外键，未覆盖既有数据库。
- MinIO 删除验收 batch 的 `v1/_audit/` 前缀在物理 GC 后仍保留 12 个版本化审计对象：put 4、soft delete 4、physical delete 4；审计正文不经公开 API 投影。
- 新建 lifecycle 专用 MinIO batch/prefix 验证正式引用的 Office Visual Copy 30 天到期、孤儿 Source 与 failed-document Source 7 天清理、live Source 保留、公开 tombstone 投影、`expired`/`orphan` 审计、三类物理 GC 和重复 sweep 幂等；非验收 key 前后完全一致。
- 新建 fake VLM + 真实 MinIO 专用 batch 验证 `pdf_page_render`、`pdf_image_crop`、`extracted_image`、`model_input` 的公开清单、S3 HEAD/checksum/version 和统一 put 审计，0 次真实付费调用；所有专用对象版本在验收后清理。
- 新建 MinIO 备份恢复演练：3 个专用对象从版本化源 bucket 恢复到全新版本化 bucket，checksum/长度一致，恢复应用公开 list/HEAD 通过；源/恢复 batch 均显式软删除并 GC，restore bucket 随后删除。
- 浏览器通过 `?batchId=<opaque-id>` 恢复公开 batch；1440x1000 与 390x844 均无页面横向溢出或遮挡，Console 0 error/0 warning；MinIO、PostgreSQL、应用同时重启后同一浏览器会话恢复通过。
- 当前源码再次启动后复验真实白皮书 batch：1440x1000/390x844 无根级横向溢出，3 个 PDF canvas 已渲染，Context 确认状态和 Chunk 工作区可见，Console error/warning 均为 0；新截图与哈希独立记录。

## 当前剩余边界

当前服务端只有 `dashscope-context` profile，capability 为 `context`；没有已配置的 `vlm` capability 或确认的 VLM model ID。没有把 Context profile 猜测为 VLM，真实 VLM 保持 0 次。`多图片PDF.pdf` 已产生 17 个图片 Chunk，可在确认 VLM profile 后继续验收，不需要重新提交 MinerU。

`pdf_image_crop` 与 `extracted_image` 按 ADR 0006 只在 VLM 需要可信图片输入时生成并正式引用，不在解析时无差别复制 Source Document。当前未发起 VLM，所以真实七文件 batch 尚未新增这两类对象；其 checksum key、S3 HEAD、引用保留与专用删除合同已由 production-like/聚焦测试验证。

远程生产目标服务器、授权账号、域名/TLS、备份位置和维护窗口也未在工作区发现。即使本地 production-like 验收完成，远程部署仍需这些资料后才能执行。

三份超大扫描 PDF `产品宣传册_扫描版.pdf`、`采购发票_扫描版.pdf`、`产品认证证书_扫描版.pdf` 按约束保留为后续压力测试，本轮未提交付费解析。materials 中没有 MD/TXT，因此没有声称其真实材料验收完成。

## 调用计数

- 本 follow-up 真实 MinerU 提交：7（七个指定文件各 1 次）
- 本 follow-up 真实 VLM：0
- 本 follow-up 真实 Context：2（均成功）
- 本 follow-up 真实 Embedding：3 个批次（维度观察 1、HTTP/pgvector 1、代表文档 1，均成功）
- 本 follow-up 第二次付费重试：0

既有 DashScope Context 一次真实调用证据保持原样，未重复使用或修改。

## 本轮验证与证据

- `minio-production-like.json`：真实 MinIO、重启、S3 HEAD、专用删除/GC。
- `lifecycle-sweep.json`：真实 MinIO 生命周期 sweep、引用保护、公开 tombstone、审计和专用 GC。
- `page-render-minio.json`、`object-class-coverage.json`：VLM 派生对象路径与 12 类对象覆盖矩阵，明确区分真实供应商和 production-like 证据。
- `minio-backup-restore.json`：专用版本化 bucket 的备份恢复与恢复应用公开 API。
- `real-mineru-matrix.json`：七文件逐项状态、checksum、对象类别、公开 HEAD/S3 HEAD 与应用重启。
- `real-embedding-observation.json`、`real-embedding-pgvector-http.json`、`real-context-embedding-full-chain.json`：真实模型与 schema 2.0 数据链。
- `postgres-restart-http.json`、`postgres-backup-restore.json`：数据库重启和隔离恢复演练。
- `postgres-empty-init.json`：真实空库初始化、重复迁移、typmod、索引与外键。
- `minio-audit.json`：持久化 put/软删除/物理删除审计对象及版本化 HEAD。
- `browser-acceptance.json` 与三张截图：双视口、公开 HTTP、Console 和全存储重启恢复。
- `browser-current-validation.json` 与两张 current 截图：本轮对象化补强后的当前源码双视口回归。
- `completion-audit.json`：逐项审计 1-9；本地 1/2/3/4/5/7/8 通过，6/9 因外部 VLM/远程资料待完成，禁止生产完成声明。
- `npm test`、`npm run typecheck`、`npm run build`、PowerShell AST、全部 QA JavaScript `node --check` 和新增 UI focused test 均通过。
- 最终秘密扫描覆盖 203 个相关文本文件和 5 个配置秘密值：实际秘密值、evidence 凭证模式、向量载荷、binary/data URL、JSON 解析失败均为 0；8 个公开 HTTP 响应的秘密模式和向量字段均为 0。

## 待授权后执行

- 提供服务端 VLM profile ID、确认的视觉模型 ID 和部署环境凭证引用后，在已有 17 个图片 Chunk 上执行真实 VLM；不重新提交 MinerU。
- 提供生产目标主机、授权账号/最小权限边界、域名/TLS、备份位置与保留、维护窗口和回滚责任人后，按 runbook 只读核对并部署；未获这些资料前不得声称生产部署完成。
