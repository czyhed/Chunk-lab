import assert from "node:assert/strict";
import {
  buildBatchExport,
  ExportContractSelectionError,
  type ExportDocumentInput,
  type V21ExportableChunk,
  type V21ExportDocumentInput,
} from "./v21-export.js";

const sourceSegment = {
  sourceDocumentVersion: "source-v1",
  parsedDocumentVersion: "parsed-v1",
  contentBlockId: "parsed-v1:content-block:000001",
  rawBlockId: "mineru-1",
  sourceViewKind: "original_file" as const,
  page: 1,
  bbox: [10, 20, 100, 60] as [number, number, number, number],
  sourceStart: 0,
  sourceEnd: 10,
  chunkStart: 0,
  chunkEnd: 10,
  isOverlap: false,
  mappingQuality: "exact" as const,
  locationQuality: "page_only" as const,
};

const blockOnlySourceSegment = {
  ...sourceSegment,
  sourceStart: null,
  sourceEnd: null,
  chunkStart: null,
  chunkEnd: null,
  mappingQuality: "block-only" as const,
  locationQuality: "parsed_only" as const,
  sourceViewKind: "parsed_document" as const,
  page: null,
  bbox: null,
};

const baseChunk: V21ExportableChunk = {
  contractVersion: "2.1",
  parsedDocumentVersion: "parsed-v1",
  normalizationStatus: "normalized",
  chunkId: "chunk-1",
  contentType: "paragraph",
  normalizedModel: [{ type: "paragraph", text: "A1 安装说明。" }],
  reviewedModel: null,
  automaticText: "A1 安装说明。",
  finalText: "A1 安装说明。",
  contextText: "这是 A1 型号的安装章节。",
  contextReviewState: "confirmed",
  embeddingEligible: true,
  embeddingExclusionReasons: [],
  sourceSegments: [sourceSegment],
  sourceViewKinds: ["original_file"],
  locationQualitySummary: "page_only",
  mappingQualitySummary: "exact",
  productIdentity: "A1",
  parentSectionId: "installation",
  relatedChunkIds: [],
  qualityFlags: ["source_location_page_only"],
  revisions: [],
  chunkingStrategy: "structure",
  chunkingParameters: { chunkSize: 512, chunkOverlap: 64 },
  parserVersion: "mineru-test",
  normalizerVersion: "normalizer-test",
  normalizedModelVersion: "model-test",
  embeddingModel: "embedding-test",
  contextModel: "context-test",
  contextCandidateReasons: ["缺少完整章节背景"],
  contextScope: ["chunk-1", "chunk-2"],
  skippedNeighborReasons: [{ chunkId: "chunk-0", reasons: ["unsupported_content"] }],
};

const completedV21: V21ExportDocumentInput = {
    documentId: "done-v21",
    name: "done.pdf",
    contractVersion: "2.1" as const,
    deliveryState: "completed" as const,
    sourceDocumentVersion: "source-v1",
    parsedDocumentVersion: "parsed-v1",
    visualCopyState: "not_requested" as const,
    qualityFlags: [],
    draft: { chunks: [baseChunk] },
};

const documents: ExportDocumentInput[] = [
  completedV21,
  {
    documentId: "pending-v21",
    name: "pending.pdf",
    contractVersion: "2.1" as const,
    deliveryState: "pending" as const,
    visualCopyState: "not_requested" as const,
    qualityFlags: [],
  },
  {
    documentId: "failed-v21",
    name: "failed.pdf",
    contractVersion: "2.1" as const,
    deliveryState: "failed" as const,
    failureReason: "解析失败",
    visualCopyState: "not_requested" as const,
    qualityFlags: [],
  },
  {
    documentId: "visual-failed-v21",
    name: "manual.docx",
    contractVersion: "2.1" as const,
    deliveryState: "completed" as const,
    sourceDocumentVersion: "source-office",
    parsedDocumentVersion: "parsed-office",
    visualCopyState: "failed" as const,
    qualityFlags: [],
    draft: { chunks: [{ ...baseChunk, chunkId: "chunk-office" }] },
  },
  {
    documentId: "done-legacy",
    name: "legacy.pdf",
    contractVersion: "legacy" as const,
    deliveryState: "completed" as const,
    visualCopyState: "not_requested" as const,
    qualityFlags: [],
    draft: {
      chunks: [
        {
          chunkId: "legacy-chunk",
          finalText: "旧版正文",
          sourceBlockIds: ["legacy-block"],
          qualityFlags: [],
          revisions: [],
        },
      ],
    },
  },
];

assert.throws(
  () => buildBatchExport({ batchId: "batch-1", exportedAt: "2026-08-13T00:00:00.000Z", documents }),
  (error: unknown) =>
    error instanceof ExportContractSelectionError &&
    error.code === "CONTRACT_SELECTION_REQUIRED" &&
    error.availableContractVersions.join(",") === "2.1,legacy",
);

const v21 = buildBatchExport({
  batchId: "batch-1",
  exportedAt: "2026-08-13T00:00:00.000Z",
  selectedContractVersion: "2.1",
  documents,
});
assert.deepEqual(v21.availableContractVersions, ["2.1", "legacy"]);
assert.equal(v21.documents.length, 2);
assert.deepEqual(v21.documents.map((document) => document.documentId), [
  "done-v21",
  "visual-failed-v21",
]);
assert.equal(v21.manifest.length, documents.length);
assert.deepEqual(
  v21.manifest.map(({ documentId, deliveryState, exported, reason }) => ({
    documentId,
    deliveryState,
    exported,
    reason,
  })),
  [
    { documentId: "done-v21", deliveryState: "completed", exported: true, reason: null },
    { documentId: "pending-v21", deliveryState: "pending", exported: false, reason: "pending" },
    { documentId: "failed-v21", deliveryState: "failed", exported: false, reason: "解析失败" },
    { documentId: "visual-failed-v21", deliveryState: "completed", exported: true, reason: null },
    { documentId: "done-legacy", deliveryState: "completed", exported: false, reason: "contract_not_selected" },
  ],
);
assert.ok(
  v21.manifest.find((entry) => entry.documentId === "visual-failed-v21")!
    .qualityFlags.includes("visual_copy_unavailable"),
  "Visual Copy failure is a quality flag, not a delivery failure",
);

const exportedChunk = v21Chunk(v21.documents[0].chunks[0]);
assert.equal(
  exportedChunk.embeddingText,
  `${baseChunk.contextText}\n\n${baseChunk.finalText}`,
);
assert.deepEqual(Object.keys(exportedChunk), [
  "contractVersion",
  "parsedDocumentVersion",
  "normalizationStatus",
  "chunkId",
  "contentType",
  "normalizedModel",
  "reviewedModel",
  "automaticText",
  "finalText",
  "contextText",
  "contextReviewState",
  "embeddingText",
  "embeddingEligible",
  "embeddingExclusionReasons",
  "sourceSegments",
  "sourceViewKinds",
  "locationQualitySummary",
  "mappingQualitySummary",
  "productIdentity",
  "parentSectionId",
  "relatedChunkIds",
  "qualityFlags",
  "revisions",
  "chunkingStrategy",
  "chunkingParameters",
  "parserVersion",
  "normalizerVersion",
  "normalizedModelVersion",
  "embeddingModel",
  "contextModel",
  "contextCandidateReasons",
  "contextScope",
  "skippedNeighborReasons",
]);
assert.equal(JSON.stringify(v21).includes("rawTableHtml"), false);
assert.equal(JSON.stringify(v21).includes("displayHtml"), false);

assert.throws(
  () =>
    buildBatchExport({
      batchId: "diagnostic-leak",
      exportedAt: "2026-08-13T00:00:00.000Z",
      documents: [
        {
          ...completedV21,
          draft: {
            chunks: [
              {
                ...baseChunk,
                normalizedModel: {
                  type: "table",
                  rawTableHtml: "<table><tr><td>secret diagnostic</td></tr></table>",
                },
              },
            ],
          },
        },
      ],
    }),
  /diagnostic field rawTableHtml/i,
  "diagnostic data hidden inside an ordinary semantic field is rejected",
);

for (const contextReviewState of [
  "not_generated",
  "generating",
  "awaiting_review",
  "failed",
  "stale",
] as const) {
  const output = buildBatchExport({
    batchId: "embedding-state",
    exportedAt: "2026-08-13T00:00:00.000Z",
    documents: [
      {
        ...completedV21,
        draft: { chunks: [{ ...baseChunk, contextReviewState }] },
      },
    ],
  });
  assert.equal(
    v21Chunk(output.documents[0].chunks[0]).embeddingText,
    baseChunk.finalText,
  );
}

const ineligible = buildBatchExport({
  batchId: "ineligible",
  exportedAt: "2026-08-13T00:00:00.000Z",
  documents: [
    {
      ...completedV21,
      draft: {
        chunks: [
          {
            ...baseChunk,
            embeddingEligible: false,
            embeddingExclusionReasons: ["unsupported_content"],
          },
        ],
      },
    },
  ],
});
assert.equal(v21Chunk(ineligible.documents[0].chunks[0]).embeddingText, null);

const blockOnly = buildBatchExport({
  batchId: "block-only",
  exportedAt: "2026-08-13T00:00:00.000Z",
  documents: [
    {
      ...completedV21,
      draft: {
        chunks: [
          {
            ...baseChunk,
            sourceSegments: [blockOnlySourceSegment],
          } satisfies V21ExportableChunk,
        ],
      },
    },
  ],
});
assert.equal(
  v21Chunk(blockOnly.documents[0].chunks[0]).sourceSegments[0].chunkStart,
  null,
);

const legacy = buildBatchExport({
  batchId: "batch-1",
  exportedAt: "2026-08-13T00:00:00.000Z",
  selectedContractVersion: "legacy",
  documents,
});
assert.deepEqual(legacy.documents.map((document) => document.documentId), ["done-legacy"]);
assert.deepEqual(Object.keys(legacy.documents[0].chunks[0]), [
  "chunkId",
  "finalText",
  "sourceBlockIds",
  "qualityFlags",
  "revisions",
]);
assert.equal(JSON.stringify(legacy.documents).includes("contractVersion\":\"2.1"), false);

function v21Chunk(
  chunk: (typeof v21.documents)[number]["chunks"][number],
) {
  if (!("contractVersion" in chunk)) throw new Error("Expected a Contract 2.1 Chunk");
  return chunk;
}

console.log("V2.1 export manifest tests passed");
