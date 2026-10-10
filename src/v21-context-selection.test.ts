import assert from "node:assert/strict";
import type { Chunk } from "./chunking.js";
import {
  buildContextPackage,
  generateSelectedContexts,
} from "./contextual.js";

type V21Chunk = Chunk & {
  embeddingEligible: boolean;
  embeddingExclusionReasons: string[];
};

const baseChunk = {
  type: "text",
  text: "安全正文",
  automaticText: "安全正文",
  finalText: "安全正文",
  page: null,
  bbox: null,
  sourceSegments: [],
  sourceBlockIds: ["block-1"],
  tokenCount: 4,
  qualityFlags: [],
  relatedChunkIds: [],
  excluded: false,
  contextText: "",
  contextCandidateReasons: [],
  contextReviewState: "not_generated",
  revisions: [],
} satisfies Omit<Chunk, "id">;

const eligible: V21Chunk = {
  ...structuredClone(baseChunk),
  id: "eligible",
  embeddingEligible: true,
  embeddingExclusionReasons: [],
};
const ineligible: V21Chunk = {
  ...structuredClone(baseChunk),
  id: "ineligible",
  finalText: "待人工修复",
  embeddingEligible: false,
  embeddingExclusionReasons: ["normalization_failed"],
};
const unselected: V21Chunk = {
  ...structuredClone(baseChunk),
  id: "unselected",
  embeddingEligible: true,
  embeddingExclusionReasons: [],
};

const safeBlocks = [
  {
    contentBlockId: "block-1",
    searchText: "型号 A1 的安全规范文本。",
    contentGroupId: "group-1",
    parentContentBlockId: null,
    raw: {
      rawTableHtml: "<table><tr><td>RAW_HTML_SENTINEL</td></tr></table>",
      source: "RAW_SOURCE_SENTINEL",
    },
    display: { html: "<strong>DISPLAY_HTML_SENTINEL</strong>" },
    diagnostics: { requestUrl: "DIAGNOSTIC_URL_SENTINEL" },
  },
];

const contextPackage = buildContextPackage(
  eligible,
  [eligible, ineligible, unselected],
  safeBlocks,
);
const modelVisiblePackage = JSON.stringify(contextPackage);
assert.match(modelVisiblePackage, /型号 A1 的安全规范文本/);
for (const forbidden of [
  "RAW_HTML_SENTINEL",
  "RAW_SOURCE_SENTINEL",
  "DISPLAY_HTML_SENTINEL",
  "DIAGNOSTIC_URL_SENTINEL",
]) {
  assert.equal(
    modelVisiblePackage.includes(forbidden),
    false,
    `${forbidden} must not enter the Context package`,
  );
}

let calls: string[] = [];
const generated = await generateSelectedContexts(
  [eligible, ineligible, unselected],
  [eligible.id],
  safeBlocks,
  async ({ chunkId }) => {
    calls.push(chunkId);
    return "该内容属于型号 A1 的操作说明。它补充了当前步骤所依赖的商品背景。";
  },
  { model: "fake-context", promptVersion: "context-v21" },
);
assert.deepEqual(calls, [eligible.id]);
assert.equal(
  generated.find((chunk) => chunk.id === eligible.id)?.contextReviewState,
  "awaiting_review",
);
assert.equal(
  generated.find((chunk) => chunk.id === unselected.id)?.contextReviewState,
  "not_generated",
);

calls = [];
await assert.rejects(
  () =>
    generateSelectedContexts(
      [eligible, ineligible, unselected],
      [ineligible.id],
      safeBlocks,
      async ({ chunkId }) => {
        calls.push(chunkId);
        return "不应调用模型。此文本不应生成。";
      },
      { model: "fake-context", promptVersion: "context-v21" },
    ),
  /normalization_failed|不允许生成 Context/,
);
assert.deepEqual(calls, [], "ineligible targets must fail before a model call");

console.log("V2.1 Context selection tests passed");
