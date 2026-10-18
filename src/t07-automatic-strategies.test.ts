import assert from "node:assert/strict";
import {
  buildChunkPreview,
  type ChunkRequest,
  type ParsedBlock,
} from "./chunking.js";
import { createDeterministicEmbeddingClient } from "./embedding.js";
import {
  adoptPreview,
  completePreviewGeneration,
  configurationFingerprint,
  createPreviewGateState,
  startPreviewGeneration,
  updateConfigurationDraft,
} from "./v21-preview-gate.js";
import { GenerationGate } from "./generation-gate.js";

const blocks: ParsedBlock[] = Array.from({ length: 6 }, (_, index) => ({
  id: `t07-block-${index}`,
  type: "text",
  role: index === 0 ? "heading" : "paragraph",
  text: index === 0
    ? "安装说明"
    : `第 ${index} 步：安装前请切断电源并确认额定电压。完成后检查锁定标记。`,
  page: index < 3 ? 1 : 2,
  bbox: [10, 20 + index * 20, 300, 34 + index * 20],
  readingOrder: index,
}));

const base: ChunkRequest = {
  strategy: "structure",
  chunkSize: 128,
  chunkOverlap: 16,
  bufferSize: 1,
  breakpointPercentile: 90,
  semanticMaxChunkSize: 128,
  imagePolicy: "summary",
};

const deterministic = createDeterministicEmbeddingClient(8);
assert.deepEqual(
  await deterministic(["same input", "same input"]),
  await deterministic(["same input", "same input"]),
  "Semantic fake vectors are deterministic",
);

for (const strategy of ["structure", "sentence", "token"] as const) {
  const preview = await buildChunkPreview(blocks, { ...base, strategy });
  assert.ok(preview.chunks.length > 0, `${strategy} produces chunks`);
  assert.equal(
    Object.values(preview.metrics.tokenDistribution).reduce((sum, count) => sum + count, 0),
    preview.chunks.length,
    `${strategy} token distribution covers every chunk`,
  );
}

const semantic = await buildChunkPreview(blocks, {
  ...base,
  strategy: "semantic",
  semanticMaxChunkSize: 64,
}, deterministic);
assert.ok(semantic.chunks.length > 0, "semantic produces chunks with fake embeddings");
await assert.rejects(
  () => buildChunkPreview(blocks, { ...base, strategy: "semantic" }, async () => {
    throw new Error("semantic fake failed");
  }),
  /semantic fake failed/,
);

const gate = new GenerationGate();
let state = createPreviewGateState(base);
const first = startPreviewGeneration(state, gate.begin("t07", "preview"));
state = first.state;
const firstPreview = await buildChunkPreview(blocks, first.request.configuration);
const completed = completePreviewGeneration(state, first.request, firstPreview);
if (!completed.ok) throw new Error(completed.message);
state = completed.state;
const changed = { ...base, chunkSize: 64 };
state = updateConfigurationDraft(state, changed);
assert.equal(state.preview?.expired, true, "parameter changes expire the old Preview");
assert.notEqual(
  configurationFingerprint(changed),
  state.preview?.configurationFingerprint,
  "parameter changes produce a new configuration fingerprint",
);
const adoption = adoptPreview(state);
assert.equal(adoption.ok, false);
if (adoption.ok) throw new Error("expired Preview was adopted");
assert.equal(adoption.code, "PREVIEW_EXPIRED");

const semanticTarget = await buildChunkPreview(blocks, {
  ...base,
  strategy: "semantic",
  semanticMaxChunkSize: 32,
}, deterministic);
assert.ok(
  semanticTarget.chunks.every((chunk) => chunk.tokenCount <= 32),
  "Semantic target Token budget is enforced",
);

console.log("T07 automatic strategy and Preview tests passed");
