import assert from "node:assert/strict";
import { chunkBlocks, type ChunkRequest } from "./chunking.js";
import { confirmPreview, createReviewState, setPreview } from "./review-state.js";
import {
  applyMineruResults,
  mineruBatchIdsFor,
  resetDocumentForReparse,
  type ParseLifecycleDocument,
} from "./parse-lifecycle.js";

const request: ChunkRequest = {
  strategy: "structure",
  chunkSize: 512,
  chunkOverlap: 64,
  bufferSize: 1,
  breakpointPercentile: 90,
  semanticMaxChunkSize: 768,
  imagePolicy: "summary",
};
const sourceBlock = {
  id: "b-1",
  type: "text" as const,
  text: "星澜 A1 安装说明。",
  page: 1,
  bbox: [10, 20, 100, 60],
};
const documents: ParseLifecycleDocument[] = [
  { id: "ok", name: "ok.pdf", state: "running", reviewState: createReviewState() },
  { id: "bad", name: "bad.pdf", state: "running", reviewState: createReviewState() },
  { id: "waiting", name: "waiting.pdf", state: "pending", reviewState: createReviewState() },
  { id: "failed", name: "failed.pdf", state: "running", reviewState: createReviewState() },
];
await applyMineruResults(
  documents,
  [
    { data_id: "bad", file_name: "bad.pdf", state: "done", full_zip_url: "bad.zip" },
    { data_id: "ok", file_name: "ok.pdf", state: "done", full_zip_url: "ok.zip" },
    { data_id: "waiting", file_name: "waiting.pdf", state: "waiting-file" },
    { data_id: "failed", file_name: "failed.pdf", state: "failed", err_msg: "fixture parse failed" },
  ],
  async (url) => {
    if (url === "bad.zip") throw new Error("fixture ZIP is corrupt");
    return {
      markdown: "# A1",
      blocks: [sourceBlock],
      rawContentList: [{ id: "raw-1", type: "title", text: "A1" }],
    };
  },
);
assert.equal(documents[0].state, "done");
assert.deepEqual(documents[0].blocks, [sourceBlock]);
assert.deepEqual(documents[0].rawContentList, [
  { id: "raw-1", type: "title", text: "A1" },
]);
assert.equal(documents[1].state, "failed");
assert.match(documents[1].error ?? "", /ZIP is corrupt/);
assert.deepEqual(documents[1].diagnosticCategories, ["mineru_result_anomaly"]);
assert.equal(documents[2].state, "pending", "MinerU waiting-file remains waiting");
assert.deepEqual(documents[3].diagnosticCategories, ["parse_failed"]);

const downloading: ParseLifecycleDocument = {
  id: "downloading",
  name: "downloading.pdf",
  state: "running",
  reviewState: createReviewState(),
};
let finishDownload!: () => void;
const downloadGate = new Promise<void>((resolveDownload) => {
  finishDownload = resolveDownload;
});
const applyingDownload = applyMineruResults(
  [downloading],
  [{
    data_id: "downloading",
    file_name: "downloading.pdf",
    state: "done",
    full_zip_url: "downloading.zip",
  }],
  async () => {
    await downloadGate;
    return { markdown: "# Downloaded", blocks: [sourceBlock] };
  },
);
await Promise.resolve();
assert.equal(
  downloading.state,
  "running",
  "done is not observable until the result ZIP is normalized",
);
finishDownload();
await applyingDownload;
assert.equal(downloading.state, "done");
assert.deepEqual(downloading.blocks, [sourceBlock]);

const preview = {
  chunks: chunkBlocks([sourceBlock], request),
  semanticSignals: [],
  metrics: {
    chunkCount: 1,
    token: { minimum: 1, average: 1, maximum: 1 },
    tokenDistribution: { under80: 1, "80to255": 0, "256to511": 0, "512to1023": 0, "1024plus": 0 },
    oversizedCount: 0,
    undersizedCount: 1,
    actualOverlapRatio: 0,
    crossPageCount: 0,
    typeCounts: { text: 1, image: 0, table: 0 },
    missingProductIdentityCount: 1,
    contextCandidateCount: 0,
  },
};
const derived = documents[0];
derived.reviewState = confirmPreview(
  setPreview(createReviewState(), preview, request),
);
derived.reviewState.draft!.chunks[0].finalText = "人工修订";
derived.reviewState.draft!.chunks[0].contextText = "人工 Context";
derived.reviewState.draft!.chunks[0].contextReviewState = "human_modified";
resetDocumentForReparse(derived);
assert.equal(derived.state, "pending");
assert.equal(derived.blocks, undefined);
assert.equal(derived.rawContentList, undefined);
assert.equal(derived.markdown, undefined);
assert.equal(derived.reviewState.preview, null);
assert.equal(derived.reviewState.draft, null);
assert.deepEqual(derived.reviewState.undoStack, []);
assert.deepEqual(derived.reviewState.redoStack, []);
assert.equal(derived.diagnosticCategories, undefined);

assert.deepEqual(
  mineruBatchIdsFor(
    { mineruBatchId: "legacy-job", mineruBatchIds: ["current-job"] },
    "retry-job",
  ),
  ["current-job", "legacy-job", "retry-job"],
);
assert.deepEqual(
  mineruBatchIdsFor({ mineruBatchId: "same-job", mineruBatchIds: ["same-job"] }),
  ["same-job"],
);

console.log("Parse lifecycle tests passed");
