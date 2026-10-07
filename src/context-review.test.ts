import assert from "node:assert/strict";
import { buildChunkPreview, type Chunk, type ChunkRequest, type ParsedBlock } from "./chunking.js";
import {
  applyGeneratedContexts,
  editDraftContext,
  generateDraftContexts,
  reconcileDraftContextInvalidation,
} from "./context-review.js";
import { confirmPreview, createReviewState, setPreview } from "./review-state.js";

const blocks: ParsedBlock[] = [
  { id: "title", type: "text", text: "星澜 A1", page: 1, bbox: null, readingOrder: 0, role: "heading", productIdentity: "星澜 A1" },
  { id: "body", type: "text", text: "本产品杯体需要锁定。", page: 1, bbox: null, readingOrder: 1, role: "paragraph", parentId: "title", productIdentity: "星澜 A1" },
];
const request: ChunkRequest = { strategy: "structure", chunkSize: 32, chunkOverlap: 0, bufferSize: 1, breakpointPercentile: 90, semanticMaxChunkSize: 768, imagePolicy: "summary" };
const preview = await buildChunkPreview(blocks, request);
preview.chunks = preview.chunks.map((chunk) => ({
  ...chunk,
  embeddingEligible: true,
  embeddingExclusionReasons: [],
})) as typeof preview.chunks;
const review = confirmPreview(setPreview(createReviewState(), preview, request));
const chunkId = review.draft!.chunks[0].id;
let calls = 0;
const pending = await generateDraftContexts(
  review,
  [chunkId],
  blocks.map((block) => ({
    contentBlockId: block.id,
    searchText: block.text,
    contentType: block.role,
    parentContentBlockId: block.parentId ?? null,
  })),
  async () => {
    calls += 1;
    return "该内容属于星澜 A1 的安装章节。它要求使用前锁定杯体。";
  },
  { model: "fake-chat", promptVersion: "context-v1" },
);
assert.equal(calls, 1);
assert.equal(pending.review.draft!.chunks[0].contextReviewState, "awaiting_review");

const changedReview = structuredClone(review);
changedReview.draft!.chunks[0].finalText += " 已人工修订。";
const merged = applyGeneratedContexts(
  changedReview,
  pending.baselineChunks,
  pending.review.draft!.chunks,
  [chunkId],
);
assert.equal(merged.draft!.chunks[0].contextReviewState, "stale");
assert.equal(merged.draft!.chunks[0].contextText, "");
assert.match(merged.draft!.chunks[0].contextError ?? "", /输入已变化/);

const manual = editDraftContext(review, chunkId, "人工补充商品与章节信息。");
assert.equal(manual.draft!.chunks[0].contextReviewState, "human_modified");
assert.equal(manual.undoStack.length, 1);

const qualityOnly = structuredClone(manual);
qualityOnly.draft!.chunks[0].qualityFlags = ["undersized"];
assert.equal(
  reconcileDraftContextInvalidation(manual, qualityOnly).draft!.chunks[0]
    .contextReviewState,
  "human_modified",
  "quality-only changes must not stale Context",
);
const sourceChanged = structuredClone(manual);
sourceChanged.draft!.chunks[0].sourceSegments[0].sourceEnd -= 1;
const reconciled = reconcileDraftContextInvalidation(manual, sourceChanged);
assert.equal(reconciled.draft!.chunks[0].contextReviewState, "stale");
assert.equal(
  reconciled.draft!.chunks[0].contextText,
  manual.draft!.chunks[0].contextText,
  "stale Context remains visible for review but is not embedding-eligible",
);
for (const mutate of [
  (chunk: Chunk) => (chunk.finalText += " 修订"),
  (chunk: Chunk) => (chunk.parentSectionId = "new-parent"),
  (chunk: Chunk) => (chunk.productIdentity = "星澜 A2"),
  (chunk: Chunk) => chunk.sourceSegments.push({ ...chunk.sourceSegments[0], sourceStart: 1 }),
  (chunk: Chunk) =>
    Object.assign(chunk, { contentGroupIds: ["changed-group"] }),
  (chunk: Chunk) =>
    Object.assign(chunk, { approvedEnrichmentFingerprint: "changed-enrichment" }),
]) {
  const changed = structuredClone(manual);
  mutate(changed.draft!.chunks[0]);
  assert.equal(
    reconcileDraftContextInvalidation(manual, changed).draft!.chunks[0]
      .contextReviewState,
    "stale",
  );
}

await assert.rejects(
  () => generateDraftContexts(createReviewState(), [chunkId], [], async () => "两句。一句。", { model: "fake", promptVersion: "v1" }),
  /Draft/,
);

console.log("Context review tests passed");
