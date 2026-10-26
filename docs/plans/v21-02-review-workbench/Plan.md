# V2.1 Plan 02: Review Workbench

## Plan Status

- `planStatus`: `completed`
- `implementationStatus`: `completed`
- `gateId`: `V21-G2`
- `dependsOn`: `V21-G1` evidence from [Plan 01](../v21-01-input-normalization-chunking/Plan.md)
- `nextPlan`: [V2.1 Plan 03](../v21-03-contextual-retrieval-export/Plan.md)

Completing this plan document or its checks is not evidence that V2.1 functionality is implemented.

## Outcome

Deliver a desktop-first MinerU-like review workbench backed by real original/Visual Copy/source views. Staff can inspect continuous pages or source ranges, see only verified bbox overlays, navigate bidirectionally between Source Segments and Chunks, compare replaceable Preview results against a confirmed Draft, and make typed revisions through a server-authoritative boundary.

## Non-Goals

- No Context model generation, Legacy migration, vector index, retrieval evaluation, accounts, arbitrary pixel annotation, re-OCR, permanent history tree, deployment, or production data.
- Do not replace original files with parsed text; do not infer bbox or use fixed page dimensions; do not let display HTML bypass qualification.
- Do not modify historical V2 Plan files or call existing V2 browser screenshots V2.1 evidence.

## Product And Architecture Basis

- PRD 2.0 sections 5, 10.1, 11, 15, 17 criteria 3, 4, 5, 8, 12, 13, 19, and sections 18-20.
- ADR 0003 requires Configuration Draft -> Chunk Preview -> confirmed Chunk Draft -> Revision.
- ADR 0005 makes Source Segments authoritative for navigation and revision provenance.
- ADR 0001 keeps UI behavior independent of raw parser schemas.
- `CONTEXT.md` terms: Source View, Chunk Preview, Chunk Draft, Text Correction, Chunk Revision, Quality Flag, Data Annotator.

## Inputs And Dependencies

- Require the Plan 01 gate record and a `contractVersion=2.1` Parsed Document/Preview fixture.
- Reuse `index.html`, `app.js`, `styles.css`, `src/review-state.ts`, `src/generation-gate.ts`, and the historical V2 browser workflow only where their behavior satisfies the new contract.
- The server must expose source-view metadata and authoritative revision routes. Client-only state is never the source of truth.
- Browser tests use deterministic local fixtures and fake adapters. No `.env`, API key, Authorization, request URL, or secret diagnostic is printed.

## Work Units

### P02-01 Real Source Views, Mapping And Bidirectional Navigation

- **Goal:** Render actual original PDF/image pages, Office Visual Copy pages, and MD/TXT source/rendered/parsed views with continuous navigation and verified mapping states.
- **Red evidence before implementation:** Reproduce current violations with a missing-bbox fixture: `app.js` currently estimates boxes from reading order and fixed dimensions. Reproduce a nonblank parsed-text simulation where the original surface is unavailable. Run `npx tsx src/v21-viewer.test.ts` and a browser script that asserts a guessed overlay exists; preserve the failure. Add mapping fixtures for `exact`, `page_only`, `parsed_only`, and `unavailable`.
- **Minimum implementation:** Add source-view tabs, real page dimensions, page virtualization/windowing, zoom/fit/actual-size, page input/thumbnail navigation, and source ranges for Markdown/TXT. Draw bbox only when all PRD §5.4 conditions pass and `locationQuality=exact`; otherwise show page/block/source-range states without a box. Use Source Segment IDs and version references for hover, click lock, scroll-to-first-source, multi-page markers, and Esc clear.
- **Focused green checks:** `npx tsx src/v21-viewer.test.ts`; `node --check app.js`; `npm run typecheck`.
- **Browser evidence:** Start `npm run dev` on default `http://127.0.0.1:4180` or record a non-conflicting port. Use a real browser at 1440x1000 and 390x844. Verify continuous scroll, zoom, page jump, nonblank original/Visual Copy/source surfaces, exact bbox overlays only, cross-page/cross-block hover and click lock, bidirectional highlight, Esc clear, no horizontal overflow/overlap, and zero console errors/warnings. Save `output/playwright/v21-plan02-p02-01-desktop-1440.png` and `output/playwright/v21-plan02-p02-01-mobile-390.png`; save `.workspace/v21-plan02-p02-01.out.log` and `.workspace/v21-plan02-p02-01.err.log`.
- **Risks:** Real PDF.js/converter support or licensed files may be unavailable. Use sanitized/fake assets for deterministic UI behavior and explicitly record real-format residual risk.

### P02-02 Configuration Draft, Preview/Draft And Dirty-Parameter Gate

- **Goal:** Make parameter exploration non-destructive and prevent confirmation of stale Preview results.
- **Red evidence before implementation:** Change a parameter in the current UI, then call the existing confirm route or click confirm. Current behavior can still confirm the old Preview because dirty state is presentation-only. Record the request/result and run `npx tsx src/v21-preview-gate.test.ts` with the expected initial failure (no config fingerprint/409/disabled confirm).
- **Minimum implementation:** Persist Configuration Draft, Preview configuration/fingerprint, and Draft configuration separately; mark Preview expired when parameters change; disable old confirm and return a clear conflict if a stale ticket arrives; generate a new Preview before adoption; show metric deltas; require a second confirmation only when replacing human revisions or Context.
- **Focused green checks:** `npx tsx src/v21-preview-gate.test.ts`; focused `src/review-state.test.ts`; `npx tsx src/generation-gate.test.ts`; `node --check app.js`.
- **Browser evidence:** Generate Preview A, change parameters, prove A cannot be adopted, generate Preview B, compare metrics, adopt B, and verify only then does editing unlock. Capture desktop screenshot and console/server logs; no old Preview may overwrite a newer request.
- **Risks:** Existing V2 ReviewState is structurally reusable but lacks a persisted dirty fingerprint. Preserve historical routes only through explicit adapters.

### P02-03 Typed Editing And Server Recalculation Boundary

- **Goal:** Allow typed human correction while making the server recompute display, searchText/finalText, metrics, flags, eligibility, and stale Context dependencies atomically.
- **Red evidence before implementation:** Submit a reviewed model containing invalid table spans, unsupported type, empty required text, or a display-only HTML mutation. Assert the current `PUT review` route accepts/uses client state without normalized-model validation. Run `npx tsx src/v21-review-recompute.test.ts` and preserve the failing response.
- **Minimum implementation:** Add editors for paragraph/list, table cells and spans, image caption/enrichment, formula LaTeX, code, warning, unknown-type classification, and reliable plain-text repair. Validate reviewedModel server-side; generate display and tag-free searchText; recompute automatic/final text, token metrics, Quality Flags, qualification and Context stale state; preserve raw and automatic source evidence. Context generation remains Plan 03.
- **Focused green checks:** `npx tsx src/v21-review-recompute.test.ts`; `npx tsx src/review-state.test.ts`; `npm run typecheck`.
- **Evidence:** server response and persisted Draft JSON before/after, revision diff, qualification transition, stale reason, and rejection report. Do not include raw MinerU HTML in ordinary review responses.
- **Risks:** Client-side convenience must never become authoritative. A malformed reviewed model must fail clearly rather than silently becoming paragraph text.

### P02-04 Local/Document Recompute, IDs, Undo/Redo And Responsive QA

- **Goal:** Preserve stable Chunk IDs for local content fixes, issue replacement IDs for type/boundary/group changes, support undo/redo, and keep desktop/mobile layouts usable.
- **Red evidence before implementation:** Exercise current split/merge/source adjustment with a changed type/boundary and assert no `replacedChunkId`, version namespace, or server recompute contract. Run `npx tsx src/v21-recompute-scope.test.ts` and capture the failure.
- **Minimum implementation:** Implement local Content Group/Chunk recomputation, document-level Preview escalation for reading-order/Product Identity/cross-boundary changes, `replacedChunkId`, Source Segment preservation/downgrade, undo/redo and auto-save/recovery. Keep mobile to viewing, locating, and text repair; no pixel annotation.
- **Focused green checks:** `npx tsx src/v21-recompute-scope.test.ts`; `npx tsx src/workspace.test.ts`; `npx tsx src/generation-gate.test.ts`; `npm test`; `npm run typecheck`; `npm run build`; `node --check app.js`.
- **Browser evidence:** At 1440x1000 and 390x844 verify typed edits, split, compatible merge, exclusion/restore, source adjustment, undo/redo, refresh recovery, no clipped controls/overlap, source and Chunk reachability, and clean console/server logs. Save `output/playwright/v21-plan02-p02-04-desktop-1440.png` and `output/playwright/v21-plan02-p02-04-mobile-390.png` plus `.workspace/v21-plan02-p02-04.out.log` and `.workspace/v21-plan02-p02-04.err.log`.
- **Risks:** No arbitrary history tree is allowed. If a source change cannot preserve exact ranges, retain Block-level evidence and mark quality rather than guessing.

## Cross-Unit Invariants

- Original/Visual Copy/source views are not parsed-text simulations. Missing or unverified bbox never receives an overlay.
- Preview is read-only; Draft is editable only after adoption. Dirty configuration cannot confirm an old Preview.
- Server recomputation is authoritative; `display/displayHtml` cannot bypass qualification; Context never writes into finalText.
- Source Segments retain immutable source versions and all available range/bbox evidence; manual text does not create coordinates.

## Export, Browser And Log Evidence Requirements

- Compare the persisted Draft/review response with any downstream export fixture field by field for finalText, Source Segments, configuration, revisions, flags, IDs, and Context invalidation metadata. This is review-state evidence only; Plan 03 owns the final export contract.
- Every UI run records URL, batch/document IDs, desktop/mobile viewport, source nonblank assertion, bbox count and quality, console errors/warnings, and redacted service logs. Screenshots must use the paths specified by the work unit.
- Never place request URLs, Authorization, API keys, cookies, or raw diagnostic payloads in screenshots, logs, browser network artifacts, or exports.

## Plan Gate V21-G2

The gate remains `pending` until:

1. P02-01 through P02-04 focused tests pass and Plan 01 gate evidence is present.
2. Desktop and mobile browser runs prove real source surfaces, continuous navigation, exact/degraded mapping, bidirectional highlight, dirty Preview gate, typed revision, recovery, and no console/server errors.
3. Export/review snapshots show server-recomputed fields and stable/replaced IDs; no raw diagnostics or secrets leak.
4. `npm test`, `npm run typecheck`, `npm run build`, and `node --check app.js` pass after the final UI change.
5. `PROJECT_STATUS.md` records screenshots, logs, routes, commands, risks, and the handoff contract.

## Recovery And Checkpoints

Before each unit set `Current work item: Plan 02 P02-0x red evidence`; after it record files, focused results, browser/export artifacts, risks, and next action. Interrupted commands are `unknown`; rerun them after reading `PROJECT_STATUS.md`, PRD 2.0, Consolidation, CONTEXT/ADR, this Plan, then source/tests. After two identical failures change the diagnostic method or reduce the fixture; pause only for authorized external/production/product conflicts.

## Handoff To Plan 03

Provide an authoritative confirmed Draft API with typed `reviewedModel`, derived display/search/final text, qualification fields, Context invalidation fingerprints, stable/replaced Chunk IDs, Source Segments, and persisted dirty-preview protection. Plan 03 must verify G2 evidence before adding Context/export behavior.

## Remaining Risks

- Real PDF/Office conversion and coordinate mapping remain environment-dependent until a controlled fixture is available.
- Existing V2 browser evidence is historical and must not be relabeled as V2.1.
- This plan does not generate Context or mark any embedding record complete.

## Implementation Evidence (2026-08-13)

- P02-01: `src/v21-viewer.ts`, `src/v21-pdf-surface.ts`, `pdf-surface.js` and `qa/v21-source-sample.pdf` provide continuous real PDF pages, virtual page windows, zoom/page navigation, strict bbox evidence and bidirectional Source Segment selection. The deterministic tests `src/v21-viewer.test.ts` and `src/v21-pdf-surface.test.ts` pass.
- P02-02: `src/v21-preview-gate.ts` persists Configuration Draft, Preview and Draft fingerprints; stale Preview adoption returns 409 and dirty parameters disable confirmation. `src/v21-preview-gate.test.ts` passes and browser QA changed 512 to 300 tokens, producing 4 to 5 Chunks only after a new Preview.
- P02-03: `src/v21-review-recompute.ts` plus the reviewed-model route validate typed models and recompute display/search/final text, token metrics, flags, qualification, Revision and Context stale state. `src/v21-review-recompute.test.ts` passes; browser QA proved an image caption repair changed token count from 0 to 27 and persisted after refresh.
- P02-04: `src/v21-recompute-scope.ts` and `src/v21-review-actions.ts` make the server authoritative for exclude/restore, split, overlap-safe merge, source create/add/remove, undo/redo and stable/replacement IDs. Legacy whole ReviewState writes return 410 `CLIENT_REVIEW_STATE_REJECTED`; client-derived action fields return 400. Structural changes set `embeddingEligible=false`, `embeddingText=null` and `manual_review_required` until typed repair revalidates the Chunk.
- Focused commands passed: `npx tsx src/v21-viewer.test.ts`, `npx tsx src/v21-preview-gate.test.ts`, `npx tsx src/v21-review-recompute.test.ts`, `npx tsx src/v21-recompute-scope.test.ts`, `npx tsx src/v21-pdf-surface.test.ts`, and `npx tsx src/v21-review-actions.test.ts`.
- Gate commands passed after the final UI/server change: `npm test`, `npm run typecheck`, `npm run build`, and `node --check app.js`.
- Playwright CLI evidence: the four specified screenshots are exactly 1440x1000 or 390x844; two 595x842 PDF canvases are rendered and nonblank; exact overlay count is one; desktop/mobile overflow and control-bound violations are zero; clean sessions report zero console errors/warnings. Runtime out/err logs are both zero bytes after normal requests and do not record request URLs or headers.
- Evidence files: `output/playwright/v21-plan02-p02-01-desktop-1440.png` (`F777CDBE...A242`), `v21-plan02-p02-01-mobile-390.png` (`5AC3C16F...0709`), `v21-plan02-p02-04-desktop-1440.png` (`E7E879C7...B1F4D`), `v21-plan02-p02-04-mobile-390.png` (`4D654B68...D458`), `.workspace/v21-plan02-p02-04.out.log`, and `.workspace/v21-plan02-p02-04.err.log`.
- Residual risk carried to G4: Office Visual Copy conversion remains fake-adapter tested rather than licensed real-Office browser evidence. Arbitrary pixel annotation remains intentionally out of scope.
