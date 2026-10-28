# Follow-up: Issue 10 图片引用与可修订 VLM 摘要

日期：2026-08-16

来源：`.scratch/rag-document-chunking-workbench-v2/issues/10-image-reference-and-vlm-summary.md`。PRD/V21-G* 仅为历史资料，不用于本 Ticket 的范围或完成判断。

## 完成范围

- 本地 MinIO 使用 `compose.minio.yml` 启动，凭证仅来自用户级环境变量，数据写入具名卷 `rag_minio_data`。
- 新增 S3-compatible 图片对象存储边界；测试使用内存 fake，实际验收使用真实 MinIO。
- 图片 Chunk 只保存 `s3://bucket/key`、内容类型、校验和、版本/ETag 和来源类型；普通 Chunk/Contract 2.1 导出不包含图片 data URL、base64 或二进制。
- 支持 `summary`、`reference`、`exclude` 三种策略；机器摘要、人工修订、人工补充和最终生效文本分别保存。
- 保存后统一重算 token、Embedding/Context 资格；策略或生效摘要改变会将已审核 Context 标为 stale。
- VLM 缓存键包含图片校验和、profile、模型、Prompt 和文本上下文；相同输入不重复调用。
- VLM 失败只改变当前图片状态，其他图片的策略、摘要和资格保持不变。
- 修复新图片未保存策略时详情下拉错误默认到“排除”的 UI 问题。

## 验收结果

- HTTP：`output/issue10-image-reference-vlm/http-acceptance.json`。
- 浏览器：`output/issue10-image-reference-vlm/browser-acceptance.json`，截图同目录。
- MinIO 停启：`minio-persistence-before-restart.json` 与 `minio-persistence-after-restart.json`；三项对象在容器重启前后均通过 S3 HTTP HEAD，未读取对象 body。
- 三图策略：`summary`, `reference`, `exclude`；资格分别为 `true`, `true`, `false`。
- fake 调用：VLM 1 次，缓存命中 1 次；用于 stale 验收的 fake Context 1 次；真实付费 VLM 0 次。
- provenance：保存 profile ID/name、模型、Prompt 版本、生成时间与缓存状态；刷新和 Contract 2.1 导出一致。
- 浏览器 Console：0 error / 0 warning。

## 验证命令

- `npx tsx src/image-object-store.test.ts`
- `npx tsx src/image-summary-workflow.test.ts`
- `npx tsx src/model-workflows.test.ts`
- `npx tsx src/model-api-workflow.test.ts`
- `npx tsx src/v21-runtime-export.test.ts`
- `npx tsx src/model-workflow-ui.test.ts`
- `npm test`
- `npm run typecheck`
- `npm run build`
- `node --check app.js`
- `node --check qa/fake-model-server.mjs`
- `node --check qa/run-issue10-http-acceptance.mjs`
- `node --check qa/check-issue10-minio.mjs`

以上均退出码 0。

## 边界与剩余风险

- 未调用真实 VLM，未选择生产 VLM 供应商、额度、提示词发布流程或凭证归属。
- 独立图片源按原始字节保存；PDF 内图片按可信 Source Segment 生成精确裁剪资产并标记为 `pdf_crop`，未实现 PDF 内嵌图像原始编码抽取。
- 未部署服务器、PostgreSQL 或生产迁移；MinIO bucket 生命周期、公开访问和生产保留策略留待正式数据库/部署范围确认。
- 未修改 Parsed Document 契约，也未把图片二进制加入普通向量记录或导出。
