import assert from "node:assert/strict";
import { buildChunkPreview, type ChunkRequest, type ParsedBlock } from "./chunking.js";
import {
  applyManualContext,
  buildContextPackage,
  confirmContext,
  embeddingTextFor,
  generateSelectedContexts,
  invalidateContext,
  markContextCandidates,
} from "./contextual.js";

const blocks: ParsedBlock[] = [
  { id: "title", type: "text", text: "星澜 A1 智能料理机", page: 1, bbox: [0, 0, 100, 20], readingOrder: 0, role: "heading", productIdentity: "星澜 A1" },
  { id: "install", type: "text", text: "安装方法：将本产品杯体顺时针锁定。", page: 1, bbox: [0, 30, 100, 50], readingOrder: 1, role: "paragraph", parentId: "title" },
  { id: "table", type: "table", text: "| 模式 | 时间 |\n| --- | --- |\n| 加热 | 20 分钟 |", page: 2, bbox: [0, 0, 100, 60], readingOrder: 2, role: "table", parentId: "title" },
];
const configuration: ChunkRequest = { strategy: "structure", chunkSize: 128, chunkOverlap: 0, bufferSize: 1, breakpointPercentile: 90, semanticMaxChunkSize: 768, imagePolicy: "summary" };
const preview = await buildChunkPreview(blocks, configuration);
const chunks = markContextCandidates(preview.chunks).map((chunk) => ({
  ...chunk,
  embeddingEligible: true,
  embeddingExclusionReasons: [],
}));
const contextBlocks = blocks.map((block) => ({
  contentBlockId: block.id,
  searchText: block.text,
  contentType: block.role,
  contentGroupId: block.groupId,
  parentContentBlockId: block.parentId ?? null,
}));
const installChunk = chunks.find((chunk) => chunk.finalText.includes("安装方法"))!;
assert.ok(installChunk.contextCandidateReasons.some((reason) => reason.includes("通用标题")));
assert.ok(installChunk.contextCandidateReasons.some((reason) => reason.includes("跨段指代")));

const contextPackage = buildContextPackage(installChunk, chunks, contextBlocks);
assert.equal(contextPackage.productIdentity, "星澜 A1");
assert.ok(contextPackage.sourceText.includes("安装方法"));
assert.ok(contextPackage.scope.length > 0);

const selectedId = installChunk.id;
const failedId = chunks.find((chunk) => chunk.id !== selectedId)!.id;
let calls: string[] = [];
const generated = await generateSelectedContexts(
  chunks,
  [selectedId, failedId],
  contextBlocks,
  async (input) => {
    calls.push(input.chunkId);
    if (input.chunkId === failedId) throw new Error("fake failure");
    return "该内容适用于星澜 A1 智能料理机的安装章节。它说明杯体在使用前必须正确锁定。";
  },
  { model: "fake-context", promptVersion: "context-v1" },
);
assert.deepEqual(calls.sort(), [failedId, selectedId].sort());
assert.equal(generated.find((chunk) => chunk.id === selectedId)!.contextReviewState, "awaiting_review");
assert.equal(generated.find((chunk) => chunk.id === failedId)!.contextReviewState, "failed");
assert.equal(generated.filter((chunk) => ![selectedId, failedId].includes(chunk.id)).every((chunk) => chunk.contextReviewState === "not_generated"), true, "unselected chunks must not call or change context state");

const confirmed = confirmContext(generated, selectedId);
const confirmedChunk = confirmed.find((chunk) => chunk.id === selectedId)!;
assert.equal(confirmedChunk.contextReviewState, "confirmed");
assert.equal(confirmedChunk.finalText, installChunk.finalText, "Context must never rewrite finalText");
assert.equal(embeddingTextFor(confirmedChunk), `${confirmedChunk.contextText}\n\n${confirmedChunk.finalText}`);

const manual = applyManualContext(confirmed, selectedId, "人工补充：该步骤适用于星澜 A1。请在通电前锁定杯体。");
const manualChunk = manual.find((chunk) => chunk.id === selectedId)!;
assert.equal(manualChunk.contextReviewState, "human_modified");
await assert.rejects(
  () => generateSelectedContexts(manual, [selectedId], contextBlocks, async () => "不应覆盖。仍然不应覆盖。", { model: "fake-context", promptVersion: "context-v1" }),
  /人工修改/,
);
const staleChunk = { ...manualChunk, contextReviewState: "stale" as const };
assert.equal(embeddingTextFor(staleChunk), staleChunk.finalText, "stale Context must not enter embeddingText");

for (const state of [
  "not_generated",
  "generating",
  "awaiting_review",
  "failed",
  "stale",
] as const) {
  assert.equal(
    embeddingTextFor({ ...manualChunk, contextReviewState: state }),
    manualChunk.finalText,
    `${state} Context must not enter embeddingText`,
  );
}
assert.equal(
  invalidateContext({ ...installChunk, contextReviewState: "not_generated" })
    .contextReviewState,
  "not_generated",
  "editing a never-generated Chunk must not invent stale Context",
);
assert.equal(
  invalidateContext(confirmedChunk).contextReviewState,
  "stale",
  "confirmed Context must become stale after an input change",
);

calls = [];
const duplicatedSelection = await generateSelectedContexts(
  chunks,
  [selectedId, selectedId],
  contextBlocks,
  async (input) => {
    calls.push(input.chunkId);
    return "该内容属于星澜 A1 的安装说明。它要求用户在使用前锁定杯体。";
  },
  { model: "fake-context", promptVersion: "context-v1" },
);
assert.deepEqual(calls, [selectedId], "duplicate IDs must make one model call");
assert.equal(
  duplicatedSelection.find((chunk) => chunk.id === selectedId)!
    .contextReviewState,
  "awaiting_review",
);

calls = [];
await assert.rejects(
  () =>
    generateSelectedContexts(
      chunks,
      ["missing-chunk"],
      contextBlocks,
      async (input) => {
        calls.push(input.chunkId);
        return "不应调用。也不应调用。";
      },
      { model: "fake-context", promptVersion: "context-v1" },
    ),
  /不存在/,
);
assert.deepEqual(calls, [], "unknown IDs must fail before any model call");

const failedOverwrite = await generateSelectedContexts(
  manual,
  [selectedId],
  contextBlocks,
  async () => {
    throw new Error("fake overwrite failure");
  },
  {
    model: "fake-context",
    promptVersion: "context-v1",
    allowHumanContextOverwrite: true,
  },
);
const failedOverwriteChunk = failedOverwrite.find(
  (chunk) => chunk.id === selectedId,
)!;
assert.equal(failedOverwriteChunk.contextReviewState, "failed");
assert.equal(
  failedOverwriteChunk.contextText,
  manualChunk.contextText,
  "a failed regeneration must preserve human Context text",
);

const invalidOutput = await generateSelectedContexts(
  chunks,
  [selectedId],
  contextBlocks,
  async () => "只有一句。",
  { model: "fake-context", promptVersion: "context-v1" },
);
assert.equal(
  invalidOutput.find((chunk) => chunk.id === selectedId)!.contextReviewState,
  "failed",
  "invalid model output must be visible as a per-item failure",
);

const longBlocks: ParsedBlock[] = [
  ...blocks,
  {
    id: "remote-sentinel",
    type: "text",
    text: `REMOTE-SENTINEL ${"远端内容".repeat(4_000)}`,
    page: 99,
    bbox: null,
    readingOrder: 99,
    role: "paragraph",
  },
];
const longPackage = buildContextPackage(
  installChunk,
  chunks,
  longBlocks.map((block) => ({
    contentBlockId: block.id,
    searchText: block.text,
    contentType: block.role,
    contentGroupId: block.groupId,
    parentContentBlockId: block.parentId ?? null,
  })),
);
assert.equal(longPackage.scope.includes("完整 Parsed Document"), false);
assert.equal(
  longPackage.referenceText.includes("REMOTE-SENTINEL"),
  false,
  "long-document packages must not include unrelated remote content",
);

console.log("Contextual Retrieval tests passed");
