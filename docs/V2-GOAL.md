# V2 Codex Goal

## 推荐执行版（中文，可直接发送）

/goal 在现有 `D:\develop\RAG` 项目中完整实现已确认的电商文档切分工作台 V2。开始时先读取 `PROJECT_STATUS.md`，再按其中顺序读取 `docs/rag-chunking-platform-v2.md`、`docs/Consolidation.md`、`CONTEXT.md`、相关 ADR 和当前阶段 `docs/plans/*/Plan.md`；以确认的 PRD 为产品事实，以四个 Plan 的完成门禁依序实施切分内核、审阅工作台、选择性 Contextual Retrieval 和端到端验收。复用已完成且符合新契约的 V1 能力，把 `docs/Consolidation.md` 列明的缺口全部视为待开发，直到 PRD 的十二项验收标准都有证据。允许在任务依赖互不冲突时使用子智能体并行做只读调研、测试设计或独立模块工作，但主任务必须整合并验证共享工作区结果。

验证：每个工作单元先写失败测试或明确可复现证据，再做最小实现；每次有意义改动后运行最小相关检查，每个阶段至少运行 `npm test`、`npm run typecheck`、`npm run build`。涉及 UI 时启动本地服务，用真实浏览器完成核心流程，检查控制台和服务日志，验证桌面与移动视口无重叠、原文页非空、bbox 与 Chunk 双向高亮可用，并保存截图或可定位的证据。Plan 04 必须逐条核对 PRD 第 16 节十二项标准，验证从解析、Preview、Draft、人工修订、Context 审核到导出的完整流程，以及导出与页面状态一致。外部模型的自动测试使用 fake；已有有效凭证和额度时只做一次脱敏真实烟测。

约束：保持 `docs/rag-chunking-platform-v2.md`、`CONTEXT.md` 和 ADR 中已确认的产品语义；不把 Context 写回 `finalText`，不把 stale Context 放入 `embeddingText`，不静默降级语义模型，不截断受保护内容，不伪造 Source Segment。不得加入账号、多用户审核、正式文档库、向量数据库、检索评测、任意历史版本、字符级 PDF 重标注、重新 OCR、部署或 PRD 外功能。不得打印、复制或导出 `.env` 与任何 API Key。不得以重构为由改动无关代码。

边界：只写 `D:\develop\RAG` 内与 V2 直接相关的源代码、测试、固定样本、文档和本地 QA 产物；保留 V1 PRD 作为历史文档。禁止修改工作区外文件、系统配置、真实生产数据或外部账户状态。仓库内非破坏性、PRD 范围内的实现与验证均视为已授权，无需再次请求人工批准；禁止删除原始用户文件、执行破坏性 Git/文件操作、发布、推送或产生新的付费资源。

迭代策略：严格依次通过四个 Plan 的完成门禁，一次只推进一个可验证工作单元。开始前更新 `PROJECT_STATUS.md` 的当前任务；完成后立即记录修改文件、准确命令结果、证据、风险和下一步，使任务可在闪退、断网、额度中断或上下文重置后恢复。恢复时不得依赖聊天记忆，必须先核对状态文档、文件事实和测试结果。失败后先读错误、日志和相关实现；同一错误连续两次没有新证据时更换诊断方法或缩小复现。可做最多三轮有证据的聚焦改进，不能用重复重试掩盖阻塞。发现用户或其他任务的并行改动时保留并与之协作，不回退不属于本目标的变化。

完成条件：四个 Plan 的完成门禁全部通过；PRD 第 16 节十二项验收标准均在 `PROJECT_STATUS.md` 中有命令、测试、浏览器操作、截图或日志证据；`npm test`、`npm run typecheck`、`npm run build` 最终通过；本地应用完整流程成功；README 和状态文档准确；无未处理的高严重度缺陷；最终报告列出实现结果、验证证据、运行地址和残余风险。只有达到这些条件才能把 Overall status 标为 `completed` 并停止，不能把局部原型或跳过的外部调用当作完成。

暂停条件：仅在必需凭证不存在或失效、继续会产生新付费、需要生产数据或外部账户操作、需要破坏性删除/迁移、PRD 与可验证事实发生会改变产品方向的冲突、连续三轮基于不同证据仍无法推进同一关键门禁，或用户新指令明确要求暂停时停止并报告。普通仓库内编辑、依赖使用、测试、启动本地服务、浏览器 QA、非破坏性修复和已确认范围内的技术选型不构成暂停理由。

## Goal Draft (English-compatible)

/goal Fully implement the confirmed ecommerce document chunking workbench V2 in `D:\develop\RAG`. Start by reading `PROJECT_STATUS.md`, then follow its recovery order through the confirmed PRD, Consolidation, domain glossary, ADRs, and the active phase Plan. Treat the PRD as product truth and pass the four Plan gates in order: chunking core, review workbench, selective Contextual Retrieval, and end-to-end acceptance. Reuse verified V1 capabilities only where they satisfy the V2 contracts, and treat every gap in Consolidation as open work. Parallel sub-agents may handle independent read-only research, test design, or isolated modules when dependencies do not conflict, but the primary task must integrate and verify all shared-workspace results.

Verification: establish a failing test or explicit reproduction before each focused implementation; rerun the smallest relevant checks after meaningful changes and run `npm test`, `npm run typecheck`, and `npm run build` at every phase gate. For UI work, start the local service, complete the core workflow in a real browser, inspect console/server logs, verify desktop and mobile layouts, nonblank source pages, and bidirectional bbox/Chunk highlighting, and retain locatable screenshot or log evidence. Plan 04 must explicitly verify all twelve PRD acceptance criteria and the complete parse-to-export workflow. Use fake model clients in automated tests and perform at most one redacted real-model smoke test when valid credentials and quota already exist.

Constraints: preserve the confirmed PRD, glossary, and ADR semantics. Never merge Context into `finalText`, include stale Context in `embeddingText`, silently downgrade semantic behavior, truncate protected content, fabricate Source Segments, expose secrets, add excluded product features, or refactor unrelated code.

Boundaries: write only V2-related source, tests, fixtures, docs, and local QA artifacts inside `D:\develop\RAG`; preserve the V1 PRD. Do not modify external files, system configuration, production data, or external account state. Non-destructive in-repo implementation and verification within the confirmed PRD are pre-authorized without further approval. Do not delete user source files, perform destructive Git/filesystem operations, publish, push, or create new paid resources.

Iteration policy: pass the four Plan gates in order and advance one verifiable work unit at a time. Update `PROJECT_STATUS.md` before and after each unit with files, exact check results, evidence, risks, and next action. Recover from interruption using durable files and rerun uncertain commands instead of trusting chat memory. Inspect errors and logs before retrying; after two failures without new evidence, change the diagnostic method or reduce the reproduction. Make at most three evidence-based focused improvement rounds. Preserve concurrent user changes and never revert unrelated work.

Stop when: every Plan gate and all twelve PRD acceptance criteria have recorded evidence, final test/typecheck/build commands pass, the complete local browser workflow succeeds, README and status are accurate, and no high-severity issue remains. Mark the project completed only then and report the implementation, evidence, local URL, and residual risk.

Pause if: required credentials are missing or invalid, continuing would incur new cost, production data or external-account action is required, a destructive deletion/migration is necessary, verified facts conflict with the PRD in a way that changes product direction, three distinct evidence-based attempts cannot pass a critical gate, or the user explicitly pauses the work. Normal local editing, testing, service startup, browser QA, non-destructive fixes, and in-scope architecture decisions are not pause conditions.
