# Plan 02: Review Workbench

## Outcome

Deliver a desktop-first MinerU-style review workbench where the original document and Chunk surface support precise bidirectional navigation, Preview/Draft separation, and recoverable human revision.

## Prerequisites

- Plan 01 completion gate has passed.
- Chunk and Source Segment contracts are stable and documented.
- Read V2 PRD sections 7-11 and 14-17.

## Work Items

1. Build the approved layout: collapsible file rail, original-page surface near 55%, Chunk workspace near 45%, and a fixed Chunk detail editor.
2. Serve or render original pages/assets and overlay normalized bbox regions using a consistent coordinate transform.
3. Implement hover preview, click lock, scrolling, multi-page markers, and `Esc` clearing in both directions.
4. Visually distinguish normal provenance, overlap, manual selection, and quality anomalies.
5. Implement Block-level selection with single, Shift-range, and Ctrl-toggle semantics plus create/add/remove Chunk operations.
6. Separate Configuration Draft, Chunk Preview, and confirmed Chunk Draft. Controls do not trigger generation by themselves.
7. Support old-Draft/new-Preview comparison, metric deltas, discard, and explicit destructive replacement confirmation.
8. Move full editing into the detail panel and support cursor split, compatible merge, recoverable exclude, restore, source adjustment, undo, and redo.
9. Auto-save review state to the Temporary Workspace and ignore stale preview responses.
10. Keep compact mobile behavior limited to viewing and text correction as specified.

## Browser Verification

- Exercise upload or a deterministic local fixture, generate a Preview, confirm a Draft, edit/split/merge/exclude/restore, and refresh to prove recovery.
- Verify bidirectional hover/click for a cross-Block and cross-page Chunk.
- Capture desktop and mobile screenshots and inspect console errors.
- Confirm no overlapping controls, clipped labels, blank document surfaces, or inaccessible primary actions.
- Run the repository checks from Plan 01 after meaningful changes.

## Completion Gate

Plan 02 is complete when the core review workflow works in a real browser, screenshots and logs are recorded in `PROJECT_STATUS.md`, refresh recovery succeeds, and all automated checks pass.

## Out Of Scope

Do not add accounts, collaboration, arbitrary pixel selection, character-level PDF relabeling, re-OCR, or an unrestricted version history.

