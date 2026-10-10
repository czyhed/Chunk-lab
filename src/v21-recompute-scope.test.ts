import assert from "node:assert/strict";
import {
  buildRecomputeAutosave,
  commitRecomputeState,
  createRecomputeHistory,
  planRecompute,
  redoRecomputeState,
  restoreRecomputeAutosave,
  undoRecomputeState,
  reviewCapability,
} from "./v21-recompute-scope.js";

const contentRepair = planRecompute({
  documentId: "doc-a1",
  draftVersion: "draft-v3",
  chunkId: "chunk-installation",
  change: { kind: "content", fingerprint: "reviewed-model-v2" },
  affectedChunkIds: ["chunk-installation"],
  affectedContentGroupIds: ["group-installation"],
});

assert.deepEqual(contentRepair.identity, {
  chunkId: "chunk-installation",
  replacedChunkId: null,
});
assert.equal(contentRepair.scope, "local");
assert.equal(contentRepair.sourceSegmentPolicy, "preserve");
assert.deepEqual(contentRepair.affectedChunkIds, ["chunk-installation"]);
assert.deepEqual(contentRepair.affectedContentGroupIds, ["group-installation"]);

for (const kind of ["type", "source_boundary", "group"] as const) {
  const replacement = planRecompute({
    documentId: "doc-a1",
    draftVersion: "draft-v3",
    chunkId: "chunk-installation",
    change: { kind, fingerprint: `${kind}-v2` },
    affectedChunkIds: ["chunk-installation"],
    affectedContentGroupIds: ["group-installation"],
  });
  assert.equal(replacement.scope, "local");
  assert.equal(replacement.identity.replacedChunkId, "chunk-installation");
  assert.match(replacement.identity.chunkId, /^draft-v3:chunk:[a-f0-9]{16}$/);
  assert.equal(replacement.sourceSegmentPolicy, "preserve_block_only");
  assert.deepEqual(
    replacement,
    planRecompute({
      documentId: "doc-a1",
      draftVersion: "draft-v3",
      chunkId: "chunk-installation",
      change: { kind, fingerprint: `${kind}-v2` },
      affectedChunkIds: ["chunk-installation"],
      affectedContentGroupIds: ["group-installation"],
    }),
    "the same replacement input must produce the same versioned Chunk ID",
  );
}

for (const kind of [
  "reading_order",
  "product_identity",
  "cross_chunk_boundary",
] as const) {
  const escalation = planRecompute({
    documentId: "doc-a1",
    draftVersion: "draft-v3",
    chunkId: "chunk-installation",
    change: { kind, fingerprint: `${kind}-v2` },
    affectedChunkIds: ["chunk-installation", "chunk-specification"],
    affectedContentGroupIds: ["group-installation"],
  });
  assert.deepEqual(escalation, {
    scope: "document_preview",
    identity: { chunkId: null, replacedChunkId: "chunk-installation" },
    sourceSegmentPolicy: "rebuild_from_parsed_document",
    affectedChunkIds: ["chunk-installation", "chunk-specification"],
    affectedContentGroupIds: ["group-installation"],
    invalidation: { draft: true, context: true },
  });
}

type DraftMarker = { text: string; revision: number };
const isDraftMarker = (value: unknown): value is DraftMarker =>
  Boolean(
    value &&
      typeof value === "object" &&
      "text" in value &&
      typeof value.text === "string" &&
      "revision" in value &&
      typeof value.revision === "number",
  );

let history = createRecomputeHistory<DraftMarker>({ text: "原始文本", revision: 0 });
history = commitRecomputeState(history, { text: "第一次修复", revision: 1 });
history = commitRecomputeState(history, { text: "第二次修复", revision: 2 });
assert.deepEqual(history.present, { text: "第二次修复", revision: 2 });
assert.equal(history.sequence, 2);

history = undoRecomputeState(history);
assert.deepEqual(history.present, { text: "第一次修复", revision: 1 });
assert.equal(history.future.length, 1);
history = redoRecomputeState(history);
assert.deepEqual(history.present, { text: "第二次修复", revision: 2 });

const autosave = buildRecomputeAutosave(
  "doc-a1",
  history,
  "2026-08-13T08:00:00.000Z",
);
const recovered = restoreRecomputeAutosave(autosave, "doc-a1", isDraftMarker);
assert.deepEqual(recovered, history);
assert.notEqual(recovered, history, "recovery must return an isolated state copy");
assert.throws(
  () => restoreRecomputeAutosave(autosave, "doc-other", isDraftMarker),
  /document does not match/,
);

for (const action of ["view", "locate", "text_repair"] as const) {
  assert.deepEqual(reviewCapability("mobile", action), {
    allowed: true,
    reason: null,
  });
}
for (const action of [
  "typed_structure_edit",
  "boundary_edit",
  "group_edit",
  "document_recompute",
] as const) {
  assert.deepEqual(reviewCapability("mobile", action), {
    allowed: false,
    reason: "desktop_required",
  });
}
assert.deepEqual(reviewCapability("mobile", "pixel_annotation"), {
  allowed: false,
  reason: "not_supported",
});
assert.deepEqual(reviewCapability("desktop", "typed_structure_edit"), {
  allowed: true,
  reason: null,
});
assert.deepEqual(reviewCapability("desktop", "pixel_annotation"), {
  allowed: false,
  reason: "not_supported",
});

console.log("V2.1 recompute scope tests passed");
