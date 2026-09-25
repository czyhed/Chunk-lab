import assert from "node:assert/strict";
import {
  applyTextRevision,
  confirmPreview,
  createReviewState,
  redoRevision,
  restoreReviewState,
  serializeReviewState,
  setPreview,
  toggleExcluded,
  undoRevision,
} from "./review-state.js";
import { buildChunkPreview, type ChunkRequest, type ParsedBlock } from "./chunking.js";

const blocks: ParsedBlock[] = [
  {
    id: "b1",
    type: "text",
    text: "A1 商品安装前请断电。",
    page: 1,
    bbox: [10, 10, 200, 40],
    readingOrder: 0,
    role: "paragraph",
    productIdentity: "A1",
  },
  {
    id: "b2",
    type: "text",
    text: "确认额定电压后连接电源。",
    page: 2,
    bbox: [10, 10, 200, 40],
    readingOrder: 1,
    role: "paragraph",
    productIdentity: "A1",
  },
];
const request: ChunkRequest = {
  strategy: "structure",
  chunkSize: 128,
  chunkOverlap: 16,
  bufferSize: 1,
  breakpointPercentile: 90,
  semanticMaxChunkSize: 768,
  imagePolicy: "summary",
};
const preview = await buildChunkPreview(blocks, request);
let state = createReviewState();
state = setPreview(state, preview, request);
assert.equal(state.draft, null);
assert.equal(state.preview?.chunks.length, 1);

state = confirmPreview(state);
assert.equal(state.preview, null);
assert.equal(state.draft?.chunks.length, 1);
const originalText = state.draft!.chunks[0].finalText;

state = applyTextRevision(state, state.draft!.chunks[0].id, `${originalText} 已人工核对。`);
assert.equal(state.draft!.chunks[0].automaticText, originalText);
assert.equal(state.draft!.chunks[0].finalText.endsWith("已人工核对。"), true);
assert.equal(state.draft!.chunks[0].contextReviewState, "not_generated");

let neverGenerated = confirmPreview(setPreview(createReviewState(), preview, request));
neverGenerated = applyTextRevision(
  neverGenerated,
  neverGenerated.draft!.chunks[0].id,
  `${neverGenerated.draft!.chunks[0].finalText} 第二次人工核对。`,
);
assert.equal(
  neverGenerated.draft!.chunks[0].contextReviewState,
  "not_generated",
  "text correction must not mark missing Context as stale",
);

state = undoRevision(state);
assert.equal(state.draft!.chunks[0].finalText, originalText);
state = redoRevision(state);
assert.equal(state.draft!.chunks[0].finalText.endsWith("已人工核对。"), true);

state = toggleExcluded(state, state.draft!.chunks[0].id);
assert.equal(state.draft!.chunks[0].excluded, true);
state = toggleExcluded(state, state.draft!.chunks[0].id);
assert.equal(state.draft!.chunks[0].excluded, false);

const newPreview = await buildChunkPreview(blocks, { ...request, chunkSize: 48 });
const editedDraftText = state.draft!.chunks[0].finalText;
state = setPreview(state, newPreview, { ...request, chunkSize: 48 });
assert.equal(
  state.draft!.chunks[0].finalText,
  editedDraftText,
  "a new Preview must not overwrite the current Draft",
);
state = confirmPreview(state);
assert.equal(state.undoStack.length, 0);
assert.equal(state.preview, null);

const restored = restoreReviewState(JSON.parse(serializeReviewState(state)));
assert.equal(serializeReviewState(restored), serializeReviewState(state));

const staleMetrics = structuredClone(restored);
const staleChunk = staleMetrics.draft!.chunks[0];
staleChunk.finalText = "人工短文本";
staleChunk.text = staleChunk.finalText;
staleChunk.tokenCount = 9999;
staleChunk.qualityFlags = ["oversized"];
staleMetrics.draft!.metrics.chunkCount = 999;
const normalized = restoreReviewState(staleMetrics);
assert.equal(normalized.draft!.chunks[0].tokenCount < 80, true);
assert.deepEqual(normalized.draft!.chunks[0].qualityFlags, ["undersized"]);
assert.equal(normalized.draft!.metrics.chunkCount, normalized.draft!.chunks.length);
assert.equal(
  normalized.draft!.metrics.token.minimum,
  Math.min(...normalized.draft!.chunks.map((chunk) => chunk.tokenCount)),
);

console.log("Review state tests passed");
