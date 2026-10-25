# Plan 04: Integration And Acceptance

## Outcome

Prove the complete V2 workflow against the confirmed PRD, close cross-phase gaps, and leave a recoverable local application with trustworthy evidence.

## Prerequisites

- Plans 01-03 completion gates have passed.
- `PROJECT_STATUS.md` contains phase evidence and no unresolved critical blocker.

## Work Items

1. Prepare deterministic or appropriately licensed fixtures representing the eight PRD sample classes; record any unavailable real-world sample limitation.
2. Exercise the entire workflow from parse through Preview, Draft, revision, Context review, and export.
3. Validate export-to-UI consistency for text, Source Segments, configuration, revisions, flags, Context states, and `embeddingText`.
4. Test stale/cancelled preview protection and all invalidation paths.
5. Test per-document parse failure and per-Chunk model failure isolation.
6. Validate large-document rendering behavior with page/bbox lazy loading or virtualization.
7. Review accessibility, keyboard focus, desktop/mobile layout, empty/loading/error states, and browser console output.
8. Update README runtime/configuration instructions without exposing secrets.
9. Remove only artifacts made obsolete by V2 changes; do not perform unrelated cleanup.

## Final Verification

```powershell
npm test
npm run typecheck
npm run build
```

Start the app, complete the representative workflow in a real browser, capture desktop and mobile screenshots, record relevant API/log evidence, and check every V2 PRD section 16 acceptance item explicitly.

## Completion Gate

The project is complete only when all twelve PRD acceptance items have evidence, checks pass, the browser workflow is successful, known residual risks are documented, and `PROJECT_STATUS.md` is marked `completed` with artifact locations.

## Out Of Scope

Do not deploy, publish, push, add accounts, introduce production data, or implement PRD-excluded features.

