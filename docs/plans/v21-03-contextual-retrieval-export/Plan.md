# V2.1 Plan 03: Selective Contextual Retrieval And Export

## Plan Status

- `planStatus`: `completed`
- `implementationStatus`: `completed`
- `gateId`: `V21-G3`
- `dependsOn`: `V21-G1` and `V21-G2` evidence from Plans 01 and 02
- `nextPlan`: [V2.1 Plan 04](../v21-04-migration-ui-acceptance/Plan.md)

This plan defines implementation work only. Its completion cannot be reported as V2.1 feature completion until Plan 04 closes the final gate.

## Outcome

Implement selective, reviewable Context Enhancement and a server-authoritative export contract. Only recommended or explicitly selected eligible Chunks receive Context generation; Context remains separate from `finalText`; stale or unreviewed Context never enters `embeddingText`; ordinary exports, partial manifests, Legacy isolation and diagnostic packages are explicit and secret-free.

## Non-Goals

- No full-document Context generation, automatic LLM candidate classification, vector database, embeddings, retrieval evaluation, model A/B comparison, accounts, production document library, deployment, or new product features.
- No raw MinerU/diagnostic data in Context or ordinary exports. No context overwrite of human edits without explicit authorization.
- No real model call unless credentials and quota already exist and an explicitly authorized single smoke test is safe; deterministic fake model is the default.

## Product And Architecture Basis

- PRD 2.0 sections 12, 13.2, 14, 15.1/15.3, 17 criteria 6, 9-11, 15, 16, 18, 20, and sections 18-20.
- ADR 0002 keeps assets separate from vector records.
- ADR 0003 keeps Preview/Draft/Revision stages separate.
- ADR 0005 keeps source evidence immutable while Context is derived.
- `CONTEXT.md` terms: Context Candidate, Context Enhancement, Context Review State, Product Identity, Model Enrichment, Export Package.

## Inputs And Dependencies

- A confirmed Draft from Plan 02 with `embeddingEligible`, `embeddingExclusionReasons`, `qualityFlags`, normalized/reviewed models, Source Segments, product identity and invalidation fingerprints.
- Existing `src/contextual.ts`, `src/context-review.ts`, `src/context-client.ts`, `src/export.ts`, `src/workspace.ts`, fake context QA server and export tests are reusable V2 foundations but lack V2.1 eligibility/manifest/diagnostic fields.
- Context and export routes are server-only. Browser receives redacted status and output, never credentials or diagnostic request metadata.

## Work Units

### P03-01 Candidate Recommendations, Selection And Failure Isolation

- **Goal:** Show deterministic recommendation reasons, let staff choose individual/current-page/batch Chunks, and isolate per-Chunk generation failures.
- **Red evidence before implementation:** Use an eligible candidate, an ineligible candidate, an unselected candidate, and a fake model that fails one request. Assert the current route can generate without eligibility gate or skipped-neighbor audit and lacks a complete call log. Run `npx tsx src/v21-context-selection.test.ts` and preserve red output.
- **Minimum implementation:** Extend candidate reasons and UI selection; enforce target eligibility before generation; keep unselected Chunks at `not_generated`; isolate `failed` items and allow retry/manual fallback; retain document/product scope and prompt/model version. Do not call LLM for recommendation itself.
- **Focused green checks:** `npx tsx src/v21-context-selection.test.ts`; `npx tsx src/contextual.test.ts`; `npx tsx src/context-client.test.ts`.
- **Evidence:** fake-model call log showing only selected IDs, recommendation reason snapshot, isolated failure response, retry/manual state, and redacted server log.
- **Risks:** Missing credentials must block generated Context only, not manual Context or the application. Never silently substitute local/generated text for a failed model.

### P03-02 Eligibility, Scope, Lifecycle, Stale And Embedding Invariants

- **Goal:** Enforce the full qualification matrix and Context lifecycle, including skipped ineligible neighbors, actual scope, stale invalidation and embedding text rules.
- **Red evidence before implementation:** Add unsupported/failed/empty-search target and ineligible neighbor fixtures. Assert current Context generation accepts them and `embeddingTextFor` can return non-null final text without an eligibility field. Run `npx tsx src/v21-context-eligibility.test.ts` and record failing assertions.
- **Minimum implementation:** Gate target generation; skip ineligible neighbors and record `contextScope` plus `skippedNeighborReasons`; use normalized/reviewed/search text and approved enrichment only; implement `not_generated/generating/awaiting_review/confirmed/human_modified/failed/stale`; stale on reviewed/final text, source ranges, identity, parent/group or enrichment changes; set `embeddingText=null` when ineligible, finalText for eligible unreviewed/stale/failed, and context+finalText only for eligible confirmed/human-modified non-stale Context.
- **Focused green checks:** `npx tsx src/v21-context-eligibility.test.ts`; `npx tsx src/context-review.test.ts`; `npx tsx src/contextual.test.ts`; `npm run typecheck`.
- **Evidence:** state transition table, package input audit proving no raw/diagnostic values, skipped-neighbor scope, stale reason, and exact embeddingText assertions.
- **Risks:** Context text may remain review-visible after stale but must be ignored by embedding. Do not mutate finalText.

### P03-03 Ordinary Export, Partial Manifest And Legacy Isolation

- **Goal:** Build a contractVersion 2.1 export that matches current Draft state and emits completed/pending/failed manifest entries without mixing Legacy.
- **Red evidence before implementation:** Export a batch containing completed, pending, failed, Legacy, and V2.1 documents. Assert current export silently omits pending/failed, lacks contractVersion, and cannot separate formats. Run `npx tsx src/v21-export-manifest.test.ts` and preserve the red manifest diff.
- **Minimum implementation:** Add explicit contract/version/parser/normalizer/model fields, normalized/reviewed models, eligibility/exclusion/quality fields, sourceSegments and summaries, Context reasons/scope/skipped-neighbor fields, revisions and configuration. Generate separate `contractVersion=legacy` and `contractVersion=2.1` manifests; require format selection when a batch contains both; completed superseded snapshots may be read-only exported, but no new derivations. Visual Copy failure is a Quality Flag, not a parse/chunk failure.
- **Focused green checks:** `npx tsx src/v21-export-manifest.test.ts`; `npx tsx src/export.test.ts`; `npx tsx src/workspace.test.ts`; `npm run typecheck`.
- **Evidence:** sanitized manifest with `completed/exported`, `pending`, `failed+reason`, selected contract format, field-by-field page Draft comparison, and proof no Legacy/V2.1 mixed document body exists.
- **Risks:** Do not silently drop the unselected contract format. Do not treat a missing Visual Copy as failed if parsing/chunking completed.

### P03-04 Independent Diagnostic Package And Secret Boundary

- **Goal:** Provide a separate allowlisted diagnostic package with 24-hour expiry while keeping ordinary export, browser, and logs secret-free.
- **Red evidence before implementation:** Add a diagnostic fixture containing raw table HTML, parser JSON and synthetic request metadata; assert current export has no independent package/allowlist/expiry and scan output for secret-like fields. Run `npx tsx src/v21-diagnostic-package.test.ts` and record red results.
- **Minimum implementation:** Build a separate expiring package containing only allowlisted raw content, parser/normalizer/converter versions, source fingerprints and safe status metadata. Exclude rawTableHtml/JSON and runtime secrets from ordinary export; redact URLs, Authorization, API keys, headers and request details from logs and browser responses. Reuse WorkspaceStore expiry semantics without writing `.workspace` fixtures during planning.
- **Focused green checks:** `npx tsx src/v21-diagnostic-package.test.ts`; `npx tsx src/export.test.ts`; `npm run typecheck`.
- **Evidence:** archive field allowlist, expiry test, ordinary-vs-diagnostic diff, static secret scan and redacted log inspection. Never print `.env` or request credentials.
- **Risks:** Diagnostic packages are temporary evidence, not a document library or source of truth.

## Cross-Unit Invariants

- Recommendations are deterministic; generation is explicit and selected-only.
- Context never changes `finalText`; stale Context is review-visible only and never enters `embeddingText`.
- `embeddingEligible=false -> embeddingText=null`; location quality and eligibility remain independent.
- Context input excludes raw/diagnostics and skips ineligible neighbors with reasons.
- Ordinary export contains no raw table HTML/diagnostic JSON/secrets. Legacy and V2.1 bodies never mix; partial manifests show pending/failed.

## Browser, Export And Log Evidence Requirements

- Use a deterministic fake Context server for browser QA. Start `npm run dev` and record URL/port, status-only API log, and fake-model call log without secrets.
- At 1440x1000 and 390x844 verify recommendation reasons, arbitrary selection, selected-only generation, awaiting review/confirm, failure/retry/manual fallback, stale invalidation, disabled ineligible controls, no horizontal overflow, clean console and service logs. Save `output/playwright/v21-plan03-p03-02-desktop-1440.png` and `output/playwright/v21-plan03-p03-02-mobile-390.png` plus `.workspace/v21-plan03-p03-02.out.log` and `.workspace/v21-plan03-p03-02.err.log`.
- Compare page Draft against ordinary export and selected manifest field by field. Save only sanitized JSON/manifest under `output/` or `qa/`; diagnostic package evidence is separate and expires in 24 hours.

## Plan Gate V21-G3

The gate remains `pending` until:

1. P03-01 through P03-04 focused tests pass using fake model and isolated failures.
2. Eligibility, Context lifecycle, stale and embedding invariants are proven for target, neighbor and failure cases.
3. Ordinary/partial/Legacy export and independent diagnostic package pass field, format, expiry and secret scans.
4. Real browser desktop/mobile workflow and logs/screenshots are clean; no external model call is required without explicit authorization.
5. `npm test`, `npm run typecheck`, `npm run build`, and `node --check app.js` pass; `PROJECT_STATUS.md` records all evidence and residual risks.

## Recovery And Checkpoints

Before each unit set `Current work item: Plan 03 P03-0x red evidence`; after it record changed files, command/result, fake call log, export/diagnostic paths, browser evidence, risks and next action. Interrupted commands are `unknown` and must be rerun. Recovery order is `PROJECT_STATUS.md` -> PRD 2.0 -> Consolidation -> CONTEXT/ADR -> this Plan -> source/tests. After two identical failures change method or narrow fixture; pause only for authorized external/production/product blockers.

## Handoff To Plan 04

Provide server-authoritative Context and export contracts: eligibility/exclusion fields, exact embeddingText invariant, lifecycle/stale audit, contractVersion 2.1/legacy manifests, partial statuses, source/normalized/reviewed fields, diagnostic allowlist and expiry. Plan 04 must verify G3 evidence before migration and final acceptance.

## Remaining Risks

- One explicitly authorized DashScope smoke call succeeded; it does not prove production model quality, rate limits or long-term availability. Fake-model evidence proves deterministic failure and lifecycle contracts only.
- Real customer documents and full visual conversion remain unavailable unless separately authorized; record limitations rather than invent evidence.
- This plan does not migrate Legacy or mark V2.1 globally complete.

## Implementation Evidence (2026-08-16)

- P03-01 through P03-04 focused tests passed, including selected-only failure isolation, eligibility/scope/stale rules, partial/Legacy export, diagnostic allowlist/expiry and public response redaction.
- A single authorized DashScope call returned Chinese Context and passed confirmation, refresh and Contract 2.1 export checks without retry or VLM use.
- Deterministic browser QA selected two eligible Chunks: one succeeded, one failed, the unselected Chunk remained `not_generated`; one failed retry was followed by manual fallback, and confirmed Context became stale after finalText changed.
- Desktop 1440x1000 and mobile 390x844 screenshots have no horizontal overflow or out-of-bounds controls; browser Console and final service logs are clean.
- Final `npm test`, `npm run typecheck`, `npm run build`, and JavaScript syntax gates passed. Durable details are in `docs/tickets/FOLLOWUP-dashscope-context-real-acceptance.md`, `docs/tickets/FOLLOWUP-v21-g3-browser-completion.md`, `output/evidence/dashscope-context-followup/`, and `output/playwright/v21-plan03-*`.
