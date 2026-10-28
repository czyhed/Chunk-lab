# Follow-up Ticket: V21-G3 浏览器与导出门禁完成

- 状态：complete
- 日期：2026-08-16
- 前置：V21-G1、V21-G2 complete；DashScope Context 真实 smoke complete
- 证据：`output/playwright/v21-plan03-*` 与 `.workspace/v21-plan03-*`

## 目标

补齐 V21-G3 尚缺的确定性 fake Context 浏览器证据：selected-only、单项失败隔离、失败重试、人工 fallback、确认后 stale、刷新恢复、Contract 2.1 embedding/export 规则、桌面/移动响应式、脱敏网络和 clean service logs。不得增加真实付费调用或推进 G4 迁移。

## 实现

- 更新 `qa/start-plan03-app.mjs`，为现有 fake Context 服务配置当前前端要求的 `MODEL_PROFILES_JSON` profile，并使用隔离的 Temporary Workspace。
- 4181 被无法确认归属的既有 Node 进程占用，QA 应用使用 4182；未终止或修改该既有进程。
- 未修改 Context 领域逻辑、Parsed Document、历史 Ticket/evidence 或生产 DashScope 配置。

## 浏览器验收

- 从 3 个合格 Chunk 中任意选择 Chunk 1 和 Chunk 3；fake 调用恰好 2 次，1 成功、1 失败，未选择的 Chunk 4 保持 `not_generated`。
- 图片 Chunk 不合格并显示图片摘要入口，不出现可调用的 Context 复选框。
- 失败 Chunk 重试 1 次后仍保持 `failed`；保存人工 Context 后为 `human_modified`。
- 成功 Chunk 从 `awaiting_review` 确认到 `confirmed`；修改 finalText 后变为 `stale`，旧 Context 保持可见但不进入 embeddingText。
- 刷新后 `human_modified`、`stale` 和未选择状态全部恢复。
- fake 总调用 3 次：成功 1、失败 2；真实外部调用 0。

## 导出、响应式与日志

- Contract 2.1 Manifest 为 completed/exported。人工 Context 导出为 Context + finalText；stale 与未生成 Context 的 embeddingText 都只使用 finalText。
- stale 导出保留 `fake-context-v1`、profile ID/name、实际 scope 和跳过邻居审计；普通导出没有 secret-like 字段或原始 fake 错误。
- 1440x1000 与 390x844 均满足 `scrollWidth == clientWidth`，越界控件 0，Console 错误/警告 0。
- 应用 stdout/stderr 与 fake stdout/stderr 最终均为 0 字节。

## 证据文件

- `output/playwright/v21-plan03-p03-02-desktop-1440.png`
- `output/playwright/v21-plan03-p03-02-mobile-390.png`
- `output/playwright/v21-plan03-g3-browser-summary.json`
- `output/playwright/v21-plan03-g3-export-comparison.json`
- `.workspace/v21-plan03-p03-02.out.log`
- `.workspace/v21-plan03-p03-02.err.log`
- `.workspace/v21-plan03-fake.out.log`
- `.workspace/v21-plan03-fake.err.log`

## 门禁结果

P03-01 至 P03-04 聚焦测试、`npm test`、`npm run typecheck`、`npm run build`、`node --check app.js`、`node --check qa/start-plan03-app.mjs` 和 `node --check qa/fake-context-server.mjs` 全部退出 0。证据 JSON 可解析，真实凭证精确匹配和通用 secret/raw-error 模式匹配均为 0。V21-G3 可以关闭；V21-G4 仅进入入口状态，未在本 Ticket 中实施。

## 剩余风险

- fake 服务只证明确定性契约，不证明真实模型质量、限流或长期稳定性；真实 DashScope 单次成功证据记录在独立 follow-up Ticket。
- 无真实客户文档或 licensed Office 语料；这些限制继续交给 V21-G4，不得以 demo/fake 证据替代。
