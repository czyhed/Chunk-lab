import assert from "node:assert/strict";
import { buildChunkPreview, type ChunkRequest, type ParsedBlock } from "./chunking.js";
import { buildDocumentExport } from "./export.js";

const blocks: ParsedBlock[] = [
  {
    id: "b1",
    type: "text",
    text: "星澜 A1 安装方法：本产品杯体需要锁定。",
    page: 1,
    bbox: [0, 0, 100, 20],
    readingOrder: 0,
    role: "paragraph",
    productIdentity: "星澜 A1",
    sourceBackend: "fixture",
    sourceVersion: "fixture-v1",
  },
];
const request: ChunkRequest = {
  strategy: "structure",
  chunkSize: 128,
  chunkOverlap: 0,
  bufferSize: 1,
  breakpointPercentile: 90,
  semanticMaxChunkSize: 768,
  imagePolicy: "summary",
};
const preview = await buildChunkPreview(blocks, request);
const chunk = {
  ...preview.chunks[0],
  embeddingEligible: true,
  embeddingExclusionReasons: [],
  contextText: "该内容属于星澜 A1 的安装章节。它说明杯体使用前需要锁定。",
  contextReviewState: "stale" as const,
  contextModel: "fake-context",
  contextPromptVersion: "context-v1",
};
const exported = buildDocumentExport({
  documentId: "doc-1",
  name: "a1.pdf",
  chunks: [chunk],
  configuration: request,
  parserVersion: "fixture-v1",
  embeddingModel: "fake-embedding",
});
assert.equal(exported.chunks[0].embeddingText, chunk.finalText);
assert.equal(exported.chunks[0].chunkingStrategy, "structure");
assert.deepEqual(exported.chunks[0].chunkingParameters, request);
assert.equal(exported.chunks[0].parserVersion, "fixture-v1");
assert.equal(exported.chunks[0].embeddingModel, "fake-embedding");
assert.equal(exported.chunks[0].contextModel, "fake-context");
assert.deepEqual(exported.chunks[0].sourceSegments, chunk.sourceSegments);
assert.equal(JSON.stringify(exported).includes("apiKey"), false);
assert.equal(JSON.stringify(exported).includes("Authorization"), false);

console.log("Export contract tests passed");
