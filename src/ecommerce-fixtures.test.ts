import assert from "node:assert/strict";
import { buildChunkPreview, type ChunkRequest } from "./chunking.js";
import { ecommerceFixtures } from "./ecommerce-fixtures.js";

const structureAwareDefaults: ChunkRequest = {
  strategy: "structure",
  chunkSize: 512,
  chunkOverlap: 64,
  bufferSize: 1,
  breakpointPercentile: 90,
  semanticMaxChunkSize: 768,
  imagePolicy: "summary",
};

const expectedClasses = [
  "single-product-manual",
  "multi-model-manual",
  "illustrated-installation",
  "large-parameter-table",
  "cross-page-table",
  "two-column-manual",
  "scanned-manual",
  "mixed-safety-page",
];
assert.deepEqual(
  ecommerceFixtures.map((fixture) => fixture.sampleClass),
  expectedClasses,
);
for (const fixture of ecommerceFixtures) {
  assert.ok(fixture.blocks.length >= 2, `${fixture.sampleClass} needs source blocks`);
  assert.equal(
    new Set(fixture.blocks.map((block) => block.id)).size,
    fixture.blocks.length,
  );
  assert.deepEqual(
    fixture.expectedReadingOrder,
    [...fixture.blocks]
      .sort((left, right) => (left.readingOrder ?? 0) - (right.readingOrder ?? 0))
      .map((block) => block.id),
  );
  assert.ok(fixture.expectedChunkBoundaries.length > 0);
  for (const boundary of fixture.expectedChunkBoundaries)
    assert.equal(
      boundary.every((blockId) => fixture.blocks.some((block) => block.id === blockId)),
      true,
    );
  const preview = await buildChunkPreview(fixture.blocks, structureAwareDefaults);
  assert.deepEqual(
    preview.chunks.map((chunk) => [
      ...new Set(chunk.sourceSegments.map((segment) => segment.blockId)),
    ]),
    fixture.expectedChunkBoundaries,
    `${fixture.sampleClass} must preserve its annotated Structure-Aware boundaries`,
  );
}
assert.equal(
  ecommerceFixtures.find((fixture) => fixture.sampleClass === "cross-page-table")!
    .blocks.every((block) => block.groupId === "spec-table"),
  true,
);
assert.deepEqual(
  ecommerceFixtures
    .find((fixture) => fixture.sampleClass === "two-column-manual")!
    .expectedReadingOrder,
  ["left-1", "left-2", "right-1", "right-2"],
);
assert.equal(
  ecommerceFixtures
    .find((fixture) => fixture.sampleClass === "scanned-manual")!
    .blocks.some((block) => block.sourceBackend === "mineru-ocr"),
  true,
);
const largeTableFixture = ecommerceFixtures.find(
  (fixture) => fixture.sampleClass === "large-parameter-table",
)!;
const largeTablePreview = await buildChunkPreview(
  largeTableFixture.blocks,
  structureAwareDefaults,
);
const largeTableChunks = largeTablePreview.chunks.filter(
  (chunk) => chunk.tableId === "large-table",
);
assert.ok(largeTableChunks.length > 1, "large table must split into row groups");
assert.ok(
  largeTableChunks.every((chunk) =>
    chunk.finalText.startsWith("| 型号 | 功率 | 容量 |\n| --- | --- | --- |"),
  ),
  "each large-table row group must repeat the header",
);
assert.ok(
  largeTableChunks.every((chunk) => !chunk.qualityFlags.includes("oversized")),
  "safe row grouping must honor the token budget",
);

console.log("Ecommerce fixture contract tests passed");
