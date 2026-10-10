import assert from "node:assert/strict";
import {
  applyReviewAction,
  type ReviewActionChunk,
  type ReviewActionState,
  type ReviewSourceBlock,
} from "./v21-review-actions.js";
import { previewMetrics, type Chunk, type ChunkRequest } from "./chunking.js";
import type { SourceSegmentV21 } from "./v21-provenance.js";

const configuration: ChunkRequest = {
  strategy: "structure",
  chunkSize: 128,
  chunkOverlap: 16,
  bufferSize: 1,
  breakpointPercentile: 90,
  semanticMaxChunkSize: 768,
  imagePolicy: "summary",
};

const blocks: ReviewSourceBlock[] = [
  sourceBlock("block-1", "Alpha beta."),
  sourceBlock("block-2", "Gamma delta."),
  sourceBlock("block-3", "Table content.", "table"),
];

function sourceBlock(
  contentBlockId: string,
  searchText: string,
  contentType: ReviewSourceBlock["contentType"] = "paragraph",
): ReviewSourceBlock {
  return {
    contractVersion: "2.1",
    sourceDocumentVersion: "source-v1",
    parsedDocumentVersion: "parsed-v1",
    contentBlockId,
    rawBlockId: contentBlockId.replace("block", "raw"),
    contentType,
    searchText,
  };
}

function segment(
  contentBlockId: string,
  sourceStart: number,
  sourceEnd: number,
  chunkStart: number,
  chunkEnd: number,
): SourceSegmentV21 & Chunk["sourceSegments"][number] {
  return {
    sourceDocumentVersion: "source-v1",
    parsedDocumentVersion: "parsed-v1",
    contentBlockId,
    rawBlockId: contentBlockId.replace("block", "raw"),
    sourceViewKind: "parsed_document",
    page: null,
    bbox: null,
    sourceStart,
    sourceEnd,
    chunkStart,
    chunkEnd,
    isOverlap: false,
    mappingQuality: "exact",
    locationQuality: "parsed_only",
    blockId: contentBlockId,
  };
}

function chunk(
  id: string,
  text: string,
  sourceSegments: Array<SourceSegmentV21 & Chunk["sourceSegments"][number]>,
): ReviewActionChunk {
  return {
    id,
    type: "text",
    text,
    automaticText: text,
    finalText: text,
    page: null,
    bbox: null,
    sourceSegments,
    sourceBlockIds: [...new Set(sourceSegments.map((item) => item.contentBlockId))],
    tokenCount: 999,
    qualityFlags: ["oversized"],
    relatedChunkIds: [],
    excluded: false,
    contextText: "Existing context.",
    contextReviewState: "confirmed",
    contextScope: ["old scope"],
    contextCandidateReasons: [],
    revisions: [],
  };
}

function stateWith(chunks: ReviewActionChunk[]): ReviewActionState {
  const draft = {
    chunks,
    metrics: previewMetrics(chunks.map((item): Chunk => ({
      ...item,
      sourceSegments: item.sourceSegments.map((source) => ({
        blockId: source.contentBlockId,
        page: source.page,
        bbox: source.bbox ? [...source.bbox] : null,
        sourceStart: source.sourceStart ?? 0,
        sourceEnd: source.sourceEnd ?? 0,
        chunkStart: source.chunkStart ?? 0,
        chunkEnd: source.chunkEnd ?? 0,
        isOverlap: source.isOverlap,
      })),
    }))),
    configuration,
    confirmedAt: "2026-08-13T08:00:00.000Z",
  };
  return { preview: null, draft, undoStack: [], redoStack: [] };
}

const meta = {
  documentId: "doc-a1",
  draftVersion: "draft-v3",
  at: "2026-08-13T08:01:00.000Z",
};

let state = stateWith([
  chunk("chunk-1", "Alpha beta.", [segment("block-1", 0, 11, 0, 11)]),
]);
state = applyReviewAction(state, blocks, { type: "exclude", chunkId: "chunk-1", at: meta.at });
assert.equal(state.draft!.chunks[0].excluded, true);
const excludedId = state.draft!.chunks[0].id;
state = applyReviewAction(state, blocks, { type: "restore", chunkId: "chunk-1", at: meta.at });
assert.equal(state.draft!.chunks[0].excluded, false);
assert.equal(state.draft!.chunks[0].id, excludedId, "exclude/restore preserves identity");
state = applyReviewAction(state, blocks, { type: "undo" });
assert.equal(state.draft!.chunks[0].excluded, true);
state = applyReviewAction(state, blocks, { type: "redo" });
assert.equal(state.draft!.chunks[0].excluded, false);

const splitInput = stateWith([
  chunk("chunk-split", "Alpha beta.", [segment("block-1", 0, 11, 0, 11)]),
]);
const split = applyReviewAction(splitInput, blocks, {
  type: "split",
  chunkId: "chunk-split",
  cursor: 6,
  ...meta,
});
assert.deepEqual(split.draft!.chunks.map((item) => item.finalText), ["Alpha ", "beta."]);
assert.equal(split.draft!.chunks.every((item) => item.replacedChunkId === "chunk-split"), true);
assert.equal(split.draft!.chunks.every((item) => /^draft-v3:chunk:[a-f0-9]{16}$/.test(item.id)), true);
assert.notEqual(split.draft!.chunks[0].id, split.draft!.chunks[1].id);
assert.equal(split.draft!.chunks.every((item) => item.contextReviewState === "stale"), true);
assert.equal(split.draft!.chunks.every((item) => item.tokenCount < 999), true);
assert.equal(split.draft!.chunks.every((item) => item.embeddingEligible === false), true);
assert.equal(split.draft!.chunks.every((item) => item.embeddingText === null), true);
assert.equal(split.draft!.chunks.every((item) => item.embeddingExclusionReasons?.includes("manual_review_required")), true);
assert.equal(split.draft!.metrics.chunkCount, 2);
assert.equal(
  applyReviewAction(splitInput, blocks, {
    type: "split",
    chunkId: "chunk-split",
    cursor: 6,
    ...meta,
  }).draft!.chunks[0].id,
  split.draft!.chunks[0].id,
  "replacement IDs are deterministic",
);

const edited = stateWith([
  { ...chunk("edited", "Alpha beta.", [segment("block-1", 0, 11, 0, 11)]), finalText: "Human text." },
]);
assert.throws(
  () => applyReviewAction(edited, blocks, { type: "split", chunkId: "edited", cursor: 5, ...meta }),
  /automaticText.*exact Source Segment/,
);

const mergeInput = stateWith([
  chunk("left", "Alpha beta.", [segment("block-1", 0, 11, 0, 11)]),
  chunk("right", "Gamma delta.", [segment("block-2", 0, 12, 0, 12)]),
]);
const merged = applyReviewAction(mergeInput, blocks, {
  type: "merge-next",
  chunkId: "left",
  ...meta,
});

const overlapSource = "Gamma ";
const overlapMergeInput = stateWith([
  chunk("overlap-left", `Alpha ${overlapSource}`, [
    segment("block-1", 0, 6, 0, 6),
    segment("block-2", 0, overlapSource.length, 6, 6 + overlapSource.length),
  ]),
  {
    ...chunk("overlap-right", `${overlapSource}delta.`, [
      { ...segment("block-2", 0, overlapSource.length, 0, overlapSource.length), isOverlap: true },
      segment("block-2", overlapSource.length, 12, overlapSource.length, 12),
    ]),
  },
]);
const overlapMerged = applyReviewAction(overlapMergeInput, blocks, {
  type: "merge-next",
  chunkId: "overlap-left",
  ...meta,
});
assert.equal(overlapMerged.draft!.chunks[0].automaticText, "Alpha Gamma delta.");
assert.equal(overlapMerged.draft!.chunks[0].sourceSegments.filter((item) => item.isOverlap).length, 0);
assert.deepEqual(
  overlapMerged.draft!.chunks[0].sourceSegments.map((item) => [item.chunkStart, item.chunkEnd]),
  [[0, 6], [6, 12], [12, 18]],
);
assert.equal(merged.draft!.chunks.length, 1);
assert.equal(merged.draft!.chunks[0].finalText, "Alpha beta.\n\nGamma delta.");
assert.equal(merged.draft!.chunks[0].replacedChunkId, "left");
assert.deepEqual(merged.draft!.chunks[0].sourceBlockIds, ["block-1", "block-2"]);
assert.throws(
  () => applyReviewAction(stateWith([
    chunk("text", "Alpha beta.", [segment("block-1", 0, 11, 0, 11)]),
    { ...chunk("table", "Table content.", [segment("block-3", 0, 14, 0, 14)]), type: "table" },
  ]), blocks, { type: "merge-next", chunkId: "text", ...meta }),
  /adjacent compatible Chunks/,
);

const created = applyReviewAction(stateWith([]), blocks, {
  type: "source-create",
  blockIds: ["block-1"],
  ...meta,
});
assert.equal(created.draft!.chunks[0].automaticText, "Alpha beta.");
assert.equal(created.draft!.chunks[0].sourceSegments.every((item) =>
  "mappingQuality" in item && item.mappingQuality === "block-only" && item.sourceStart === null && item.bbox === null
), true, "source-created facts downgrade to block-only instead of inventing ranges or bbox");
assert.equal(created.draft!.chunks[0].embeddingEligible, false);
assert.equal(created.draft!.chunks[0].embeddingText, null);
assert.deepEqual(created.draft!.chunks[0].embeddingExclusionReasons, ["manual_review_required"]);

const added = applyReviewAction(created, blocks, {
  type: "source-add",
  chunkId: created.draft!.chunks[0].id,
  blockIds: ["block-3"],
  ...meta,
});
assert.equal(added.draft!.chunks[0].sourceBlockIds.includes("block-3"), true);
assert.equal(added.draft!.chunks[0].replacedChunkId, created.draft!.chunks[0].id);
assert.equal(added.draft!.chunks[0].contextReviewState, "not_generated");
const removed = applyReviewAction(added, blocks, {
  type: "source-remove",
  chunkId: added.draft!.chunks[0].id,
  blockIds: ["block-3"],
  ...meta,
});
assert.equal(removed.draft!.chunks[0].sourceBlockIds.includes("block-3"), false);
assert.throws(
  () => applyReviewAction(removed, blocks, {
    type: "source-remove",
    chunkId: removed.draft!.chunks[0].id,
    blockIds: ["block-1"],
    ...meta,
  }),
  /cannot remove every Source Segment/,
);
assert.throws(
  () => applyReviewAction(stateWith([]), [{
    contractVersion: "2.1",
    sourceDocumentVersion: "source-v1",
    parsedDocumentVersion: "parsed-v1",
    contentBlockId: "broken",
    rawBlockId: null,
    contentType: "paragraph",
    searchText: "",
  }], { type: "source-create", blockIds: ["broken"], ...meta }),
  /reliable searchText/,
);

let capped = stateWith([
  chunk("cap", "Alpha beta.", [segment("block-1", 0, 11, 0, 11)]),
]);
for (let index = 0; index < 55; index += 1) {
  capped = applyReviewAction(capped, blocks, {
    type: index % 2 ? "restore" : "exclude",
    chunkId: "cap",
    at: meta.at,
  });
}
assert.equal(capped.undoStack.length, 50);

console.log("V2.1 review action tests passed");
