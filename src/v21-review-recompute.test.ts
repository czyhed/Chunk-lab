import assert from "node:assert/strict";
import type { ContentBlock } from "./v21-contract.js";
import type { SourceSegmentV21 } from "./v21-provenance.js";
import {
  recomputeReviewedChunk,
  type ReviewableChunk,
} from "./v21-review-recompute.js";

const sourceBlock = {
  contractVersion: "2.1",
  parsedDocumentVersion: "parsed-v1",
  parser: "mineru",
  parserVersion: "mineru-test",
  normalizerVersion: "normalizer-test",
  normalizedModelVersion: "model-test",
  rawBlockId: "raw-1",
  contentType: "unsupported",
  raw: { type: "unknown", source: "原始诊断内容" },
  normalized: null,
  display: { text: "Unsupported content" },
  searchText: "",
  normalizationStatus: "unsupported",
  automaticText: "",
  finalText: "",
  excludedFromContentFlow: true,
  sourceRange: null,
} satisfies ContentBlock;

const sourceSegment = {
  sourceDocumentVersion: "source-v1",
  parsedDocumentVersion: "parsed-v1",
  contentBlockId: "parsed-v1:content-block:000001",
  rawBlockId: "raw-1",
  sourceViewKind: "parsed_document",
  page: null,
  bbox: null,
  sourceStart: null,
  sourceEnd: null,
  chunkStart: 0,
  chunkEnd: 6,
  isOverlap: false,
  mappingQuality: "block-only",
  locationQuality: "parsed_only",
} satisfies SourceSegmentV21;

function chunk(overrides: Partial<ReviewableChunk> = {}): ReviewableChunk {
  return {
    chunkId: "chunk-1",
    sourceBlock,
    automaticText: "原始自动文本",
    sourceSegments: [sourceSegment],
    locationQuality: "parsed_only",
    qualityFlags: ["needs_review"],
    contextText: "这是已审核背景。",
    contextReviewState: "confirmed",
    revisions: [],
    ...overrides,
  };
}

const repaired = recomputeReviewedChunk(chunk(), {
  at: "2026-08-13T08:00:00.000Z",
  reviewedModel: {
    type: "plain_text_repair",
    classification: "paragraph",
    text: "A1 型号额定功率为 1200 W。",
  },
});
assert.equal(repaired.contentType, "paragraph");
assert.equal(repaired.normalizationStatus, "manual_fixed");
assert.equal(repaired.automaticText, "原始自动文本", "automatic source text is immutable");
assert.deepEqual(repaired.normalizedModel, null, "normalized parser model is immutable");
assert.equal(repaired.searchText, "A1 型号额定功率为 1200 W。");
assert.equal(repaired.finalText, repaired.searchText);
assert.equal(repaired.display.text, repaired.searchText);
assert.equal(repaired.embeddingEligible, true);
assert.deepEqual(repaired.embeddingExclusionReasons, []);
assert.equal(repaired.embeddingText, null, "Plan 03 owns embedding text composition");
assert.ok(repaired.metrics.tokenCount > 0);
assert.deepEqual(repaired.sourceSegments, [sourceSegment]);
assert.notEqual(repaired.sourceSegments, chunk().sourceSegments);
assert.equal(repaired.contextReviewState, "stale");
assert.equal(repaired.contextText, "这是已审核背景。");
assert.match(repaired.contextStaleReason ?? "", /审阅模型/);
assert.equal(repaired.revisions.length, 1);
assert.equal(repaired.revisions[0].type, "reviewed_model");

const typedCases = [
  {
    reviewedModel: { type: "paragraph", text: "安装前断开电源。" },
    searchText: "安装前断开电源。",
  },
  {
    reviewedModel: { type: "list", ordered: true, items: ["断电", "锁紧杯体"] },
    searchText: "1. 断电\n2. 锁紧杯体",
  },
  {
    reviewedModel: {
      type: "table",
      title: "A1 参数",
      columns: ["参数", "值"],
      rows: [
        [
          { cellId: "c1", text: "额定电压", rowSpan: 2, colSpan: 1 },
          { cellId: "c2", text: "220 V", rowSpan: 1, colSpan: 1 },
        ],
        [{ cellId: "c3", text: "50 Hz", rowSpan: 1, colSpan: 1 }],
      ],
      notes: ["以铭牌为准"],
    },
    searchText: "A1 参数\n参数 | 值\n额定电压 | 220 V\n50 Hz\nNote: 以铭牌为准",
  },
  {
    reviewedModel: {
      type: "image",
      imageId: "image-1",
      caption: "杯体锁定方向",
      productIdentity: "A1",
      summary: "箭头指向顺时针。",
    },
    searchText: "Caption: 杯体锁定方向\nProduct: A1\nSummary: 箭头指向顺时针。",
  },
  {
    reviewedModel: { type: "formula", latex: "P = U \\times I", context: "功率公式" },
    searchText: "功率公式\nP = U \\times I",
  },
  {
    reviewedModel: { type: "code", language: "shell", title: "检查", source: "device --check" },
    searchText: "Language: shell\n检查\ndevice --check",
  },
  {
    reviewedModel: { type: "warning", level: "danger", title: "高温", body: "请勿触摸。" },
    searchText: "danger\n高温\n请勿触摸。",
  },
] as const;

for (const [index, example] of typedCases.entries()) {
  const result = recomputeReviewedChunk(
    chunk({ chunkId: `typed-${index}`, contextText: "", contextReviewState: "not_generated" }),
    { at: `2026-08-13T08:00:0${index}.000Z`, reviewedModel: example.reviewedModel },
  );
  assert.equal(result.searchText, example.searchText);
  assert.equal(result.finalText, example.searchText);
  assert.equal(result.contextReviewState, "not_generated");
  assert.ok(!/[<>](?:tr|td|th|table)\b/i.test(result.searchText));
}

const table = recomputeReviewedChunk(chunk(), {
  at: "2026-08-13T08:01:00.000Z",
  reviewedModel: typedCases[2].reviewedModel,
});
assert.match(table.display.html ?? "", /rowspan="2"/);
assert.doesNotMatch(table.searchText, /<tr|<td|<th/i);

assert.throws(
  () => recomputeReviewedChunk(chunk(), {
    at: "2026-08-13T08:02:00.000Z",
    reviewedModel: {
      type: "table",
      columns: ["参数", "值"],
      rows: [[{ cellId: "bad", text: "越界", rowSpan: 1, colSpan: 3 }]],
    },
  }),
  /table.*(?:span|colSpan)/i,
);
assert.throws(
  () => recomputeReviewedChunk(chunk(), {
    at: "2026-08-13T08:03:00.000Z",
    reviewedModel: { type: "unsupported" },
  }),
  /explicit supported type/i,
);
assert.throws(
  () => recomputeReviewedChunk(chunk(), {
    at: "2026-08-13T08:04:00.000Z",
    reviewedModel: { type: "paragraph", text: "" },
  }),
  /non-empty (?:string|text)/i,
);
assert.throws(
  () => recomputeReviewedChunk(chunk(), {
    at: "2026-08-13T08:05:00.000Z",
    reviewedModel: { type: "paragraph", text: "可信正文" },
    displayHtml: "<table><tr><td>client authority</td></tr></table>",
  }),
  /server-derived fields/i,
);

const missingImageAsset = recomputeReviewedChunk(
  chunk({ contextText: "", contextReviewState: "not_generated" }),
  {
    at: "2026-08-13T08:06:00.000Z",
    reviewedModel: { type: "image", imageId: "image-2", caption: "A1 安装方向" },
    imageAssetAvailable: false,
  },
);
assert.equal(missingImageAsset.embeddingEligible, true);
assert.ok(missingImageAsset.qualityFlags.includes("image_asset_unavailable"));

console.log("V2.1 reviewed-model recomputation tests passed");
