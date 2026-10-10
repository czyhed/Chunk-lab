import assert from "node:assert/strict";
import { buildPublicBatch } from "./v21-public-batch.js";

const publicBatch = buildPublicBatch({
  id: "batch-1",
  documents: [
    {
      id: "doc-1",
      name: "manual.pdf",
      state: "done",
      error: undefined,
      progress: { extractedPages: 2, totalPages: 2 },
      blocks: [{ id: "legacy-block" }],
      rawContentList: [{ rawTableHtml: "RAW_TABLE_SENTINEL" }],
      parsedDocumentV21: { raw: "PARSED_DOCUMENT_SENTINEL" },
      sourceAsset: { path: "LOCAL_PATH_SENTINEL", mimeType: "application/pdf" },
      visualCopyAsset: { path: "VISUAL_PATH_SENTINEL" },
      sourceContract: {
        sourceDocumentVersion: "source-v1",
        sourceViewKind: "original_file",
        visualCopy: { state: "failed", error: "converter unavailable" },
      },
      reviewState: {
        preview: null,
        draft: {
          chunks: [
            {
              qualityFlags: ["visual_copy_unavailable"],
              embeddingEligible: false,
            },
          ],
        },
      },
    },
    {
      id: "doc-2",
      name: "normal.md",
      state: "done",
      reviewState: { preview: null, draft: null },
    },
    {
      id: "doc-3",
      name: "parse-failed.pdf",
      state: "failed",
      error: "解析失败",
      diagnosticCategories: ["parse_failed"],
      reviewState: { preview: null, draft: null },
    },
  ],
});

assert.deepEqual(publicBatch, {
  id: "batch-1",
  documents: [
    {
      id: "doc-1",
      name: "manual.pdf",
      state: "done",
      progress: { extractedPages: 2, totalPages: 2 },
      blockCount: 1,
      chunkCount: 1,
      qualityFlagCount: 1,
      embeddingIneligibleCount: 1,
      sourceAvailable: true,
      visualCopyAvailable: true,
      sourceContract: {
        sourceDocumentVersion: "source-v1",
        sourceViewKind: "original_file",
        visualCopy: { state: "failed", qualityFlag: undefined },
      },
      diagnostic: { categories: ["visual_conversion_failed"] },
    },
    {
      id: "doc-2",
      name: "normal.md",
      state: "done",
      blockCount: 0,
      chunkCount: 0,
      qualityFlagCount: 0,
      embeddingIneligibleCount: 0,
      sourceAvailable: false,
      visualCopyAvailable: false,
    },
    {
      id: "doc-3",
      name: "parse-failed.pdf",
      state: "failed",
      error: "解析失败",
      blockCount: 0,
      chunkCount: 0,
      qualityFlagCount: 0,
      embeddingIneligibleCount: 0,
      sourceAvailable: false,
      visualCopyAvailable: false,
      diagnostic: { categories: ["parse_failed"] },
    },
  ],
});
assert.equal("diagnostic" in publicBatch.documents[1], false);
const serialized = JSON.stringify(publicBatch);
for (const forbidden of [
  "RAW_TABLE_SENTINEL",
  "PARSED_DOCUMENT_SENTINEL",
  "LOCAL_PATH_SENTINEL",
  "VISUAL_PATH_SENTINEL",
  "converter unavailable",
]) assert.equal(serialized.includes(forbidden), false);

console.log("V2.1 public batch projection tests passed");
