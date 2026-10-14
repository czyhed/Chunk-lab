import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildSpuMaterialMarkdown,
  createSpuMaterialExport,
  spuMaterialFileName,
  type SpuMaterialChunk,
} from "./spu-material-export.js";

assert.match(
  spuMaterialFileName({ spuId: "SPU-MOUSE-7K2M9Q4D", documentType: "manual", sourceName: "毒蝰 V3 Pro / 中文.pdf", exportVersion: "v2" }),
  /^SPU-MOUSE-7K2M9Q4D_manual_V3-Pro-[a-f0-9]{8}_v2\.md$/,
);
assert.equal(
  spuMaterialFileName({ spuId: "SPU-MOUSE-7K2M9Q4D", documentType: "other", sourceName: "....pdf", exportVersion: "v1" }),
  "SPU-MOUSE-7K2M9Q4D_other_source_v1.md",
);

const chunks: SpuMaterialChunk[] = [
  {
    chunkId: "chunk-2",
    finalText: "## 使用方法\n先锁定杯体。",
    reviewStatus: "completed_published",
    documentPublishEligible: true,
    sourceSegments: [{ blockId: "b2", page: 2, bbox: null, sourceStart: 0, sourceEnd: 8, chunkStart: 0, chunkEnd: 8, isOverlap: false }],
    order: 2,
  },
  {
    chunkId: "chunk-1",
    finalText: "# 产品概述\n星澜 A1。",
    reviewStatus: "completed_published",
    documentPublishEligible: true,
    sourceSegments: [{ blockId: "b1", page: 1, bbox: null, sourceStart: 0, sourceEnd: 8, chunkStart: 0, chunkEnd: 8, isOverlap: false }],
    order: 1,
  },
  {
    chunkId: "chunk-x",
    finalText: "内部解析备注",
    reviewStatus: "completed_excluded",
    documentPublishEligible: false,
    documentPublishExclusionReasons: ["quality_blocker"],
    sourceSegments: [],
    order: 3,
  },
];

const result = createSpuMaterialExport({
  batchId: "batch-1",
  documentId: "doc-1",
  sourceDocumentVersion: "source-v1",
  sourceName: "a1-manual.pdf",
  spuId: "SPU-10001",
  documentType: "manual",
  reviewRevision: 4,
  chunks,
  exportVersion: "v1",
  generatedAt: "2026-08-25T00:00:00.000Z",
});

assert.equal(result.status, "complete_with_exclusions");
assert.match(result.markdown, /SPU: SPU-10001/);
assert.match(result.markdown, /# 产品概述[\s\S]*## 使用方法/);
assert.doesNotMatch(result.markdown, /内部解析备注/);
assert.deepEqual(result.manifest.includedChunkIds, ["chunk-1", "chunk-2"]);
assert.deepEqual(result.manifest.excludedChunks, [{ chunkId: "chunk-x", reason: "quality_blocker" }]);
assert.equal(result.manifest.sourceDocumentVersion, "source-v1");
assert.equal(result.manifest.targetSpuId, "SPU-10001");
assert.equal(result.manifest.reviewRevision, 4);
assert.match(result.contentHash, /^[a-f0-9]{64}$/);

assert.throws(
  () => createSpuMaterialExport({
    batchId: "batch-1",
    documentId: "doc-1",
    sourceDocumentVersion: "source-v1",
    sourceName: "a1-manual.pdf",
    spuId: "SPU-10001",
    documentType: "manual",
    reviewRevision: 4,
    chunks: [{ ...chunks[0], reviewStatus: "pending" }],
    exportVersion: "v1",
    generatedAt: "2026-08-25T00:00:00.000Z",
  }),
  /未完成审核|pending/i,
);

assert.throws(
  () => createSpuMaterialExport({
    batchId: "batch-1",
    documentId: "doc-1",
    sourceDocumentVersion: "source-v1",
    sourceName: "a1-manual.pdf",
    spuId: "SPU-10001",
    documentType: "unknown" as never,
    reviewRevision: 4,
    chunks,
    exportVersion: "v1",
    generatedAt: "2026-08-25T00:00:00.000Z",
  }),
  /documentType/i,
);

assert.equal(
  buildSpuMaterialMarkdown({
    batchId: "batch-1",
    documentId: "doc-1",
    sourceDocumentVersion: "source-v1",
    sourceName: "a1-manual.pdf",
    spuId: "SPU-10001",
    documentType: "manual",
    reviewRevision: 4,
    chunks,
    exportVersion: "v1",
    generatedAt: "2026-08-25T00:00:00.000Z",
  }),
  result.markdown,
);

const richResult = createSpuMaterialExport({
  batchId: "batch-1",
  documentId: "doc-1",
  sourceDocumentVersion: "source-v1",
  sourceName: "a1-manual.pdf",
  spuId: "SPU-10001",
  documentType: "specification",
  reviewRevision: 5,
  exportVersion: "v2",
  generatedAt: "2026-08-26T00:00:00.000Z",
  chunks: [
    {
      chunkId: "table-1",
      finalText: "不应替代表格结构",
      reviewStatus: "completed_published",
      documentPublishEligible: true,
      sourceSegments: [],
      order: 1,
      title: "核心参数",
      tableArtifact: {
        title: "额定参数",
        columns: ["参数", "数值"],
        rows: [["额定电压", "220V"], ["备注", "A|B\n第二行"]],
      },
    },
    {
      chunkId: "image-only",
      finalText: "",
      reviewStatus: "completed_published",
      documentPublishEligible: true,
      sourceSegments: [],
      order: 2,
      title: "产品结构图",
      imageAssetReference: {
        bucket: "private-assets",
        key: "spu/SPU-10001/assets/product.png",
        uri: "s3://private-assets/spu/SPU-10001/assets/product.png",
      },
    },
  ],
});

assert.match(richResult.markdown, /## 核心参数/);
assert.match(richResult.markdown, /### 额定参数/);
assert.match(richResult.markdown, /\| 参数 \| 数值 \|/);
assert.match(richResult.markdown, /\| 备注 \| A\\\|B<br>第二行 \|/);
assert.doesNotMatch(richResult.markdown, /不应替代表格结构/);
assert.match(richResult.markdown, /!\[产品结构图\]\(asset:\/\/minio\/spu\/SPU-10001\/assets\/product\.png\)/);
assert.doesNotMatch(richResult.markdown, /s3:\/\//);
assert.deepEqual(richResult.manifest.includedChunkIds, ["table-1", "image-only"]);
assert.deepEqual(richResult.manifest.assets, [{
  chunkId: "image-only",
  reference: {
    bucket: "private-assets",
    key: "spu/SPU-10001/assets/product.png",
    uri: "s3://private-assets/spu/SPU-10001/assets/product.png",
  },
}]);
assert.deepEqual(richResult.manifest.chunks.find((chunk) => chunk.chunkId === "table-1")?.tableArtifact, {
  title: "额定参数",
  columns: ["参数", "数值"],
  rows: [["额定电压", "220V"], ["备注", "A|B\n第二行"]],
});

console.log("SPU material export tests passed");
