# V2 Acceptance Evidence

This document maps the twelve acceptance criteria in PRD section 16 to durable repository or QA evidence. Exact command results and recovery details remain in `PROJECT_STATUS.md`.

| # | Acceptance criterion | Evidence |
| --- | --- | --- |
| 1 | Short Blocks aggregate; `chunkSize` changes structure | `src/chunking.test.ts`; Plan 01 red/green evidence in `PROJECT_STATUS.md` |
| 2 | Non-zero Overlap is identifiable and locatable | `src/chunking.test.ts` exact overlapping `SourceSegment`; Plan 02 bbox browser evidence |
| 3 | Four strategies use their own parameters and documented behavior | `src/chunk-request.test.ts`, `src/chunking.test.ts`, UI strategy hints, `docs/api/chunk-preview-example.md` |
| 4 | Any Chunk locates all sources across Blocks/pages | provenance invariant tests; Plan 02 browser evidence; Plan 04 keyboard Source/Chunk bidirectional lock across P.45-P.60 |
| 5 | Two-column reading order is correct and uncertainty remains visible | `src/mineru.test.ts`, `src/chunking.test.ts`; eight real-preview boundary assertions in `src/ecommerce-fixtures.test.ts` |
| 6 | Image/table/warning groups are protected and not silently truncated | protected-group tests; 80-row table row-group/header assertions; cross-page table Source Segments in fixture previews |
| 7 | Preview can be replaced without unconfirmed Draft loss | `src/review-state.test.ts`, `src/generation-gate.test.ts`; Plan 04 reparse cancellation retained visible Draft/export |
| 8 | Split, merge, exclude/restore, correction, source adjustment, undo/redo | Plan 02 desktop browser workflow and persisted recovery evidence |
| 9 | Context reasons are visible; unselected Chunks make no model call | `src/contextual.test.ts`; Plan 04 continuous browser flow produced `awaiting_review / failed / not_generated / not_generated / not_generated` after selecting exactly two Chunks |
| 10 | Context never changes `finalText`; stale Context is excluded from `embeddingText` | `src/contextual.test.ts`, `src/export.test.ts`; Plan 04 browser/export comparison proved stale uses `finalText` and human Context is prepended only for embedding |
| 11 | LLM/embedding failures are explicit and never silently fabricated | fake client/failure tests, semantic failure test, `src/parse-lifecycle.test.ts`; Plan 04 visible Context failure and manual fallback |
| 12 | Export matches UI text, source, configuration, revision, flags and Context | `src/export.test.ts`; Plan 04 continuous upload flow compared all five Draft Chunks field by field and all comparisons passed |

## Representative Workflow

The Plan 04 browser acceptance flow covered local Markdown parse, Preview, confirmed Draft, selected Context generation with isolated failure, explicit confirmation, manual fallback, stale invalidation, server-authoritative field-by-field export comparison, reparse cancel/confirm, and desktop/mobile layouts. Plan 02 separately covered source adjustment, split/merge/exclude/restore, undo/redo, and workspace recovery. A 100-page demo proved the source DOM renders only the current page and neighbors.

## Fixtures And Limitations

`src/ecommerce-fixtures.ts` contains deterministic, sanitized structures for all eight PRD sample classes, including multi-model identity, image/caption groups, large and cross-page tables, two-column order, OCR provenance, and mixed safety content. `qa/ecommerce-upload-sample.md` exercises a real upload path.

No licensed real-world document set for all eight classes is stored in this repository. No real Context model smoke test was performed because available quota was not explicitly established; deterministic automated and browser tests use a local fake. No local PDF/image fixture was available for the final run, so the original-file background route and MIME-specific renderer are implemented but the final continuous flow exercised a Markdown Block page. These are documented residual evidence limitations, not fabricated results.
