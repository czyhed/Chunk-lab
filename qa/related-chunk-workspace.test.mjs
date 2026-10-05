import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mergeContextGenerationResult } from "../context-generation-state.js";
import { relatedChunkCandidates } from "../related-chunk-candidates.js";

function textChunk(index) {
  return {
    id: `text-${String(index).padStart(2, "0")}`,
    type: "text",
    finalText: `正文 ${index}`,
    excluded: false,
    embeddingEligible: true,
    embeddingExclusionReasons: [],
  };
}

const chunks = Array.from({ length: 20 }, (_, index) => textChunk(index));
chunks.splice(10, 0, {
  id: "image-target",
  type: "image",
  finalText: "图片摘要",
  excluded: false,
  embeddingEligible: true,
  embeddingExclusionReasons: [],
});

const nearby = relatedChunkCandidates(chunks, "image-target", { requireEmbeddingEligibility: true });
assert.equal(nearby.length, 10, "default related-Chunk list is capped at 10");
assert.deepEqual(nearby.map((chunk) => chunk.id), ["text-05", "text-06", "text-07", "text-08", "text-09", "text-10", "text-11", "text-12", "text-13", "text-14"]);
for (const id of ["text-07", "text-08", "text-09", "text-10", "text-11", "text-12"]) {
  assert.equal(nearby.some((chunk) => chunk.id === id), true, `default candidates include nearby ${id}`);
}
const sixWindow = relatedChunkCandidates(chunks, "image-target", {
  requireEmbeddingEligibility: true,
  limit: 6,
  before: 3,
  after: 3,
  adjacentOnly: true,
});
assert.deepEqual(
  sixWindow.map((chunk) => chunk.id),
  ["text-07", "text-08", "text-09", "text-10", "text-11", "text-12"],
  "image/table candidate window contains exactly the nearest three text Chunks above and below",
);
const filteredChunks = structuredClone(chunks);
filteredChunks.find((chunk) => chunk.id === "text-09").excluded = true;
filteredChunks.find((chunk) => chunk.id === "text-10").embeddingEligible = false;
filteredChunks.find((chunk) => chunk.id === "text-10").embeddingExclusionReasons = ["not_searchable"];
const filteredWindow = relatedChunkCandidates(filteredChunks, "image-target", {
  requireEmbeddingEligibility: true,
  limit: 6,
  before: 3,
  after: 3,
  adjacentOnly: true,
});
assert.equal(filteredWindow.length, 6);
assert.equal(filteredWindow.some((chunk) => chunk.id === "text-09"), false);
assert.equal(filteredWindow.some((chunk) => chunk.id === "text-10"), false);
const retainedSelected = relatedChunkCandidates(chunks, "image-target", {
  selectedIds: ["text-18"],
  requireEmbeddingEligibility: true,
  limit: 6,
  before: 3,
  after: 3,
  adjacentOnly: true,
});
assert.equal(retainedSelected.length, 6);
assert.equal(retainedSelected.some((chunk) => chunk.id === "text-18"), true, "an already selected candidate stays visible without exceeding the cap");
assert.deepEqual(
  [...nearby].sort((left, right) => chunks.indexOf(left) - chunks.indexOf(right)),
  nearby,
  "default candidates remain in document order",
);

assert.deepEqual(
  relatedChunkCandidates(chunks, "image-target", { query: "text-18", requireEmbeddingEligibility: true }).map((chunk) => chunk.id),
  ["text-18"],
  "Chunk ID search uses the complete candidate set, not only the default ten",
);
assert.deepEqual(
  relatedChunkCandidates(chunks, "image-target", { query: "正文 18", requireEmbeddingEligibility: true }).map((chunk) => chunk.id),
  ["text-18"],
  "body search uses the complete candidate set",
);

const localReviewState = {
  draft: {
    chunks: [
      { id: "image-target", contextText: "", contextEditorDraft: "请求期间输入的人工 Context", imageEditorDraft: { humanSummary: "请求期间继续编辑" } },
      { id: "text-01", finalText: "请求期间已保存的新正文", tableRetrievalDraft: { finalSummary: "本地草稿" } },
    ],
  },
};
const serverReviewState = {
  draft: {
    chunks: [
      { id: "image-target", contextText: "模型生成的 Context" },
      { id: "text-01", finalText: "请求开始时的旧正文" },
    ],
  },
};
const merged = mergeContextGenerationResult(serverReviewState, localReviewState, ["image-target"]);
assert.equal(merged.draft.chunks[0].contextText, "模型生成的 Context");
assert.equal(merged.draft.chunks[0].contextEditorDraft, "请求期间输入的人工 Context");
assert.equal(merged.draft.chunks[0].imageEditorDraft.humanSummary, "请求期间继续编辑");
assert.equal(merged.draft.chunks[1].finalText, "请求期间已保存的新正文");
assert.equal(merged.draft.chunks[1].tableRetrievalDraft.finalSummary, "本地草稿");

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../related-chunk-workspace.css", import.meta.url), "utf8");
const server = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
assert.doesNotMatch(app, /chunkWorkspace"\)\.setAttribute\("aria-busy", String\(busy\)\)/, "Context generation does not mark the whole workspace busy");
assert.match(styles, /image-related-list small[^}]+font-size:11px/, "related-Chunk excerpts use readable text");
assert.match(app, /tableRelatedSearch/, "table related-Chunk editor supports ID and body search");
assert.match(app, /function tableRetrievalCandidates\(chunk,query="",selectedIds=\[\],limit=6\)/);
assert.match(app, /tableRetrievalCandidates[^\n]+requireEmbeddingEligibility:true[^\n]+limit,before:3,after:3/);
assert.ok(
  app.includes("file.reviewState?.draft?.chunks??file.reviewState?.preview?.chunks??file.automaticPreview?.chunks"),
  "partial manual generation uses the confirmed Draft before a stale Preview",
);
assert.match(server, /related-chunk-workspace\.css/, "the related-Chunk stylesheet is publicly served");
assert.match(server, /app\.get\("\/related-chunk-candidates\.js"/, "the candidate module is publicly served");
assert.match(server, /app\.get\("\/context-generation-state\.js"/, "the Context merge module is publicly served");
assert.ok(
  server.includes("document.reviewState.draft?.chunks ?? document.reviewState.preview?.chunks ?? []"),
  "server-side manual generation uses the confirmed Draft before a stale Preview",
);

console.log("Related Chunk workspace regression tests passed");
