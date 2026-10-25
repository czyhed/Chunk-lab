# Plan 03: Contextual Retrieval

## Outcome

Add selective, reviewable Context Enhancement that never changes Chunk text and only contributes to embedding input after explicit confirmation or human modification.

## Prerequisites

- Plans 01 and 02 completion gates have passed.
- Chunk revision and persistence contracts are stable.
- Read V2 PRD sections 12-14 and 16.

## Work Items

1. Implement deterministic Context Candidate rules and visible recommendation reasons without an LLM classification pass.
2. Support manual selection, single generation, multi-select batch generation, and current-page recommended generation.
3. Build short-document and long-document context packages using the PRD source priority; never mix product documents.
4. Add a server-only configurable OpenAI-compatible context-generation client. Do not expose keys to the browser or export.
5. Enforce the 2-4 sentence factual prompt contract, including `上下文不足` instead of guessing.
6. Implement independent per-Chunk states: not generated, generating, awaiting review, confirmed, human modified, failed, and stale.
7. Allow human-authored Context and protect existing human changes from automatic overwrite.
8. Implement all confirmed invalidation rules for text, provenance, identity, summaries, merge, and split changes.
9. Produce `embeddingText` only from confirmed or human-modified Context; otherwise use `finalText` alone.
10. Keep per-item failures isolated and retriable.

## Tests And Evidence

- Use a fake context model in deterministic tests; do not spend external quota in automated checks.
- Prove unselected Chunks make no model call.
- Prove recommendation reasons, lifecycle transitions, invalidation, manual fallback, failure isolation, and export composition.
- Perform one explicitly authorized real-model smoke test only when credentials and quota are already available; redact all secrets and request headers.
- Run test, typecheck, build, and the real-browser context-review workflow.

## Completion Gate

Plan 03 is complete when selective generation and review are proven, stale Context never enters `embeddingText`, failures remain isolated, secrets stay server-side, and evidence is recorded in `PROJECT_STATUS.md`.

## Out Of Scope

Do not create embeddings, write to a vector database, perform retrieval evaluation, or add model A/B comparison.

