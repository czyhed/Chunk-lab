# Plan 01: Chunking Core

## Outcome

Replace per-Block splitting with a structure-aware document assembly and chunking core that makes size and overlap effective across eligible adjacent text while preserving protected content and exact provenance.

## Prerequisites

- Read the confirmed V2 PRD sections 5-7, 10-11, 14-16.
- Read ADR 0001, 0004, and 0005 plus `CONTEXT.md`.
- Run the baseline checks and record results in `PROJECT_STATUS.md`.

## Work Items

1. Extend the normalized block model with reading order and structure fields required by the PRD without coupling chunking to raw MinerU JSON.
2. Introduce Content Group and continuous-text-flow assembly for headings, paragraphs, lists, product identity, images, tables, and warning groups.
3. Implement Structure-Aware, LlamaIndex Sentence, LlamaIndex Token, and custom Semantic Boundary strategies over eligible flows rather than individual Blocks.
4. Enforce the confirmed defaults and token semantics, including semantic maximum-budget fallback.
5. Apply overlap only between adjacent text Chunks in the same flow, preserving complete-sentence preference and `isOverlap` provenance.
6. Replace `sourceBlockIds` as the primary contract with ordered `SourceSegment[]` carrying source and Chunk ranges.
7. Preserve protected content; implement safe oversized behavior or explicit Quality Flags without silent truncation.
8. Produce Chunk Preview metrics required by PRD section 11.
9. Keep API errors explicit; semantic embedding failure must not silently downgrade.

## Tests And Evidence

- Add deterministic fixtures with many short adjacent Blocks.
- Prove two different `chunkSize` values produce different structures.
- Prove nonzero overlap creates repeated Source Segments and zero overlap does not.
- Cover cross-Block, partial-Block, cross-page, protected table/image/warning, oversized content, and semantic budget fallback.
- Run:

```powershell
npm test
npm run typecheck
npm run build
```

## Completion Gate

Plan 01 is complete only when the core behavior is covered by tests, all commands pass, public response examples contain exact Source Segments, and `PROJECT_STATUS.md` records evidence plus the next phase.

## Out Of Scope

Do not redesign the UI, implement Context LLM calls, add a vector database, or build permanent document storage in this phase.

