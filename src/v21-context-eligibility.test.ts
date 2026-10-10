import assert from "node:assert/strict";
import type { Chunk } from "./chunking.js";
import { buildContextPackage, embeddingTextFor } from "./contextual.js";

type V21Chunk = Chunk & {
  embeddingEligible: boolean;
  embeddingExclusionReasons: string[];
};

function chunk(
  id: string,
  finalText: string,
  embeddingEligible = true,
): V21Chunk {
  return {
    id,
    type: "text",
    text: finalText,
    automaticText: finalText,
    finalText,
    page: null,
    bbox: null,
    sourceSegments: [],
    sourceBlockIds: [id],
    tokenCount: 8,
    qualityFlags: [],
    relatedChunkIds: [],
    excluded: false,
    contextText: "已审核背景。",
    contextCandidateReasons: [],
    contextReviewState: "confirmed",
    revisions: [],
    embeddingEligible,
    embeddingExclusionReasons: embeddingEligible
      ? []
      : ["normalization_failed"],
  };
}

const left = chunk("left", "INELIGIBLE_NEIGHBOR_SENTINEL", false);
const target = chunk("target", "当前安全正文");
const right = chunk("right", "右侧安全邻居");
const referenceImage = {
  ...chunk("reference-image", ""),
  type: "image" as const,
  relatedChunkIds: ["target"],
  embeddingEligible: false,
  embeddingExclusionReasons: ["image_reference_uses_related_text"],
  imagePolicy: "reference" as const,
};
const blocks = [left, target, right].map((item) => ({
  contentBlockId: item.id,
  searchText: item.finalText,
  contentType: "paragraph",
}));
const contextPackage = buildContextPackage(target, [left, target, right], blocks);
assert.equal(
  contextPackage.referenceText.includes("INELIGIBLE_NEIGHBOR_SENTINEL"),
  false,
  "ineligible neighbors must not enter model input",
);
assert.deepEqual(contextPackage.skippedNeighborReasons, [
  { chunkId: "left", reasons: ["normalization_failed"] },
]);
assert.ok(contextPackage.scope.some((item) => item.includes("right")));
assert.equal(contextPackage.scope.some((item) => item.includes("left")), false);

for (const state of [
  "not_generated",
  "generating",
  "awaiting_review",
  "failed",
  "stale",
] as const) {
  assert.equal(
    embeddingTextFor({ ...target, contextReviewState: state }),
    target.finalText,
  );
}
assert.equal(
  embeddingTextFor({ ...target, contextReviewState: "confirmed" }),
  `${target.contextText}\n\n${target.finalText}`,
);
assert.equal(
  embeddingTextFor({ ...target, contextReviewState: "human_modified" }),
  `${target.contextText}\n\n${target.finalText}`,
);
assert.equal(embeddingTextFor(referenceImage), null, "reference-only image never gets an embedding text");
for (const state of [
  "not_generated",
  "generating",
  "awaiting_review",
  "confirmed",
  "human_modified",
  "failed",
  "stale",
] as const) {
  assert.equal(
    embeddingTextFor({ ...left, contextReviewState: state }),
    null,
    `ineligible ${state} Context must have null embeddingText`,
  );
}
assert.equal(
  embeddingTextFor({ ...target, embeddingEligible: undefined } as unknown as Chunk),
  null,
  "missing eligibility must fail closed",
);

console.log("V2.1 Context eligibility tests passed");
