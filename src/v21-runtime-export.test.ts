import assert from "node:assert/strict";
import { projectRuntimeBatchExport } from "./v21-runtime-export.js";

const configuration = {
  strategy: "structure",
  chunkSize: 512,
  chunkOverlap: 64,
  bufferSize: 1,
  breakpointPercentile: 90,
  semanticMaxChunkSize: 768,
  imagePolicy: "summary",
} as const;
const sourceSegment = {
  sourceDocumentVersion: "source-v1",
  parsedDocumentVersion: "parsed-v1",
  contentBlockId: "block-1",
  rawBlockId: "raw-1",
  sourceViewKind: "parsed_document",
  page: null,
  bbox: null,
  sourceStart: null,
  sourceEnd: null,
  chunkStart: null,
  chunkEnd: null,
  isOverlap: false,
  mappingQuality: "block-only",
  locationQuality: "parsed_only",
  blockId: "block-1",
};
const batch = {
  id: "batch-1",
  documents: [
    {
      id: "v21",
      name: "manual.md",
      state: "done",
      parsedDocumentV21: {
        contractVersion: "2.1",
        sourceDocumentVersion: "source-v1",
        parsedDocumentVersion: "parsed-v1",
        normalizerVersion: "normalizer-v1",
        normalizedModelVersion: "model-v1",
        parserVersion: "commonmark-v1",
        blocks: [
          {
            contentBlockId: "block-1",
            contentType: "paragraph",
            normalizationStatus: "normalized",
            normalized: { type: "paragraph", text: "正文" },
            raw: { rawTableHtml: "RAW_SENTINEL" },
            display: { html: "DISPLAY_SENTINEL" },
          },
        ],
      },
      sourceContract: { visualCopy: { state: "not_requested" } },
      reviewState: {
        draft: {
          configuration,
          chunks: [
            {
              id: "chunk-1",
              type: "text",
              automaticText: "正文",
              finalText: "正文",
              contextText: "背景。说明。",
              contextReviewState: "stale",
              embeddingEligible: true,
              embeddingExclusionReasons: [],
              sourceSegments: [sourceSegment],
              productIdentity: "A1",
              relatedChunkIds: [],
              qualityFlags: [],
              revisions: [],
              contextCandidateReasons: ["需要背景"],
              contextScope: ["当前来源 block-1"],
              skippedNeighborReasons: [],
              normalizedModels: [{ type: "paragraph", text: "正文" }],
            },
          ],
        },
      },
      rawContentList: [{ rawTableHtml: "RAW_SENTINEL" }],
      sourceAsset: { path: "LOCAL_PATH_SENTINEL" },
    },
    {
      id: "pending",
      name: "pending.pdf",
      state: "running",
      reviewState: {},
    },
    {
      id: "failed",
      name: "failed.pdf",
      state: "failed",
      error: "parse failed",
      reviewState: {},
    },
  ],
} as const;

const projected = projectRuntimeBatchExport(batch, {
  exportedAt: "2026-08-13T00:00:00.000Z",
  selectedContractVersion: "2.1",
  embeddingModel: "embedding-v1",
});
assert.equal(projected.documents.length, 3);
const v21 = projected.documents[0];
assert.equal(v21.contractVersion, "2.1");
if (v21.contractVersion !== "2.1" || !v21.draft) throw new Error("expected 2.1");
assert.equal(v21.draft.chunks[0].parsedDocumentVersion, "parsed-v1");
assert.equal(v21.draft.chunks[0].sourceSegments[0].chunkStart, null);
assert.equal(v21.draft.chunks[0].contextReviewState, "stale");
assert.equal(projected.documents[1].deliveryState, "pending");
assert.equal(projected.documents[2].deliveryState, "failed");
assert.equal(JSON.stringify(projected).includes("RAW_SENTINEL"), false);
assert.equal(JSON.stringify(projected).includes("DISPLAY_SENTINEL"), false);
assert.equal(JSON.stringify(projected).includes("LOCAL_PATH_SENTINEL"), false);

console.log("V2.1 runtime export projection tests passed");
