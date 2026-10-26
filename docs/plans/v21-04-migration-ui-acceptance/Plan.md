# V2.1 Plan 04: Migration, Cross-Phase Integration And Acceptance

## Plan Status

- `planStatus`: `pending`
- `implementationStatus`: `not_started`
- `gateId`: `V21-G4`
- `dependsOn`: `V21-G1`, `V21-G2`, and `V21-G3` evidence
- `nextPlan`: none; after this gate only documented residual-risk follow-up remains

The five PRD capability domains are mapped into four execution gates. This is Plan 04, not a fifth phase. Completing this Plan is the only point at which V2.1 may be assessed against all 32 criteria, and only after every item has evidence.

## Outcome

Integrate the four preceding contracts, isolate and migrate Legacy and superseded Source Documents without guessing, and prove the complete V2.1 workflow in a real browser on desktop and mobile. Produce a durable 32-item acceptance matrix, UI/export comparison, screenshots, logs, manifests, risks and recovery checkpoint.

## Non-Goals

- No production migration, deletion, deployment, publishing, account/role workflow, permanent history tree, vector database, retrieval evaluation, re-OCR, arbitrary PDF annotation, or new product behavior.
- Do not call a missing credential a blocker for deterministic/fake tests; do not claim a fake model, sanitized fixture or existing V2 screenshot is real customer/model evidence.
- Do not mark V2.1 complete when any gate, criterion, browser flow, export comparison or secret scan is missing.

## Product And Architecture Basis

- PRD 2.0 sections 4-20, especially 13, 15, 16, 17, 18, 19 and 20.
- All five ADRs and `CONTEXT.md`; historical `docs/plans/01-*` through `04-*` remain evidence for V2 only.
- Existing `src/parse-lifecycle.ts`, `src/workspace.ts`, `src/generation-gate.ts`, ecommerce fixtures, fake Context server and historical Playwright workflows are reusable test assets, not V2.1 completion evidence.

## Inputs And Dependencies

- G1/G2/G3 checkpoint records with exact command results and artifact paths.
- Sanitized fixtures for eight historical ecommerce classes plus ten V2.1 contract samples: Office Visual Copy success/failure, HTML table, non-text/unknown types, mapping degradation, Markdown ranges/views, image asset loss/enrichment, Legacy reparse, normalization repair, partial manifest.
- Controlled local/fake adapters for MinerU, Visual Copy, Context and any embedding call. Real model smoke test is optional and at most one when explicitly authorized credentials/quota already exist.

## Work Units

### P04-01 Source Document Replacement And Legacy Reparse

- **Goal:** Create new Source Document/version namespaces for replacement; mark superseded snapshots read-only; detect Legacy contracts and enable V2.1 only after confirmed reparse.
- **Red evidence before implementation:** Seed an old V2 workspace missing normalized/eligibility/source-view fields and a replaced source file. Assert current state has no `legacy-contract`, `superseded`, contract-specific export isolation, or new ID namespace. Run `npx tsx src/v21-migration.test.ts` and capture red output.
- **Minimum implementation:** Add source fingerprint/version and `superseded` state; Legacy detection/read-only behavior; reject new Context, embedding and structured edits for Legacy; allow separate legacy export; require explicit reparse; create new Parsed Document/contentBlock ID namespace only on successful reparse; preserve old snapshot read-only without arbitrary history.
- **Focused green checks:** `npx tsx src/v21-migration.test.ts`; `npx tsx src/parse-lifecycle.test.ts`; `npx tsx src/workspace.test.ts`; `npm run typecheck`.
- **Evidence:** before/after version and ID JSON, reparse confirmation/cancel, rejected Legacy operations, separate `contractVersion=legacy` and `contractVersion=2.1` manifests, and superseded read-only export.
- **Risks:** This is a local Temporary Workspace migration contract, not a production data migration. Never delete or mutate original user files.

### P04-02 Fixed Samples And End-To-End Contract Workflow

- **Goal:** Exercise parse -> source views -> normalization -> Preview -> Draft -> revision -> selective Context -> export across all fixed samples and document any unavailable real corpus.
- **Red evidence before implementation:** Run an end-to-end script against the current V2 app with one Office/HTML/mapping/Legacy/partial scenario and record the first missing V2.1 field or state. Run `npx tsx src/v21-e2e-contract.test.ts` before implementation and preserve the red report.
- **Minimum implementation:** Build deterministic sanitized fixture runners that assert expected statuses, types, quality/eligibility, Context scope/stale, source segments, version fields, manifest states and export composition. Include all eight V2 ecommerce classes and ten V2.1 samples; do not invent licensed real documents.
- **Focused green checks:** `npx tsx src/v21-e2e-contract.test.ts`; `npx tsx src/ecommerce-fixtures.test.ts`; `npx tsx src/generation-gate.test.ts`; `npm run typecheck`.
- **Evidence:** fixture manifest, per-sample expected/actual report, end-to-end redacted export, and documented real-sample availability limitation.
- **Risks:** Sanitized fixtures prove deterministic contracts only. Real PDF/image/Office rendering remains a residual until controlled assets exist.

### P04-03 Real Browser, Responsive And Runtime Evidence

- **Goal:** Prove desktop and mobile workflows, source-view behavior, logging, accessibility and runtime consistency against local/fake services.
- **Red evidence before implementation:** Use Playwright to reproduce current fixed-page/parsed-text source simulation and guessed bbox, parameter dirty-confirm, and any responsive overflow. Save red screenshots/log paths; do not overwrite historical V2 evidence.
- **Minimum implementation:** Run the full local app with controlled adapters. At 1440x1000 verify file rail, continuous original/Visual Copy/source view, zoom, page jump, nonblank pages, exact/degraded bbox, bidirectional Chunk highlighting, Preview/Draft gate, typed edits, Context selection/review, Legacy isolation and export. At 390x844 verify source/Chunk/Context reachability, text repair, no horizontal overflow/overlap/clipped controls. Capture console and status-only server logs.
- **Focused green checks:** `npm test`; `npm run typecheck`; `npm run build`; `node --check app.js`.
- **Browser evidence:** Save `output/playwright/v21-plan04-p04-03-desktop-1440.png` and `output/playwright/v21-plan04-p04-03-mobile-390.png`; save `.workspace/v21-plan04-p04-03.out.log`, `.workspace/v21-plan04-p04-03.err.log` and fake adapter logs. Record URL/port, batch/document IDs, actions, response status, sourceNonBlank, bbox count/quality, scrollWidth/clientWidth and console counts. Do not record request URLs, Authorization, cookies, API keys or diagnostic secrets.
- **Risks:** Browser evidence using fake services must be labeled fake. Real model/format smoke evidence is optional and never silently substituted.

### P04-04 Final 32-Criterion Matrix, Export/UI Consistency And Recovery

- **Goal:** Close every V2-AC01..12 and V21-AC01..20 exactly once with owner evidence, compare export to current page state, and leave a recoverable status record.
- **Red evidence before implementation:** Create the matrix with each criterion marked `pending`; run a script that fails on duplicate IDs, missing owner/work unit/evidence, missing PRD section mapping or any unfilled criterion. Run `npx tsx src/v21-acceptance-matrix.test.ts` and preserve the red output.
- **Minimum implementation:** Populate the unique ownership matrix from `docs/Consolidation.md`; field-compare UI Draft versus export/manifest (text, sourceSegments, configuration, revisions, quality/eligibility, Context, embeddingText, contract/version); verify pending/failed visibility, Legacy format isolation, diagnostics expiry and secret scans. Re-run all baseline and focused checks after final changes. Record residual risk and next action; only then may status be considered for a future V2.1 completion decision.
- **Focused green checks:** `npx tsx src/v21-acceptance-matrix.test.ts`; `npm test`; `npm run typecheck`; `npm run build`; `node --check app.js`.
- **Evidence:** `qa/v21-acceptance-matrix.md` or equivalent durable matrix, sanitized export/manifest diff, final screenshots/logs, static link/heading/placeholder/secret scans, file hashes, and a fresh `PROJECT_STATUS.md` checkpoint. This plan must not fabricate these artifacts during planning; they are future gate outputs.
- **Risks:** Any missing criterion, unknown command, unresolved high-severity defect, unavailable required credential/production decision, or unexplained export mismatch keeps G4 pending.

## Unique Acceptance Ownership

The detailed mapping is maintained in `docs/Consolidation.md`; this Plan owns the final review, not duplicate ownership. The unique owners are:

- `V2-AC01..03` -> P01-05; `V2-AC04` -> P02-01; `V2-AC05..06` -> P01-02/P01-03 respectively; `V2-AC07` -> P02-02; `V2-AC08` -> P02-03; `V2-AC09` and `V2-AC11` -> P03-01; `V2-AC10` -> P03-02; `V2-AC12` -> P04-04.
- `V21-AC01..02` -> P01-01; `V21-AC03..05` -> P02-01; `V21-AC06` -> P01-03; `V21-AC07` -> P01-02; `V21-AC08` -> P02-03; `V21-AC09` -> P01-04; `V21-AC10..11` -> P03-02; `V21-AC12..13` -> P02-03/P02-04; `V21-AC14` -> P04-01; `V21-AC15..16` -> P03-03/P03-04; `V21-AC17` -> P01-02; `V21-AC18` -> P03-02; `V21-AC19` -> P04-03; `V21-AC20` -> P03-04.

P04-04 performs the final cross-check for all 32 but does not create a second owner.

## Cross-Unit Invariants

- Plan order is 01 -> 02 -> 03 -> 04. Five capability domains remain mapped to four gates.
- V2 `Overall status=completed` is historical baseline state. V2.1 plan status can be complete while V2.1 implementation remains `not_implemented` until this gate passes.
- No stale Context enters embeddingText; no ineligible Chunk gets non-null embeddingText; no raw HTML/diagnostic/secret enters ordinary export.
- No guessed bbox or Source Segment; no silent semantic fallback; no mixed Legacy/V2.1 export.

## Browser, Export, Log And Screenshot Requirements

- Use real browser, desktop 1440x1000 and mobile 390x844, local/fake services, and status-only logs. Assert source nonblank, continuous navigation, zoom/page jump, bbox quality, bidirectional lock/clear, overflow/overlap, console cleanliness and API health.
- Compare current page Draft and downloaded/server export field by field. Save sanitized artifacts only. Screenshots/log paths must be recorded in `PROJECT_STATUS.md`.
- Never expose `.env`, API keys, Authorization, request URLs, cookies, headers or raw diagnostics in any artifact.

## Plan Gate V21-G4

Gate `V21-G4` passes only when:

1. P04-01 through P04-04 focused tests and all G1-G3 gate evidence pass.
2. All 32 criteria have one owner, one work unit, one evidence type and a concrete artifact/command reference.
3. The complete browser workflow succeeds on desktop/mobile with clean console and service logs.
4. UI/export/manifest/diagnostic comparisons match; pending/failed/Legacy states are explicit; no high-severity defect remains.
5. `npm test`, `npm run typecheck`, `npm run build`, and `node --check app.js` pass, and `PROJECT_STATUS.md` records exact evidence, residual risks and final status decision.

## Recovery And Checkpoints

Before each unit set `Current work item: Plan 04 P04-0x red evidence`; after it record files, commands/results, browser/export/log artifacts, risks and next action. Interrupted commands are `unknown` and must be rerun. Recovery order is `PROJECT_STATUS.md` -> PRD 2.0 -> Consolidation -> CONTEXT/ADR -> this Plan -> source/tests. Do not infer completion from chat history or old V2 evidence.

## Final Handoff

If G4 passes, hand off a status record containing `contractVersion=2.1`, versioned Source Documents/Parsed Documents, stable/replaced IDs, qualification and Context state, selected manifests, diagnostic expiry, 32-item evidence matrix, screenshots/logs and residual risks. Until then, handoff state is `V2.1 implementation: not_implemented`.

## Remaining Risks

- Real licensed document coverage and real model smoke remain environment-dependent and must be labeled.
- Temporary Workspace is 24-hour and the repository has no Git history; recovery relies on durable docs, hashes and QA artifacts.
- This Plan is the final acceptance plan, not permission to deploy, publish or add PRD-excluded functionality.
