# V2.1 Plan 01: Input, Normalization And Chunking

## Plan Status

- `planStatus`: `completed`
- `implementationStatus`: `completed`
- `gateId`: `V21-G1`
- `owner`: Chunking and parser boundary
- `dependsOn`: existing V2 Plans 01-04 as historical reference only; PRD 2.0 contract; ADR 0001, 0002, 0004, 0005; `CONTEXT.md`
- `nextPlan`: [V2.1 Plan 02](../v21-02-review-workbench/Plan.md)

This plan is an implementation specification. Completing this document or its planning checks does not mean V2.1 functionality is implemented.

## Outcome

Create a parser-neutral V2.1 Parsed Document and Chunk Preview contract that can accept all supported formats, send Office originals directly to MinerU, manage an independent Visual Copy, normalize every first-class content type, preserve protected structures and exact source evidence, enforce qualification basics, and run all four confirmed strategies with effective token size and overlap.

## Non-Goals

- No review UI, browser viewer, human revision workflow, Context LLM call, Legacy migration, vector database, retrieval evaluation, accounts, deployment, re-OCR, or permanent document library.
- Do not modify the historical V2 Plan files or claim their evidence proves this plan.
- Do not use a Visual Copy as MinerU input, infer missing bbox, truncate protected content, or silently downgrade semantic embedding failures.

## Product And Architecture Basis

- PRD 2.0 sections 4, 6, 7, 8, 9, 10, 12.1, 14.2, 16, 17 criteria 1, 2, 4-7, 9, 17, and sections 18-20.
- ADR 0001 requires parser-neutral normalization before chunking.
- ADR 0002 keeps image assets separate from future vector records.
- ADR 0004 keeps the custom strategy named `Semantic Boundary`.
- ADR 0005 makes ordered `SourceSegment[]` the provenance authority.
- `CONTEXT.md` terms: Source Document, Parsed Document, Content Block, Content Group, Product Identity, Protected Content Group, Chunk Preview, Source Segment, Quality Flag, Temporary Workspace.

## Inputs And Dependencies

- Existing `src/mineru.ts`, `src/chunking.ts`, `src/embedding.ts`, `src/chunk-request.ts` and their tests are reusable V2 foundations, not V2.1 proof.
- Supported input matrix: PDF, PNG, JPG, JPEG, DOCX, PPTX, XLSX, MD, TXT.
- MinerU and Visual Copy adapters must be injected behind fake clients in tests. The real `.env` must not be read, logged, or copied by tests.
- A stable source fingerprint, `sourceDocumentVersion`, `parsedDocumentVersion`, `visualCopyVersion`, `normalizedContentVersion`, and `normalizerVersion` are inputs to all persisted records.

## Work Units

### P01-01 Input Matrix, Office Fork And Visual Copy

- **Goal:** Prove the input route sends original Office bytes to MinerU while creating an independent Visual Copy state machine.
- **Red evidence before implementation:** Add a focused fake-adapter test that records MinerU bytes and intentionally fails Visual Copy. It must initially fail because no `visualCopyVersion`, `sourceViewKind`, failure flag, or retry operation exists. Run `npx tsx src/v21-input.test.ts` and record the exact assertion failure.
- **Minimum implementation:** Add typed input and source-version contracts; preserve the existing direct MinerU upload path for PDF, image, and Office; add a separate `not_requested -> generating -> ready|failed` Visual Copy record with converter/version, page dimensions, coordinate mapping, error, and retry ticket. Visual Copy failure must leave parsing, chunking, revision and export eligible. Keep MD/TXT local and out of MinerU.
- **Focused green checks:** `npx tsx src/v21-input.test.ts`; `npx tsx src/mineru.test.ts`.
- **Evidence:** fake MinerU byte spy, Visual Copy success/failure/retry state JSON, status transitions, and a redacted request-result log containing only method/status/data id. No URL, Authorization, token, or request body secret.
- **Risks:** Converter availability and real Office/PDF fixtures may be absent. Use deterministic fake adapters and record the absence as residual risk; do not call paid services.

### P01-02 Four-Layer Normalization And Content Types

- **Goal:** Convert MinerU and CommonMark/TXT parser output into `raw`, `normalized`, `display`, `searchText`, and `normalizationStatus` without coupling downstream code to raw parser fields.
- **Red evidence before implementation:** Add fixtures for heading, paragraph, list, table, image, formula, code, warning, caption, footnote, and unknown type. Assert the current model lacks at least one required layer/type and that a MinerU HTML table would enter text. Run `npx tsx src/v21-normalization.test.ts` and preserve the failing output.
- **Minimum implementation:** Introduce parser-neutral Content Block and Content Group types; implement CommonMark AST parsing with UTF-16 source ranges; retain TXT ranges; map unknown types to `unsupported`; generate deterministic `display` and tag-free `searchText`; keep `raw` diagnostic-only with allowlisted fields and version metadata. `automaticText` is derived from normalized/searchText; `finalText` initially equals it.
- **Focused green checks:** `npx tsx src/v21-normalization.test.ts`; `npx tsx src/mineru.test.ts`; `npm run typecheck`.
- **Evidence:** sanitized fixture snapshots for all ten types, Markdown source/rendered/AST range report, and a normalization status report showing `normalized`, `partial`, `unsupported`, `failed`, and `manual_fixed` cases without claiming repaired states until the later editor exists.
- **Risks:** CommonMark library behavior and UTF-16 offsets must be pinned by tests. Do not silently convert unsupported content to paragraph.

### P01-03 Protected Models, IDs And Source Segments

- **Goal:** Normalize tables, images, formulas, code, warnings and groups while preserving versioned IDs and authoritative source segments.
- **Red evidence before implementation:** Add a table fixture whose `table_body` contains `<tr>` and `<td>`, an oversized cross-page table, an image with caption, and a warning group. Assert current output leaks HTML or lacks `rawBlockId/contentBlockId/mappingQuality/locationQuality`; run `npx tsx src/v21-provenance.test.ts` and record red failures.
- **Minimum implementation:** Store `rawTableHtml` only in diagnostic storage; build `tableModel`, safe `displayHtml`, and deterministic tag-free `searchText`; preserve image asset references and optional enrichment metadata; keep protected groups intact or apply type-specific row-group rules with Quality Flags. Add `sourceDocumentVersion`, `parsedDocumentVersion`, `rawBlockId`, `contentBlockId`, nullable page/bbox/ranges, mapping quality, location quality, overlap, and source/chunk UTF-16 ranges. Never invent coordinates.
- **Focused green checks:** `npx tsx src/v21-provenance.test.ts`; `npx tsx src/ecommerce-fixtures.test.ts`; `npm run typecheck`.
- **Evidence:** field-level JSON assertions, cross-page table row-group snapshot, raw/display/search isolation report, and source segment monotonicity/overlap report.
- **Risks:** Existing V2 `ParsedBlock` has only text/table/image and simple `SourceSegment`; compatibility must be explicit and versioned rather than guessed.

### P01-04 Qualification Basics And Version Immutability

- **Goal:** Establish independent `locationQuality` and `embeddingEligible` decisions before Context implementation.
- **Red evidence before implementation:** Add fixtures for missing bbox, invalid bbox, unsupported type, failed normalization, partial content, manual-fixed content, empty search text, and image-only content. Assert the current Chunk model has no eligibility/exclusion fields; run `npx tsx src/v21-eligibility.test.ts` and record red output.
- **Minimum implementation:** Add `embeddingEligible`, `embeddingExclusionReasons`, and separate `qualityFlags`; implement the PRD qualification matrix, including `embeddingExclusionReasons=[]` when eligible and `embeddingText=null` as a downstream invariant placeholder. Pin normalizer/model versions and immutable Parsed Document fingerprints; new rules must create a new version rather than mutate an old one.
- **Focused green checks:** `npx tsx src/v21-eligibility.test.ts`; `npx tsx src/v21-versioning.test.ts`; `npm run typecheck`.
- **Evidence:** qualification matrix table, version/fingerprint audit, and explicit location-quality/eligibility combinations such as `page_only + eligible`.
- **Risks:** This plan must not implement Context controls or final export composition; Plan 03 consumes these fields.

### P01-05 Four Strategies, Overlap And Preview Contract

- **Goal:** Produce a replaceable Chunk Preview using Structure-Aware, SentenceSplitter, TokenTextSplitter, and Semantic Boundary with token parameters and exact provenance.
- **Red evidence before implementation:** Reuse short adjacent Blocks and semantic failure fixtures. Assert current behavior for missing V2.1 fields and protected normalization; run `npx tsx src/chunking.test.ts` plus a new `npx tsx src/v21-preview.test.ts`. Red evidence must include a failed assertion for preview schema or strategy-specific parameter behavior before changes.
- **Minimum implementation:** Reuse the V2 continuous flow and protected-group logic where compatible; emit the V2.1 Chunk/Preview schema, metrics, strategy and tokenizer versions; make two chunk sizes produce different structures; apply overlap only within one text flow, mark repeated segments, and never duplicate assets/tables/protected groups. Semantic embedding failure must surface as an error, not a fake result.
- **Focused green checks:** `npx tsx src/chunking.test.ts`; `npx tsx src/v21-preview.test.ts`; `npm test`; `npm run typecheck`; `npm run build`.
- **Evidence:** sanitized Preview JSON, strategy parameter matrix, cross-Block size/overlap assertions, protected-group report, and semantic failure log.
- **Risks:** Existing V2 tests may assume legacy field names. Preserve compatibility adapters only at explicit boundaries; do not silently alter historical exports.

## Cross-Unit Invariants

- Office original bytes go to MinerU; Visual Copy is a separate asset and its failure is non-blocking.
- `raw` and `rawTableHtml` are diagnostic-only. `display/displayHtml` are UI-only. Chunking consumes normalized/search text; no HTML enters ordinary text, Context, or embedding input.
- Missing or invalid bbox never receives inferred coordinates. `locationQuality` is independent from `embeddingEligible`.
- Protected content is never silently truncated. Source Segments are authoritative and versioned.
- `embeddingEligible=false` must be representable now and must become `embeddingText=null` in Plan 03.

## Plan Gate V21-G1

The gate remains `pending` until every item is evidenced:

1. P01-01 through P01-05 focused tests pass, including fake Office/MinerU and Visual Copy failure isolation.
2. `npm test`, `npm run typecheck`, and `npm run build` pass; `node --check app.js` is run if shared browser code changed.
3. Preview JSON contains contract/version fields, all required content types, protected models, qualification fields, four strategies, effective overlap, and authoritative Source Segments.
4. No redacted evidence contains secrets, inferred bbox, raw HTML in ordinary text, or silent semantic fallback.
5. `PROJECT_STATUS.md` records files, exact commands/results, evidence paths, risks, and next action.

## Browser, Export And Log Evidence Requirements

- This plan has no UI completion claim. If a local route is used for an adapter smoke check, record `URL`, status codes, and redacted server logs only; do not claim source-viewer behavior.
- Produce a sanitized Preview/normalization JSON artifact under `output/` or `qa/` for downstream comparison. It must show `sourceSegments`, versions, types, qualification fields, and no raw diagnostics in ordinary records.
- Future browser plans must be able to assert nonblank original/Visual Copy surfaces and mapping states from this contract; Plan 01 only supplies the metadata and deterministic fixtures.

## Recovery And Checkpoints

Before each unit set `Current work item: Plan 01 P01-0x red evidence` and record assumptions. After each unit record `Files changed`, focused command/result, evidence paths, residual risk, and `Next action`. Interrupted commands are `unknown` and must be rerun after recovery. On repeated identical failure, change diagnosis or narrow the fixture after two attempts; stop only for the declared pause conditions. Recovery order is `PROJECT_STATUS.md` -> PRD 2.0 -> Consolidation -> CONTEXT/ADR -> active Plan -> source/tests.

## Handoff To Plan 02

Provide a stable `contractVersion=2.1` Parsed Document and Chunk Preview API with source/parsed/visual/normalized versions, Content Blocks/Groups, `rawBlockId/contentBlockId`, normalized/display/search layers, source segments, location/qualification fields, four strategies, metrics, and a reproducible fixture bundle. Plan 02 must verify the gate evidence exists before implementing UI or revision behavior.

## Remaining Risks

- No authorized real Office/PDF/image corpus or converter may be available; fake adapters and sanitized fixtures are acceptable evidence only for deterministic behavior.
- Existing server startup requires environment credentials; tests must use injected fakes and never print `.env`.
- This plan produces no browser screenshots and no V2.1 implementation completion claim.

## Implementation Evidence (2026-08-13)

- P01-01 through P01-05 followed red -> green slices. Initial public modules failed with `ERR_MODULE_NOT_FOUND`; later red assertions caught failed Visual Copy retry view state, CommonMark markup leakage, protected code overlap, lost Markdown source view, and missing typed Chunk models before their fixes.
- Added V2.1 input/Visual Copy, normalization, provenance, eligibility/versioning, Parsed Document and Preview contracts under `src/v21-*.ts`; the runtime upload, parse lifecycle and Preview route now persist and return Contract 2.1 without guessing Legacy fields.
- `qa/v21-g1-contract-evidence.json` is the sanitized gate artifact. It contains no raw diagnostic payload or runtime secret.
- Gate commands passed: `npm test`, `npm run typecheck`, `npm run build`, `node --check app.js`. Static scans reported `secret_matches=0` and `guessed_bbox_matches=0`.
- `commonmark@0.31.2` supplies the required Markdown AST and `parse5@8.0.0` supplies structured HTML table parsing; the dependency audit reported zero vulnerabilities.
- `V21-G1` is closed. This does not mark V2.1 complete; `V21-G2`, `V21-G3`, and `V21-G4` remain pending.
