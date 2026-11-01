# Project Status

## MinerU 图片裁剪坐标修复 (2026-08-28)

- 根因：MinerU 图片 Block 的 `bbox` 使用 `bboxEvidence.pageWidth/pageHeight` 所声明的坐标范围（常见为 `1000 x 1000`），可信图片裁剪曾直接按 PDF 实际页面尺寸解释该 bbox，导致裁剪框被错误压到页面边界并报“图片裁剪范围未命中原始 PDF”。
- 修复：`src/manual-chunk-generation.ts` 在生成 Chunk 时保留 `bboxEvidence`；`src/trusted-image-input.ts` 按证据坐标范围映射到实际 PDF 页面，并处理顶左/底左坐标原点。该修复不放宽 Source Block、图片资产或版本校验。
- 验证：`npx tsx src/manual-chunk-generation.test.ts`、`npx tsx src/manual-chunk-generation-http.test.ts`、`npx tsx src/image-summary-workflow.test.ts`、`npm run typecheck`、`npm run build` 均通过。提交 `40693b9`，标签 `v0.1.26` 已推送。
- 约束：图片“仅引用”仍需有效图片资产和同文档有效文字 Chunk；修复只纠正 MinerU bbox 到 PDF 的坐标映射，不绕过 VLM/Embedding/版本门禁。

## SPU 商品资料 Ticket Checkpoint (2026-08-26)

- V1.1 PRD 与 Tickets 已按共同理解更新并收口；01 创建、02 搜索复用、03 规范文件名、04 多 SPU 验收均完成。依赖关系为 `01 -> 02/03 -> 04`。
- 本轮补齐了严格 SPU ID、文档类型确认、候选请求乱序防护、类目搜索、导出身份精确复用、未知新 SPU 拒绝及范围变更时失效 Chunk 重置。
- 浏览器证据：`output/playwright/spu-catalog-v1-1/desktop.png`、`output/playwright/spu-catalog-v1-1/mobile.png`；移动端 `scrollWidth=clientWidth=390`，已选 SPU=1。未完成审核 Chunk 的 Markdown 导出按门禁正确阻断。

- Ticket 01-05：实现、focused tests、真实 `materials/pdf/多图片PDF.pdf`、真实 Embedding 1024 维和 pgvector 写入已完成；当前代码提交为 `52e7b8d`、`ca9a606`。
- 真实验收 batch/document：`177020b4-a5ed-4da0-b270-2d43a2f7710a` / `0c6063d4-a0ae-4df0-ab6e-901907026d6b`，Review Revision 56，目标 SPU 为 `REAL-SPU-001`、`REAL-SPU-002`。
- Markdown：两个 SPU 均生成 `v2`，状态 `complete_with_exclusions`；失败/阻断尝试已持久化并通过 `latestAttempt` 暴露，current 仍只指向最后成功版本。
- Embedding：真实 profile `real-embedding-1024` 返回 1024 维，55 个 Chunk 中 38 成功、17 跳过；DatabaseJob 使用 pgvector schema 2.0，写入 38、跳过 17。
- 证据：`output/evidence/spu-real-pdf-acceptance-2026-08-26.json`；Impeccable detector：`output/evidence/spu-ui-impeccable-detector.json`。
- Ticket 06：`completed-real-pdf-browser-acceptance`。真实 PDF 桌面 1440x1000 与移动 390x844 均完成 Markdown/Embedding 对话框、结果列表、刷新恢复和无水平溢出检查；证据：`output/evidence/spu-browser-acceptance-2026-08-26.json` 及配套截图。
- 已知限制：本次真实服务 `/objects` 列表接口超时；Markdown/Manifest GET 成功。完整 `pnpm test` 的既有 health timeout 仍需单独记录。

## Recovery Entry Point

Read this file first after any crash, network interruption, quota failure, or context reset. Then read, in order:

1. `.scratch/rag-document-chunking-workbench-v2/issues/01-13` in numeric order
2. `CONTEXT.md`, `AGENTS.md`, and relevant ADRs
3. Current source, tests, Tickets, and independent evidence
4. This status file for recovery context only

PRD, V21-G* and `docs/plans` remain historical material. They are not Ticket ordering, start, or completion gates.

Never infer completion from chat history alone. Verify files and rerun the smallest relevant check before resuming.

## Current State

### Bug-fix tickets 15-24 checkpoint (2026-08-23)

- Tickets 15-23 are implemented and locally browser-verified. The real `materials/pdf/多图片PDF.pdf` run produced 23 pages, 257 source blocks and 55 Preview/Draft Chunks; parse defaults, completion copy, source ordering, annotation controls, six-item candidate windows, table overflow, table retrieval persistence, removed panels, Context counts and integration copy were exercised.
- Embedding completed with 38 successful items and 17 skipped items. The explicit local-only database acceptance adapter wrote 38 and skipped 17; startup rejects that adapter in production. Recall@5 used one human-confirmed relevant table Chunk and returned 1/1 hits (100%) across 38 indexed records and 55 Draft Chunks after a server restart.
- Table retrieval version validation returned 400 for empty summary, cross-document source and stale source version, then 200 for a valid save. Refresh restored version `2467ad2d-e964-4d56-bcfa-3c632d47de67`, its ordered source relation and `vectorReady=true`.
- Ticket 24 is `completed-local-and-server-version-acceptance`. Commit `e258238` and tag `v0.1.11` were pushed, and the deployed server restored the real PDF workspace with the new controls: “处理完成”, unified “合并”, and “检索测试”; the removed demo and separate cross-page controls were absent.
- Fresh verification passed: `npm test`, `npm run typecheck`, `npm run build`, `node --check app.js`, focused Recall/database/manual-annotation/candidate tests, and browser interaction checks. Evidence: `output/playwright/bugfix-15-24-real-pdf-recall.png` and `output/playwright/bugfix-v0.1.11-server-version.png`.

- Overall status: `in_progress`
- Active sequence: `formal Issues 01-13`
- Current work item: `Issue 13 local PostgreSQL + pgvector acceptance completed; production deployment remains out of scope`
- V2.1 implementation: `in_progress`
- Last durable checkpoint: `2026-08-16 Issues 01-13 local acceptance complete; production deployment remains out of scope`
- Next action: no later formal Issue exists; keep production PostgreSQL/MinIO deployment and schema decisions separate until explicitly authorized
- Blocking issue: production PostgreSQL/MinIO connection, schema/index, update-delete retention semantics and credential ownership remain unconfirmed; local Docker acceptance is complete

### Issue Sequence Checkpoint (2026-08-16)

- Issues 01-09: current source, tests, and evidence audited complete in `output/issue-audit-01-09/README.md`.
- Issue 10: local MinIO and three image strategies completed with fake VLM, browser/HTTP acceptance, persistence restart evidence, and zero paid VLM calls. See `docs/tickets/FOLLOWUP-issue-10-image-reference-vlm.md`.
- Issue 11: current Context lifecycle, eligibility, stale, refresh, export and existing one-call DashScope evidence audited complete. See `output/issue11-context-enhancement-audit/README.md`.
- Issue 12: server model catalog, versioned vector jobs, idempotency, eligibility filtering, partial failure, retry and refresh recovery completed with deterministic fakes and zero paid Embedding calls. See `docs/tickets/FOLLOWUP-issue-12-embedding-job.md`.
- Issue 13: local Docker PostgreSQL + pgvector persistence completed; hardcoded prototype vendors were replaced by a server database catalog. Production deployment/migration remains out of scope. See `docs/tickets/FOLLOWUP-issue-13-database-persistence.md`.

### V21-G3 Gate Completion (2026-08-16)

- Deterministic browser QA selected 2 of 3 eligible Chunks. The fake adapter recorded exactly 2 initial calls with 1 success and 1 isolated failure; the unselected Chunk remained `not_generated` and the ineligible image required a reviewed summary.
- One explicit retry remained failed, then manual fallback persisted as `human_modified`. The successful Context was confirmed, became `stale` after finalText changed, remained review-visible and was excluded from embeddingText. Refresh restored all three states.
- Contract 2.1 export matched Context/final text/profile/scope/skipped-neighbor fields. Human Context composed with finalText; stale and unreviewed Context did not. Manifest delivery was completed/exported and ordinary export secret scans passed.
- Browser evidence at 1440x1000 and 390x844 has no horizontal overflow or out-of-bounds controls; Console errors/warnings are zero. Final app/fake stdout and stderr logs are zero bytes.
- P03-01 through P03-04 focused checks, `npm test`, `npm run typecheck`, `npm run build`, and syntax checks for `app.js`, `qa/start-plan03-app.mjs`, and `qa/fake-context-server.mjs` all exited 0.
- Evidence: `docs/tickets/FOLLOWUP-v21-g3-browser-completion.md`, `output/playwright/v21-plan03-p03-02-desktop-1440.png`, `output/playwright/v21-plan03-p03-02-mobile-390.png`, `output/playwright/v21-plan03-g3-browser-summary.json`, `output/playwright/v21-plan03-g3-export-comparison.json`, and `.workspace/v21-plan03-*` logs.
- Gate decision: `V21-G3=completed`; `V21-G4` is now the active formal gate. No Legacy migration, deletion, replacement or G4 implementation occurred in this checkpoint.

### DashScope Context Real Acceptance Follow-up (2026-08-16)

- Preserved the existing `EMBEDDING_*` configuration and added one `MODEL_PROFILES_JSON` Context profile. Its `apiKey` references `EMBEDDING_API_KEY`; the server resolves the reference without duplicating or publicly exposing the credential.
- `GET /api/model-profiles` returned one `context` profile. Browser Draft controls selected it and enabled generation only for eligible Chunks.
- Exactly one real paid Context request used the configured `qwen3.7-flash-2026-07-15` profile; there were zero retries and zero VLM calls. It returned Chinese Context, moved through awaiting review to confirmed, survived refresh, and matched Contract 2.1 Context/final/source/revision fields. Export recomputed the exact confirmed Context plus finalText embedding composition.
- Acceptance found and fixed a provenance bug: new profile generations now persist `profile.model` in `contextModel`, while `contextProfileId/name` remain separate. The already confirmed temporary smoke record was not migrated and no second paid call was made.
- Desktop 1440x1000 and mobile 390x844 had matching client/scroll widths, zero out-of-bounds controls and zero Console errors/warnings. Evidence is under `output/evidence/dashscope-context-followup/`; historical T9.5 evidence is unchanged.
- Focused profile/model/Context/export/T9.5 checks and final `npm test`, `npm run typecheck`, `npm run build`, and `node --check app.js` passed. G3 remains in progress because its required deterministic fake browser failure/retry/manual/stale workflow has not been relabeled from older evidence or rerun in this follow-up.

### P03-03 And P03-04 Domain Completion Checkpoint

- P03-03 implemented strict Contract 2.1 and Legacy selection, explicit-field runtime Draft projection, and a partial Manifest with completed/pending/failed entries. Green evidence: `npx tsx src/v21-export-manifest.test.ts`, `npx tsx src/v21-runtime-export.test.ts`, `npx tsx src/export.test.ts`, `npx tsx src/workspace.test.ts`, and `npm run typecheck` exited 0.
- P03-04 implemented an independent allowlisted diagnostic package with recursive secret/request stripping and 24-hour expiry, plus an explicit public batch-response allowlist. Green evidence: `npx tsx src/v21-diagnostic-package.test.ts`, `npx tsx src/v21-public-batch.test.ts`, `npm run typecheck`, and `node --check app.js` exited 0.
- Changed files in these units: `src/v21-export.ts`, `src/v21-export-manifest.test.ts`, `src/v21-runtime-export.ts`, `src/v21-runtime-export.test.ts`, `src/v21-diagnostic-package.ts`, `src/v21-diagnostic-package.test.ts`, `src/v21-public-batch.ts`, `src/v21-public-batch.test.ts`, `src/workspace.ts`, and `src/server.ts`.
- Red integration evidence: the browser has no Contract selector, separate Manifest download, or document-scoped diagnostic package action, so server contracts cannot yet be exercised from the workbench. Full `npm test`/build and G3 HTTP/browser evidence have not been rerun after the completed domain changes.
- Gate boundary: P03-01 through P03-04 domain slices are implemented, but `V21-G3` remains `in_progress` until UI integration, HTTP assertions, Draft/export comparison, desktop/mobile evidence and the full gate pass.

### P03-01 Red Checkpoint

- Public seams: `generateSelectedContexts(...)` for selected-only isolated generation and `buildContextPackage(...)` for the model-visible package; the existing server Context route remains the integration seam after the domain slice is green.
- Assumption: Contract 2.1 safe source blocks expose only stable identity, safe `searchText`, grouping and source metadata needed for scope. `raw`, `rawTableHtml`, `display`, `displayHtml` and diagnostic fields are not accepted by the Context package builder.
- Reproducible red target: an eligible selected Chunk calls the fake exactly once; an ineligible selected Chunk is rejected before any fake call; an unselected Chunk remains `not_generated`; sentinel HTML/raw/diagnostic values are absent from every model-visible string.
- Gate order remains strict: P03-01 is active; P03-02 through P03-04 and V21-G4 are not started.

### P03-01 Completion Checkpoint

- Red evidence: `npx tsx src/v21-context-selection.test.ts` exited 1 because the old Context builder consumed Contract 2.1 blocks as legacy Parsed Blocks, omitted safe `searchText`, and produced `undefined` model input.
- Implemented an explicit `ContextSourceBlock` allowlist, atomic target eligibility preflight before every model call, and a server projection from `parsedDocumentV21.blocks`; raw, display, HTML and diagnostics are not representable in the model package.
- Green evidence: `npx tsx src/v21-context-selection.test.ts`, `npx tsx src/contextual.test.ts`, `npx tsx src/context-review.test.ts`, and `npm run typecheck` all exited 0 on 2026-08-13.
- Changed files: `src/v21-context-selection.test.ts`, `src/contextual.ts`, `src/contextual.test.ts`, `src/context-review.ts`, `src/context-review.test.ts`, `src/server.ts`, `src/test.ts`, and this status file.
- Residual for P03-02: adjacent eligibility filtering, skipped reasons, stale fingerprint coverage, nullable embeddingText, and corresponding UI state are intentionally not claimed by P03-01.

### P03-02 Completion Checkpoint

- Red evidence: `npx tsx src/v21-context-eligibility.test.ts` exited 1 because the short-document package included an ineligible neighbor sentinel and had no skipped-neighbor audit.
- Implemented eligible-neighbor filtering with `skippedNeighborReasons`, safe short-document block filtering, a single fail-closed nullable `embeddingTextFor`, and stale fingerprints for source ranges, product/parent/group identity and approved enrichment while excluding quality/display/order-only changes.
- Green evidence: `npx tsx src/v21-context-eligibility.test.ts`, `npx tsx src/contextual.test.ts`, `npx tsx src/context-review.test.ts`, `npx tsx src/context-client.test.ts`, `npx tsx src/export.test.ts`, and `npm run typecheck` all exited 0 on 2026-08-13.
- Changed files: `src/v21-context-eligibility.test.ts`, `src/contextual.ts`, `src/contextual.test.ts`, `src/context-review.ts`, `src/context-review.test.ts`, `src/context-client.test.ts`, `src/chunking.ts`, `src/export.test.ts`, `src/test.ts`, and this status file.
- Residual for P03-03/P03-04: current server export still silently filters incomplete documents; Contract formats, partial Manifest, strict V2.1 fields, independent diagnostics and public response allowlists remain open.

### P02-04 Review Action Integration Red Checkpoint

- Public seam: `POST /api/batches/:batchId/documents/:documentId/review/actions`, persisted Draft response, and the browser controls that issue one named action.
- Reproducible red evidence: `PUT /api/batches/:batchId/documents/:documentId/review` still calls `restoreReviewState(request.body.reviewState)` and accepts client-authored derived fields; `app.js` still computes split, merge, source changes, exclude/restore, undo and redo in the browser before uploading the full ReviewState.
- Domain candidate evidence: `npx tsx src/v21-review-actions.test.ts` and `npm run typecheck` both passed on 2026-08-13, but no server route or browser integration exists yet, so this is not a G2 gate pass.
- Assumption: action `restore` means restoring an excluded Chunk; restoring automatic text continues to use the typed reviewed-model route. Source boundary changes may replace the Chunk ID and deliberately downgrade mapping to `block-only/parsed_only` without inventing ranges or bbox.

### V21-G2 Gate Completion

- Status: `completed` on 2026-08-13. Plan 01 evidence was present before G2 began; Plan 03 did not start early.
- Server boundary: `POST .../review/actions` owns exclude/restore, split, overlap-safe merge, source create/add/remove and undo/redo. Legacy whole ReviewState writes return 410; injected derived fields return 400. Structural replacements use deterministic IDs and invalidate eligibility until typed repair.
- Focused tests passed: viewer, Preview Gate, reviewed-model recomputation, recompute scope, PDF surface and review actions. Final `npm test`, `npm run typecheck`, `npm run build`, and `node --check app.js` all exited 0.
- Desktop/mobile evidence: all four `output/playwright/v21-plan02-*` screenshots have the exact required dimensions. Two 595x842 PDF canvases are nonblank; exact overlay count is 1; source/Chunk locking, Esc clear, dirty Preview gate, Draft repair/actions and refresh recovery pass; desktop/mobile overflow and out-of-bounds controls are 0; browser console errors/warnings are 0.
- Screenshot SHA256: P02-01 desktop `F777CDBE63473E7A68A35D7F00C91F70DEA61F581048A2DF0CEED110F9F7A242`; P02-01 mobile `5AC3C16F8BEC6F88E09CC7B21912DACF422E2FF61EBD35AA8EE93525A03C0709`; P02-04 desktop `E7E879C711A8FAF90A83E8E46D6DB333F9D591C2B0CA15838347E5FA239B1F4D`; P02-04 mobile `4D654B68BE9E28C53B5BF4FF6D8C1F1EABD44A21D622E5033D078705A1DAD458`.
- `.workspace/v21-plan02-p02-04.out.log` and `.err.log` are zero-byte runtime evidence after normal requests. They are held open by the QA service, so no stable file hash is claimed.
- Residual G2 risk: Office Visual Copy has deterministic fake-adapter coverage but no licensed real-Office browser smoke; carry this explicitly to G4. V2.1 remains `in_progress`.

### V2.1 Plan Deliverables

- `docs/plans/v21-01-input-normalization-chunking/Plan.md` (`V21-G1`, pending implementation)
- `docs/plans/v21-02-review-workbench/Plan.md` (`V21-G2`, pending implementation)
- `docs/plans/v21-03-contextual-retrieval-export/Plan.md` (`V21-G3`, pending implementation)
- `docs/plans/v21-04-migration-ui-acceptance/Plan.md` (`V21-G4`, pending implementation)
- `docs/Consolidation.md` now contains the `PRD 2.0 Plan Consolidation` chapter and retains the historical V2 consolidation above it.

The plan-writing objective is complete. No V2.1 source code, test logic, dependency, runtime data, browser screenshot, external model call, migration, deployment or production operation was performed in this work item. Existing baseline commands below are evidence for V2 only.

### Active V2.1 Implementation Checkpoint

- Gate order remains `V21-G1 -> V21-G2 -> V21-G3 -> V21-G4`; G1 and G2 are completed and only G3 is active.
- Confirmed test seams are the server input/parse contract, normalized Parsed Document and Preview public interfaces, authoritative review/export routes, and real browser workflow defined by the Plans.
- Initial expected P01-01 red evidence: no complete Office-direct-to-MinerU routing contract, no independent Visual Copy lifecycle/version/converter state, and no proof that Visual Copy failure leaves parsing/chunking available.
- Red evidence recorded: `npx tsx src/v21-input.test.ts` exited 1 with `ERR_MODULE_NOT_FOUND` for `src/v21-input.js`; the new public-contract test requires original DOCX bytes at MinerU and a non-blocking `visual_copy_unavailable` failure state.
- Files changed at red checkpoint: `src/v21-input.test.ts` only; implementation has not yet been added.

### P01-01 Completion Checkpoint

- Red evidence: `npx tsx src/v21-input.test.ts` first failed with `ERR_MODULE_NOT_FOUND`; later format-matrix and failed-retry slices failed for missing `classifySource` and incorrect `visual_copy` fallback respectively. `npx tsx src/v21-visual-copy.test.ts` first failed because its module did not exist.
- Implemented `src/v21-input.ts`, `src/v21-upload.ts`, `src/v21-visual-copy.ts` and integrated them in `src/server.ts`; tests are `src/v21-input.test.ts`, `src/v21-upload.test.ts`, and `src/v21-visual-copy.test.ts`.
- Office DOCX/PPTX/XLSX original source remains in the existing MinerU upload batch; Visual Copy runs independently through installed Word/PowerPoint/Excel COM and cannot replace MinerU input. MD/TXT remain local; unsupported extensions fail explicitly.
- Visual Copy persists `not_requested/generating/ready/failed`, supports independent retry and read routes, and failure leaves parsing/downstream availability intact. When page dimensions/mapping are not yet measured, metadata is empty/unavailable rather than invented.
- Green evidence: `npx tsx src/v21-input.test.ts`; `npx tsx src/v21-upload.test.ts`; `npx tsx src/v21-visual-copy.test.ts`; full `npx tsc --noEmit --pretty false` all exited 0 on 2026-08-13.
- Residual P01-01 risk: fake tests validate COM process composition; a real Office fixture smoke and PDF page metadata extraction remain for later controlled fixture/browser evidence.
- Next action: complete and review P01-02 four-layer normalization; `V21-G1` remains open.

### P01-02 Completion Checkpoint

- Red evidence: `npx tsx src/v21-normalization.test.ts` first exited 1 with `ERR_MODULE_NOT_FOUND`; CommonMark conformance slice then failed because the old block parser returned `> **警告**` markup in Search Text.
- Implemented `src/v21-contract.ts` and `src/v21-normalization.ts`; added `src/v21-normalization.test.ts`; added `commonmark@0.31.2` and its TypeScript declarations because PRD 2.0 explicitly requires CommonMark AST.
- All ten first-class types remain typed; unknown content is `unsupported`; each block separates diagnostic raw, typed normalized, safe display, deterministic tag-free searchText, normalization status, immutable automaticText and initial finalText. Raw table HTML and runtime fields cannot enter semantic text.
- Markdown uses CommonMark AST/source positions with UTF-16 source ranges; TXT retains UTF-16 ranges. Fenced code replays the original range so CRLF and source code are not rewritten.
- Green evidence: `npx tsx src/v21-normalization.test.ts`, `npx tsx src/mineru.test.ts`, and `npm run typecheck` exited 0 on 2026-08-13. `npm install` reported 0 vulnerabilities.
- Next action: P01-03 provenance/protected models and P01-04 eligibility/versioning red-green slices; G1 remains open.

### P01-03 Through P01-05 Domain Checkpoint

- P01-03 red: `npx tsx src/v21-provenance.test.ts` exited 1 with missing module. Green: provenance, normalization, ecommerce fixtures and typecheck passed. The implementation is `src/v21-provenance.ts` plus its test.
- P01-04 red: `npx tsx src/v21-eligibility.test.ts` exited 1 with missing module. Green: eligibility, versioning and typecheck passed. The implementation is `src/v21-eligibility.ts` plus two tests.
- P01-05 red: `npx tsx src/v21-preview.test.ts` exited 1 with missing module; a later protected-code slice failed because one code source appeared in two overlapped Chunks. `src/v21-preview.ts` now reuses the existing splitter through a Search Text-only adapter and protects formula/code/warning/unsupported boundaries.
- Green P01-05 evidence: `npx tsx src/v21-preview.test.ts`, `npx tsx src/chunking.test.ts`, and `npm run typecheck` passed. Four strategy names, size sensitivity, traceable Overlap, semantic failure propagation, Contract 2.1 metadata, eligibility and versioned Source Segments are covered.
- Main review confirmed bbox evidence is rejected when incomplete, stale or out of bounds; no clamping/inference exists. Raw/display fields are removed from ordinary semantic projections. Location quality is independent from embedding eligibility.
- Next action: connect MinerU/local normalized V2.1 Parsed Documents and `buildV21Preview` to server runtime, then run the full `V21-G1` gate.

### V21-G1 Gate Completion

- Status: `completed` on 2026-08-13. `qa/v21-g1-contract-evidence.json` records the sanitized contract matrix and exact final commands.
- Final commands all passed: `npm test` (all V2 regression suites plus nine V2.1 suites), `npm run typecheck`, `npm run build`, and `node --check app.js`.
- Static scans: secret-like patterns `0`; guessed bbox patterns `0` across `src/v21-*.ts`.
- Runtime integration: supported input routing, independent Office Visual Copy and retry, MinerU raw allowlist, CommonMark/TXT Parsed Documents, structured HTML table normalization, qualification, versioned Source Segments and Contract 2.1 Preview are connected to `src/server.ts`.
- Residual G1 risk carried to G4: fake runner proves Office COM composition; a real fixed Office file and visual page metadata smoke remains required. No external model or credential was used.
- Next action: execute Plan 02 P02-01 red evidence. V2.1 remains `in_progress`.

### Current Work Item Assumptions And Red Evidence

- The eight deterministic fixtures are sanitized contract samples because no licensed real-world set is locally available; this limitation remains explicit in final evidence.
- Fixture boundaries are compared with ordered unique `SourceSegment.blockId` values emitted by `buildChunkPreview` under the confirmed Structure-Aware defaults.
- Work item 04.1 was reopened after an ad hoc real-preview run disagreed with five annotated fixtures. The prior fixture test only validated fixture shape and therefore did not prove expected Chunk boundaries.
- Work item 04.1 passed after real `buildChunkPreview` assertions covered all eight fixtures, a true 80-row oversized table exercised safe row groups, and protected-group/product/cross-page source defects were corrected.
- Expected red evidence for work item 04.2: `GET /api/batches/:id` lets one `downloadMineruResult` exception abort the whole poll, no document retry/reparse route exists, and no test proves comprehensive derived-state invalidation.
- Work item 04.2 passed: per-document result download failures are isolated, MinerU retry jobs no longer replace an active batch job, reparse requires confirmation, and reparse clears Parsed Document plus all derived review state.
- Work item 04.3 passed: Temporary Workspace expires after 24 hours; source rendering uses a current-page window; Source/Chunk controls support Enter/Space; tabs and live states expose ARIA; collapsed rail controls are inert.
- Work item 04.4 passed: one continuous local Markdown workflow covered parse, Preview, Draft, selected Context success/failure, confirmation, manual fallback, stale invalidation, field-by-field export comparison, and reparse cancel/confirm.

- Context Candidate recommendations are deterministic PRD rules and do not call an LLM.
- Context generation receives blocks from exactly one `DocumentRecord`; product-document isolation is therefore enforced at the API boundary and repeated in the Context package.
- A special `上下文不足` response is valid even though normal Context output must contain 2-4 sentences.
- Existing `human_modified` Context cannot be regenerated unless the caller explicitly authorizes overwrite.
- Expected red evidence for work item 03.1: `npx tsx src/contextual.test.ts` failed with `ERR_MODULE_NOT_FOUND` for `src/contextual.js`; no Context domain implementation existed.

## Completed

- V1 prototype exists.
- V2 product interview and domain modeling are complete.
- V2 PRD is confirmed.
- Consolidated baseline and four execution plans exist.
- PRD 2.0 has been decomposed into four sequential, executable V2.1 Plans; the planning deliverable is complete while all four implementation gates remain pending.
- Baseline `npm test`, `npm run typecheck`, and `npm run build` passed on 2026-08-12.

## Phase Status

- Plan 01: Chunking Core (completed after independent audit 2026-08-12)
- Plan 02: Review Workbench (completed 2026-08-12)
- Plan 03: Contextual Retrieval (completed 2026-08-12)
- Plan 04: Integration And Acceptance (completed 2026-08-12)
- V2.1 planning: completed 2026-08-13; implementation gates `V21-G1` through `V21-G4`: pending in strict order
- V2.1 Plan 01 / `V21-G1`: completed 2026-08-13; Plan 02 / `V21-G2`: completed 2026-08-13; Plan 03 / `V21-G3`: completed 2026-08-16; Plan 04 / `V21-G4`: pending

Treat every unchecked phase as open even if partial code exists.

## Checkpoint Protocol

Before each focused work item:

1. Set `Current work item` to a precise task.
2. Record assumptions or a blocker before editing.
3. Keep the active phase unchanged until its completion gate passes.

After each focused work item:

1. Record files changed and behavior delivered.
2. Record exact verification commands and results.
3. Record remaining failures or risks.
4. Set the next action.

After a phase gate passes, mark it complete here before starting the next Plan. If interrupted mid-command, record the command as `unknown` and rerun it; never assume it passed.

## Latest Verification

| Date | Scope | Evidence | Result |
| --- | --- | --- | --- |
| 2026-08-12 | V1 baseline | `npm test` | passed: `chunking self-check passed` |
| 2026-08-12 | V1 baseline | `npm run typecheck` | passed |
| 2026-08-12 | V1 baseline | `npm run build` | passed |
| 2026-08-12 | Plan 01 fresh baseline | `npm test` | passed: `chunking self-check passed` |
| 2026-08-12 | Plan 01 fresh baseline | `npm run typecheck` | passed |
| 2026-08-12 | Plan 01 fresh baseline | `npm run build` | passed |
| 2026-08-12 | Plan 01 work item 01.1 | `npm test` | passed: cross-Block size sensitivity, overlap provenance, protected table |
| 2026-08-12 | Plan 01 work item 01.1 | `npm run typecheck` | passed |
| 2026-08-12 | Plan 01 normalization | `npx tsx src/mineru.test.ts` | passed: normalized structure and provenance fields |
| 2026-08-12 | Plan 01 completion | `npm test` | passed: chunking, request defaults, MinerU normalization |
| 2026-08-12 | Plan 01 completion | `npm run typecheck` | passed |
| 2026-08-12 | Plan 01 completion | `npm run build` | passed |
| 2026-08-12 | Plan 01 public contract | deterministic `buildChunkPreview` smoke | passed: cross-page multi-Block Source Segments and metrics; example in `docs/api/chunk-preview-example.md` |
| 2026-08-12 | Plan 01 gate audit | `npm test` | passed: page-local reading order, semantic peak/failure, protected table/warning/image splitting, IDs, distributions, provenance invariants |
| 2026-08-12 | Plan 01 gate audit | `npm run typecheck` | passed |
| 2026-08-12 | Plan 01 gate audit | `npm run build` | passed |
| 2026-08-12 | Plan 02 state contract | `npm test` | passed: Preview/Draft isolation, revisions, undo/redo, workspace persistence, Draft token/metric normalization |
| 2026-08-12 | Plan 02 syntax and compile gate | `node --check app.js`; `npm run typecheck`; `npm run build` | all passed |
| 2026-08-12 | Plan 02 desktop browser | Playwright at 1440x1000 | passed: 2 nonblank source pages, 14 bbox, cross-page/cross-Block hover/click, P.1/P.2 markers, Esc clear, Preview/Draft, metric deltas, edit/split/merge/exclude/restore/undo/redo, Shift/Ctrl selection, create/add/remove source |
| 2026-08-12 | Plan 02 recovery | service restart plus browser reload through recent batch ID | passed: disk-backed Draft, revisions, Source Segments, recalculated token/metrics, export enablement recovered |
| 2026-08-12 | Plan 02 mobile browser | Playwright at 390x844 | passed: no horizontal overflow or clipped controls, source tools hidden, source pages/Chunk/editor reachable, console clean |
| 2026-08-12 | Plan 02 screenshots | `output/playwright/plan02-final-desktop-1440.png`; `output/playwright/plan02-mobile-390.png` | saved and visually inspected |
| 2026-08-12 | Plan 02 runtime logs | Playwright console plus `.workspace/server.out.log`/`.workspace/server.err.log` | 0 browser errors/warnings; API requests 200; error log empty; health 200 |
| 2026-08-12 | Plan 03 work item 03.1 red | `npx tsx src/contextual.test.ts`; focused review/export tests | failed as expected: missing Context module/export builder, unknown ID accepted, and never-generated Context incorrectly marked stale |
| 2026-08-12 | Plan 03 work item 03.1 | `npx tsx src/contextual.test.ts`; `npx tsx src/review-state.test.ts`; `npx tsx src/export.test.ts`; `npm run typecheck` | all passed: deterministic reasons, document-scoped packages, selected-only isolated generation, lifecycle, human overwrite guard, output validation, invalidation, and authoritative export composition |
| 2026-08-12 | Plan 03 work item 03.2 | `npm test`; `npm run typecheck`; `npm run build` | all passed: fake OpenAI-compatible client, authoritative Draft Context operations, stale-response guard, save-boundary invalidation, server-only routes, and server export builder |
| 2026-08-12 | Plan 03 selective browser workflow | in-app browser at 1440x1000 using local deterministic fake model | passed: Preview showed visible reasons; Draft exposed 4 selectable Chunks; selecting 2 produced `awaiting_review` + isolated `failed` while 2 unselected stayed `not_generated`; generated Context required explicit confirmation; failure error was visible and supported manual Context |
| 2026-08-12 | Plan 03 lifecycle and stale export | browser plus `GET /api/batches/:batchId/export` | passed: `confirmed` and `human_modified` were distinct; text revision made human Context `stale`; stale text remained review-visible but `embeddingText === finalText`; confirmed Context was prepended; export had source/config/model audit fields and no `apiKey`/`Authorization` field |
| 2026-08-12 | Plan 03 responsive UI | browser at 1440x1000 and 390x844 | passed: desktop 240/660/540 three-column layout, 2 nonblank pages, 14 bbox; mobile hid file rail, kept source/Chunk/Context reachable, Context toolbar wrapped to two stable rows; no horizontal overflow, out-of-bounds control, or page console error/warning |
| 2026-08-12 | Plan 03 screenshots | `output/playwright/plan03-context-desktop-1440.png`; `output/playwright/plan03-context-mobile-390.png` | saved after visual/layout checks |
| 2026-08-12 | Plan 03 runtime logs | `.workspace/plan03-server.out.log`, `.workspace/plan03-server.err.log`, `.workspace/plan03-fake.err.log` | health 200; API responses successful; only `/` and `/styles.css` cache responses were 304; server and fake error logs empty |
| 2026-08-12 | Plan 03 completion gate | `npm test`; `npm run typecheck`; `npm run build`; `node --check app.js` | all passed |
| 2026-08-12 | Plan 04 eight sample classes | `npx tsx src/ecommerce-fixtures.test.ts` | passed: deterministic sanitized fixtures cover single product, multi-model, illustrated installation, large table, cross-page table, two-column, OCR, and mixed safety classes with reading order, groups, and expected boundaries |
| 2026-08-12 | Plan 04 large document browser | local demo with `?demoPages=100` | passed: 100 page tabs remained navigable; initial DOM rendered P.1-P.2 only; P.50 rendered P.49-P.51 only; no horizontal overflow |
| 2026-08-12 | Plan 04 real upload workflow | browser upload of `qa/ecommerce-upload-sample.md` through local multipart parse | passed: 7 Blocks, 5 Sentence Chunks, confirmed Draft, text correction, human Context, server export; export matched UI and contained `commonmark-basic-v1`, Source Segment, text revision, configuration, `human_modified`, and eligible `embeddingText` |
| 2026-08-12 | Plan 04 invalidation and stale request protection | `npx tsx src/context-review.test.ts`; `npx tsx src/generation-gate.test.ts` | passed: finalText/source range/parent/product changes stale Context; quality-only change does not; older Preview/Context tickets cannot commit after newer requests |
| 2026-08-12 | Plan 04 integrated checks | `npm test`; `npm run typecheck`; `npm run build`; `node --check app.js` | all passed after fixtures, large-document rendering, invalidation, docs, and generation gate changes |
| 2026-08-12 | Plan 04 real fixture boundaries | `npx tsx src/ecommerce-fixtures.test.ts` | passed: all eight fixtures run through real Structure-Aware Preview; 80-row table splits safely into three row groups with repeated headers; cross-page and protected-group sources preserved |
| 2026-08-12 | Plan 04 parse lifecycle | `npx tsx src/parse-lifecycle.test.ts`; `npx tsx src/workspace.test.ts` | passed: per-document failure isolation, complete reparse invalidation, multiple MinerU job retention, legacy job compatibility, and 24-hour expiry |
| 2026-08-12 | Plan 04 100-page/keyboard browser | Edge at 1440x1000, `?demoPages=100` | passed: P.1-P.2 initial DOM; P.49-P.51 at P.50; 3 bbox at deep page; Enter/Space Source/Chunk locks; P.45-P.60 markers; no horizontal overflow |
| 2026-08-12 | Plan 04 continuous browser workflow | Chromium at 1440x1000 using `qa/ecommerce-upload-sample.md` and local fake Context | passed: 7 Blocks, 5 Chunks, selected-only `awaiting_review/failed`, confirm/manual fallback, text revision to stale, cancel/confirm reparse, and all five export Chunk comparisons true for text/source/revisions/flags/config/Context/embedding |
| 2026-08-12 | Plan 04 final responsive browser | Chromium at 1440x1000 and 390x844 | passed: no horizontal overflow, no out-of-bounds controls, nonblank source page with 7 bbox, mobile rail hidden, browser console 0 errors/0 warnings |
| 2026-08-12 | Plan 04 final screenshots/logs | `output/playwright/plan04-completion-desktop-1440.png`; `output/playwright/plan04-completion-mobile-390.png`; `.workspace/plan04-completion-app.err.log`; `.workspace/plan04-final-fake.err.log` | screenshots saved; both error logs empty; health 200 |
| 2026-08-12 | Plan 04 reparse UI consistency | terminal Playwright at 1440x1000 and 390x844; `output/playwright/plan04-final-reparse-desktop.png`; `output/playwright/plan04-final-reparse-mobile.png` | passed: confirmed reparse removed 5 Draft Chunks and reset the configuration indicator to `待生成`; mobile width 390/390, rail and source tools hidden, one nonblank source page with 7 bbox, console 0 errors/0 warnings |
| 2026-08-12 | Plan 04 final gate rerun | `npm test`; `npm run typecheck`; `npm run build`; `node --check app.js` | all passed after the final reparse-state UI correction |
| 2026-08-12 | Plan 04 completion gate | `npm test`; `npm run typecheck`; `npm run build`; `node --check app.js` | all passed after final code, documentation, responsive, log, and screenshot review |
| 2026-08-13 | PRD 2.0 document delivery | `docs/rag-chunking-platform-prd-2.0.md` | passed: 624 lines, 30,738 bytes, SHA256 `56B40A0FAEC909E5C321F170D5A80EEFA433FE60F73543C513FE5A966B9388AF`; title hierarchy, links, contract terms, and secret scan passed |
| 2026-08-13 | PRD 2.0 repository baseline | `npm test`; `npm run typecheck`; `npm run build` | all passed; this verifies the existing V2 baseline only and is not evidence that V2.1 is implemented |
| 2026-08-13 | V2.1 Plan static structure | PowerShell existence, H1/H2 continuity and unresolved-placeholder scan over four new Plans | passed: 4 Plans, 0 errors |
| 2026-08-13 | V2.1 acceptance/secret scan | PowerShell scan over four Plans, Consolidation and status | passed: all 32 acceptance IDs represented; 0 secret-like matches; `.env` was not read |
| 2026-08-13 | Existing V2 baseline after V2.1 planning | `npm test` | passed: 11 existing V2 suites; not V2.1 implementation evidence |
| 2026-08-13 | Existing V2 baseline after V2.1 planning | `npm run typecheck` | passed; not V2.1 implementation evidence |
| 2026-08-13 | Existing V2 baseline after V2.1 planning | `npm run build` | passed; not V2.1 implementation evidence |
| 2026-08-13 | Existing V2 browser script syntax after V2.1 planning | `node --check app.js` | passed; not V2.1 implementation evidence |

## V2.1 Plan Consolidation Checkpoint

### Files Written In This Planning Work Item

- `docs/plans/v21-01-input-normalization-chunking/Plan.md`: 123 lines, 13,353 bytes, SHA256 `84C77EFA45A3589970A20636AC10FA12FF25F24E4B6EEC6761AE336E6FC9E57A`.
- `docs/plans/v21-02-review-workbench/Plan.md`: 111 lines, 12,287 bytes, SHA256 `11EDDFC6DD6B3A56067879B35D958D5C8A3C942C17BE6F0DDFA12DD18C578CEE`.
- `docs/plans/v21-03-contextual-retrieval-export/Plan.md`: 111 lines, 11,706 bytes, SHA256 `F9A2403C19DB25C42637A9058FF3A0A0225A175A6612E71C10EF25B6C28DBDA7`.
- `docs/plans/v21-04-migration-ui-acceptance/Plan.md`: 117 lines, 12,392 bytes, SHA256 `CFD9241D83E8122D1E34F1F8F6DBAC45CFBC697195D7AF1DD01E78A2A9A95207`.
- `docs/Consolidation.md`: 181 lines, 11,997 bytes, SHA256 `BED19258B05AAFAC71CDC0CF2D21723F8AE351891A7DF0A154C9057C258D8840` at this checkpoint.
- `PROJECT_STATUS.md`: updated with this recoverable checkpoint; its final hash is reported after the last write because a file cannot stably contain its own hash.

Historical `docs/plans/01-chunking-core/Plan.md` through `docs/plans/04-integration-acceptance/Plan.md` and their V2 evidence were preserved. No source, UI, test logic, dependency, build product or runtime workspace file was edited for this planning objective.

### Coverage And Recovery Result

- PRD 2.0 sections 4 through 20 map to at least one named work unit in `docs/Consolidation.md`.
- Historical `V2-AC01` through `V2-AC12` and new `V21-AC01` through `V21-AC20` each have one implementation owner and an evidence type. `P04-04` is only the final verifier, not a duplicate owner.
- Critical contracts explicitly cover Office source submission to MinerU, independent Visual Copy failure, no guessed bbox, four content layers, HTML table isolation, qualification/embedding eligibility, Context stale behavior, Legacy isolation, partial export and secret boundaries.
- Recovery order: this file -> `docs/rag-chunking-platform-prd-2.0.md` -> `docs/Consolidation.md` -> `CONTEXT.md` and ADRs -> active V2.1 Plan -> current source/tests. Compare the hashes above before resuming; if drifted, reread the changed file and update the checkpoint.
- Next action remains `V21-G1` Plan 01 red evidence. Do not start Plan 02, 03 or 04 early and do not infer V2.1 implementation from this completed planning checkpoint.

## Changed Files In Current Work Item

- `PROJECT_STATUS.md`: started Plan 01 work item 01.1 and recorded prerequisite review.
- `src/chunking.test.ts`: replaced V1 self-check with V2 cross-Block aggregation, chunk-size sensitivity, overlap provenance, and protected-table contract tests.
- `src/chunking.ts`: added continuous text-flow assembly, exact Source Segments, actual overlap provenance, token counts, and protected-unit output.
- `src/server.ts`: accepted the Structure-Aware strategy and confirmed semantic maximum-budget request default.
- `src/mineru.ts`, `src/mineru.test.ts`: normalized reading order, role, grouping, product identity, backend, and version fields.
- `src/chunk-request.ts`, `src/chunk-request.test.ts`: enforced confirmed defaults and rejected invalid overlap.
- `src/test.ts`, `package.json`: run all deterministic Plan 01 suites through `npm test`.
- `docs/api/chunk-preview-example.md`: recorded a sanitized exact-provenance response example.
- `PROJECT_STATUS.md`: started Plan 02 work item 02.1 after reading the phase plan.
- `src/review-state.ts`, `src/review-state.test.ts`: normalize saved Draft token counts, size flags, and metrics at the server boundary using the shared tokenizer and metrics rules.
- `app.js`: restored recent Temporary Workspace batches after reload; enabled export from current Draft state; added Preview/Draft metric deltas and token bands; synchronized source add/remove with finalText while preserving automaticText; added ordered discrete-selection confirmation, linked Chunk counts/styles, page markers, and Esc clearing.
- `styles.css`: added stable linked-Chunk and metric-delta visual states.
- `output/playwright/plan02-final-desktop-1440.png`, `output/playwright/plan02-mobile-390.png`: Plan 02 visual QA evidence.
- `PROJECT_STATUS.md`: closed Plan 02 and opened Plan 03 only after its completion gate passed.
- `src/contextual.ts`, `src/contextual.test.ts`: added deterministic Context Candidate reasons, short/long document packages, selected-only generation with isolated failures, review lifecycle, manual Context, overwrite protection, invalidation, and embedding text composition.
- `src/chunking.ts`: added PRD-required Context candidate and audit metadata to the persisted Chunk contract.
- `src/export.ts`, `src/export.test.ts`: added a server-side explicit-field export contract; stale or unreviewed Context cannot enter `embeddingText` and runtime secrets cannot be spread into output.
- `src/review-state.ts`, `src/review-state.test.ts`: corrected invalidation so editing a never-generated Chunk remains `not_generated` while reviewed Context becomes stale.
- `src/test.ts`: included Context and export deterministic suites.
- `src/context-client.ts`, `src/context-client.test.ts`: added a server-only OpenAI-compatible chat client with timeout, factual 2-4 sentence prompt, `上下文不足` fallback, and redacted error behavior.
- `src/context-review.ts`, `src/context-review.test.ts`: added authoritative Draft Context operations, history, save-boundary invalidation, and input-fingerprint protection against stale generation responses.
- `src/server.ts`, `.env.example`: added optional server-only Context configuration; selected generation, confirmation, manual edit/retry, and authoritative export routes. Missing Context credentials block generation only, not application startup or manual Context.
- `index.html`, `app.js`, `styles.css`: added visible Context reasons/states, arbitrary selection, selected batch and current-page recommendation generation, per-Chunk generation/retry, manual editing, explicit confirmation, scope/error display, blur-save invalidation, and server-authoritative export download.
- `qa/fake-context-server.mjs`, `qa/start-plan03-app.mjs`: deterministic local-only Plan 03 browser QA services; no external model or paid resource was used.
- `output/playwright/plan03-context-desktop-1440.png`, `output/playwright/plan03-context-mobile-390.png`: Plan 03 visual evidence.
- `src/ecommerce-fixtures.ts`, `src/ecommerce-fixtures.test.ts`: added deterministic sanitized structures and expectations for all eight PRD ecommerce sample classes.
- `src/generation-gate.ts`, `src/generation-gate.test.ts`, `src/server.ts`: added server-side latest-request-wins protection for Preview and Context persistence.
- `app.js`: added current-page plus neighbor window rendering for large documents, deep-page source navigation, reliable blur-save for text correction, and PRD-consistent split/merge Context invalidation.
- `qa/ecommerce-upload-sample.md`: sanitized local upload-to-export acceptance input.
- `README.md`, `docs/acceptance-v2.md`: corrected V2 runtime, persistence, configuration, scope, fixture limitations, and mapped all twelve PRD acceptance criteria to durable evidence.
- `src/parse-lifecycle.ts`, `src/parse-lifecycle.test.ts`, `src/server.ts`, `app.js`: isolated parse-result failures, retained concurrent/legacy MinerU job IDs, added confirmed single-document reparse and complete state invalidation, and exposed retry actions.
- `src/workspace.ts`, `src/workspace.test.ts`: enforced the displayed 24-hour Temporary Workspace expiry.
- `src/chunking.ts`, `src/ecommerce-fixtures.ts`, `src/ecommerce-fixtures.test.ts`: ran all fixtures through the real preview; fixed protected-group membership, image Source Segment order, and cross-page table preservation; added a true oversized table.
- `index.html`, `app.js`, `styles.css`: added MIME-aware original source backgrounds, finite page-window rendering, keyboard/ARIA states, visible focus, loading state, and inert collapsed rail behavior.
- `output/playwright/plan04-completion-desktop-1440.png`, `output/playwright/plan04-completion-mobile-390.png`: final Plan 04 visual evidence.
- `app.js`: derives the configuration status from the current Preview/Draft after reparse, restore, and document switching so cleared state cannot continue to display `Preview 已生成`.
- `output/playwright/plan04-final-reparse-desktop.png`, `output/playwright/plan04-final-reparse-mobile.png`: final reparse-state and responsive visual evidence.
- `docs/rag-chunking-platform-prd-2.0.md`: confirmed PRD 2.0 product contract covering Office direct-to-MinerU input, independent Visual Copy, Source View/location quality, four-layer normalization, all content types, selective Context, eligibility, Legacy isolation, partial export, and the V2.1 implementation boundary. No V2.1 code was changed in this work item.

## Decisions Or Risks Requiring Attention

- The directory is not currently a Git repository; recovery depends on durable files, not commits.
- Context model, concurrency, and timeout remain deployment configuration to decide from available runtime evidence during Plan 03.
- Real or licensed examples for all eight ecommerce document classes may not exist locally; use deterministic fixtures and report gaps rather than inventing evidence.
- Never expose `.env` contents or API keys in logs, screenshots, docs, prompts, or exports.
- Expected red evidence for work item 01.1: `npm test` failed at `chunkSize must change cross-Block structure`; the V1 per-Block splitter produced identical structures.
- Plan 01 red evidence also covered missing `buildChunkPreview`, broken Token overlap in the installed LlamaIndex version, and missing protected Content Group assembly before each focused fix.
- Token counts use LlamaIndex's CL100K tokenizer. This is displayed as `cl100k_base`; it is an estimate unless a future embedding model declares the same tokenizer.
- Independent gate audit found unresolved Plan 01 risks: page-local reading order, semantic percentile peak selection, typed protected-group splitting and IDs, token distribution, and full provenance invariants. Plan 02 edits already present are preserved but frozen until this gate passes again.
- The reopened Plan 01 risks above are now covered and passing; Plan 02 resumed only after the second gate run.
- Plan 02 browser QA reproduced four consistency gaps before this work item: split/merge preserved stale token counts and metrics; export remained disabled after confirming a Draft; source adjustment could desynchronize `automaticText`, `finalText`, and Source Segments; discrete Block selection lacked ordered confirmation and source-click linkage lacked an association count.
- No real Context model smoke test was performed: automated and browser evidence used a deterministic local fake, and no external Context credential/quota was assumed. This is not a Plan 03 blocker because the server-only compatible client is fake-tested and the goal explicitly forbids spending quota without known authorization.
- Browser QA found that a native `change` listener did not reliably save Chunk text on automated blur; the editor now uses `blur` with a value-change guard. The retest proved saved state changed reviewed Context to `stale`.
- No licensed real-world corpus for all eight ecommerce classes is stored locally. The repository uses explicit sanitized deterministic structures and records this limitation; it does not claim real-customer evidence.
- No local PDF/image fixture was available for the final continuous browser run. The source route and MIME-aware PDF/image background renderer are implemented; final browser evidence covers Markdown Block pages and the demo bbox surface, so real PDF/image rendering remains a documented low-severity validation risk.
- PRD 2.0 introduces a new V2.1 contract and is not implemented by the current V2 code. Before implementation, create the mapped four-Plan execution record described in the PRD; do not change `Overall status` to V2.1 completed until all new acceptance evidence exists.

## Completion Evidence

All four V2 Plan completion gates passed. The twelve-item V2 evidence map is in `docs/acceptance-v2.md`. PRD 2.0 is a confirmed follow-up scope; its 20 new acceptance criteria have no implementation evidence yet and are intentionally not marked complete.
