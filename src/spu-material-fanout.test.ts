import assert from "node:assert/strict";
import { createSpuMaterialFanout, type SpuMaterialChunk } from "./spu-material-export.js";

const base = (chunkId: string, text: string, scope: SpuMaterialChunk["scope"], targetSpuIds?: string[]): SpuMaterialChunk => ({
  chunkId,
  finalText: text,
  reviewStatus: "completed_published",
  documentPublishEligible: true,
  sourceSegments: [],
  scope,
  targetSpuIds,
});

const result = createSpuMaterialFanout({
  batchId: "b1", documentId: "d1", sourceDocumentVersion: "v1", sourceName: "manual.pdf",
  documentType: "manual", reviewRevision: 1, exportVersion: "v1", generatedAt: "2026-08-26T00:00:00.000Z",
  targetSpuIds: ["SPU-1", "SPU-2"],
  chunks: [
    base("common", "通用说明", "common"),
    base("one", "一号专属", "assigned", ["SPU-1"]),
    base("two", "二号专属", "assigned", ["SPU-2"]),
  ],
});
assert.equal(result.status, "complete");
assert.deepEqual(result.results.map((entry) => entry.spuId), ["SPU-1", "SPU-2"]);
const first = result.results[0]!;
const second = result.results[1]!;
assert.equal(first.status === "blocked", false);
assert.equal(second.status === "blocked", false);
if (first.status !== "blocked" && second.status !== "blocked") {
  assert.match(first.markdown, /通用说明/);
  assert.match(first.markdown, /一号专属/);
  assert.doesNotMatch(first.markdown, /二号专属/);
  assert.match(second.markdown, /二号专属/);
  assert.doesNotMatch(second.markdown, /一号专属/);
}

const limitedCommon = createSpuMaterialFanout({
  batchId: "b1", documentId: "d1", sourceDocumentVersion: "v1", sourceName: "manual.pdf",
  documentType: "manual", reviewRevision: 1, exportVersion: "v1", generatedAt: "2026-08-26T00:00:00.000Z",
  targetSpuIds: ["SPU-1", "SPU-2"],
  chunks: [
    base("limited-common", "仅一号可用的公共说明", "common", ["SPU-1"]),
    base("two", "二号专属", "assigned", ["SPU-2"]),
  ],
});
const limitedFirst = limitedCommon.results.find((entry) => entry.spuId === "SPU-1")!;
const limitedSecond = limitedCommon.results.find((entry) => entry.spuId === "SPU-2")!;
assert.equal(limitedFirst.status === "blocked", false);
assert.equal(limitedSecond.status === "blocked", false);
if (limitedFirst.status !== "blocked" && limitedSecond.status !== "blocked") {
  assert.match(limitedFirst.markdown, /仅一号可用的公共说明/);
  assert.doesNotMatch(limitedSecond.markdown, /仅一号可用的公共说明/);
  assert.match(limitedSecond.markdown, /二号专属/);
}

const unassigned = createSpuMaterialFanout({
  batchId: "b1", documentId: "d1", sourceDocumentVersion: "v1", sourceName: "manual.pdf",
  documentType: "manual", reviewRevision: 1, exportVersion: "v1", generatedAt: "2026-08-26T00:00:00.000Z",
  targetSpuIds: ["SPU-1", "SPU-2"], chunks: [base("u", "待归属", "unassigned")],
});
assert.equal(unassigned.status, "blocked");
assert.equal(unassigned.results.every((entry) => entry.status === "blocked"), true);

const conflicted = createSpuMaterialFanout({
  batchId: "b1", documentId: "d1", sourceDocumentVersion: "v1", sourceName: "manual.pdf",
  documentType: "manual", reviewRevision: 1, exportVersion: "v1", generatedAt: "2026-08-26T00:00:00.000Z",
  targetSpuIds: ["SPU-1", "SPU-2"], chunks: [base("c", "冲突", "conflicted", ["SPU-1"])],
});
assert.equal(conflicted.results.find((entry) => entry.spuId === "SPU-1")!.status, "blocked");
assert.equal(conflicted.results.find((entry) => entry.spuId === "SPU-2")!.status, "complete");

const conflictedWithoutTargets = createSpuMaterialFanout({
  batchId: "b1", documentId: "d1", sourceDocumentVersion: "v1", sourceName: "manual.pdf",
  documentType: "manual", reviewRevision: 1, exportVersion: "v1", generatedAt: "2026-08-26T00:00:00.000Z",
  targetSpuIds: ["SPU-1", "SPU-2"], chunks: [base("c2", "冲突未指定目标", "conflicted")],
});
assert.equal(conflictedWithoutTargets.status, "blocked");
assert.equal(conflictedWithoutTargets.results.every((entry) => entry.status === "blocked"), true);

console.log("SPU material fan-out tests passed");
