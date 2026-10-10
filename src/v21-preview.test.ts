import assert from "node:assert/strict";
import { normalizeContentBlock } from "./v21-normalization.js";
import { buildProvenancedContentBlock } from "./v21-provenance.js";
import { buildV21Preview } from "./v21-preview.js";
import { buildLocalParsedDocument } from "./v21-parsed-document.js";

const blocks = Array.from({ length: 10 }, (_, index) =>
  buildProvenancedContentBlock(
    normalizeContentBlock({
      type: "paragraph",
      text: `A1 使用步骤 ${index + 1}：安装杯体并确认锁紧状态。`,
      parser: "mineru",
      parserVersion: "mineru-test",
      parsedDocumentVersion: "parsed-v1",
      rawBlockId: `raw-${index + 1}`,
    }),
    { sourceDocumentVersion: "source-v1", blockIndex: index },
  ),
);

const baseRequest = {
  strategy: "structure" as const,
  chunkSize: 64,
  chunkOverlap: 8,
  bufferSize: 1,
  breakpointPercentile: 90,
  semanticMaxChunkSize: 96,
  imagePolicy: "summary" as const,
};
const preview = await buildV21Preview(
  {
    contractVersion: "2.1",
    sourceDocumentVersion: "source-v1",
    parsedDocumentVersion: "parsed-v1",
    normalizedContentVersion: "normalized-v1",
    normalizerVersion: "v21-normalizer-1",
    normalizedModelVersion: "v21-content-1",
    blocks,
  },
  baseRequest,
);

assert.equal(preview.contractVersion, "2.1");
assert.equal(preview.strategyName, "Structure-Aware");
assert.equal(preview.tokenizer.name, "cl100k_base");
assert.equal(preview.parsedDocumentVersion, "parsed-v1");
assert.equal(preview.normalizedContentVersion, "normalized-v1");
assert.match(preview.previewVersion, /^preview-/);
assert.ok(preview.chunks.length > 0);
for (const chunk of preview.chunks) {
  assert.equal(chunk.automaticText, chunk.finalText);
  assert.equal(chunk.embeddingText, null);
  assert.equal(chunk.embeddingEligible, true);
  assert.ok(chunk.contentTypes.length > 0);
  assert.ok(chunk.normalizedModels.every((model) => model !== null));
  assert.ok(chunk.sourceSegments.length > 0);
  for (const segment of chunk.sourceSegments) {
    assert.equal(segment.sourceDocumentVersion, "source-v1");
    assert.equal(segment.parsedDocumentVersion, "parsed-v1");
    assert.match(segment.contentBlockId, /^parsed-v1:content-block:/);
    assert.equal(segment.sourceViewKind, "parsed_document");
    assert.equal(segment.locationQuality, "parsed_only");
  }
}
assert.equal(JSON.stringify(preview).includes("rawTableHtml"), false);

const exactBlock = structuredClone(blocks[0]) as typeof blocks[0] & {
  sourceLocation: {
    sourceViewKind: "original_file";
    page: number;
    bbox: readonly [number, number, number, number];
    locationQuality: "exact";
    bboxEvidence: {
      page: number;
      pageWidth: number;
      pageHeight: number;
      coordinateUnit: string;
      orientation: number;
      transform: readonly [number, number, number, number, number, number];
      mappingVersion: string;
      sourceDocumentVersion: string;
    };
  };
};
exactBlock.sourceLocation = {
  sourceViewKind: "original_file",
  page: 1,
  bbox: [72, 60, 540, 92],
  locationQuality: "exact",
  bboxEvidence: {
    page: 1,
    pageWidth: 595,
    pageHeight: 842,
    coordinateUnit: "pdf_point",
    orientation: 0,
    transform: [1, 0, 0, 1, 0, 0],
    mappingVersion: "qa-pdf-points-v1",
    sourceDocumentVersion: "source-v1",
  },
};
const exactPreview = await buildV21Preview({
  contractVersion: "2.1",
  sourceDocumentVersion: "source-v1",
  parsedDocumentVersion: "parsed-v1",
  normalizedContentVersion: "normalized-v1",
  normalizerVersion: "v21-normalizer-1",
  normalizedModelVersion: "v21-content-1",
  blocks: [exactBlock],
}, baseRequest);
assert.equal(exactPreview.chunks[0].sourceSegments[0].locationQuality, "exact");
assert.deepEqual(exactPreview.chunks[0].sourceSegments[0].bbox, [72, 60, 540, 92]);

const markdownDocument = buildLocalParsedDocument("# A1\n\n说明 🔥", {
  kind: "markdown",
  sourceDocumentVersion: "source-md",
  parserVersion: "commonmark-0.31.2",
});
const markdownPreview = await buildV21Preview(markdownDocument, baseRequest);
const markdownSegment = markdownPreview.chunks.at(-1)!.sourceSegments[0];
assert.equal(markdownSegment.sourceViewKind, "markdown_source");
assert.equal(markdownSegment.locationQuality, "exact");
assert.equal(markdownSegment.page, null);
assert.equal(markdownSegment.bbox, null);
assert.equal(markdownSegment.sourceStart, 0);

const small = await buildV21Preview(
  {
    contractVersion: "2.1",
    sourceDocumentVersion: "source-v1",
    parsedDocumentVersion: "parsed-v1",
    normalizedContentVersion: "normalized-v1",
    normalizerVersion: "v21-normalizer-1",
    normalizedModelVersion: "v21-content-1",
    blocks,
  },
  { ...baseRequest, strategy: "token", chunkSize: 32, chunkOverlap: 8 },
);
const large = await buildV21Preview(
  {
    contractVersion: "2.1",
    sourceDocumentVersion: "source-v1",
    parsedDocumentVersion: "parsed-v1",
    normalizedContentVersion: "normalized-v1",
    normalizerVersion: "v21-normalizer-1",
    normalizedModelVersion: "v21-content-1",
    blocks,
  },
  { ...baseRequest, strategy: "token", chunkSize: 96, chunkOverlap: 0 },
);
assert.equal(small.strategyName, "TokenTextSplitter");
assert.ok(small.chunks.length > large.chunks.length, "chunkSize changes structure");
assert.ok(
  small.chunks.slice(1).some((chunk) => chunk.sourceSegments.some((segment) => segment.isOverlap)),
  "token overlap remains source-traceable",
);

for (const [strategy, name] of [
  ["structure", "Structure-Aware"],
  ["sentence", "SentenceSplitter"],
] as const) {
  const result = await buildV21Preview(
    {
      contractVersion: "2.1",
      sourceDocumentVersion: "source-v1",
      parsedDocumentVersion: "parsed-v1",
      normalizedContentVersion: "normalized-v1",
      normalizerVersion: "v21-normalizer-1",
      normalizedModelVersion: "v21-content-1",
      blocks,
    },
    { ...baseRequest, strategy },
  );
  assert.equal(result.strategyName, name);
}

await assert.rejects(
  buildV21Preview(
    {
      contractVersion: "2.1",
      sourceDocumentVersion: "source-v1",
      parsedDocumentVersion: "parsed-v1",
      normalizedContentVersion: "normalized-v1",
      normalizerVersion: "v21-normalizer-1",
      normalizedModelVersion: "v21-content-1",
      blocks,
    },
    { ...baseRequest, strategy: "semantic" },
  ),
  /Semantic Boundary requires an embedding model/,
);
await assert.rejects(
  buildV21Preview(
    {
      contractVersion: "2.1",
      sourceDocumentVersion: "source-v1",
      parsedDocumentVersion: "parsed-v1",
      normalizedContentVersion: "normalized-v1",
      normalizerVersion: "v21-normalizer-1",
      normalizedModelVersion: "v21-content-1",
      blocks,
    },
    { ...baseRequest, strategy: "semantic" },
    async () => {
      throw new Error("fake embedding unavailable");
    },
  ),
  /fake embedding unavailable/,
);

const protectedBlocks = [
  normalizeContentBlock({
    type: "paragraph",
    text: "普通说明。",
    parser: "mineru",
    parserVersion: "mineru-test",
    parsedDocumentVersion: "parsed-protected",
    rawBlockId: "raw-p",
  }),
  normalizeContentBlock({
    type: "formula",
    latex: "P = U \\times I",
    context: "功率公式",
    parser: "mineru",
    parserVersion: "mineru-test",
    parsedDocumentVersion: "parsed-protected",
    rawBlockId: "raw-f",
  }),
  normalizeContentBlock({
    type: "code",
    language: "typescript",
    source: "const watts = 1200;",
    parser: "mineru",
    parserVersion: "mineru-test",
    parsedDocumentVersion: "parsed-protected",
    rawBlockId: "raw-c",
  }),
  normalizeContentBlock({
    type: "warning",
    warningLevel: "danger",
    title: "高温",
    body: "请勿触摸。",
    parser: "mineru",
    parserVersion: "mineru-test",
    parsedDocumentVersion: "parsed-protected",
    rawBlockId: "raw-w",
  }),
].map((block, index) =>
  buildProvenancedContentBlock(block, {
    sourceDocumentVersion: "source-protected",
    blockIndex: index,
  }),
);
const protectedPreview = await buildV21Preview(
  {
    contractVersion: "2.1",
    sourceDocumentVersion: "source-protected",
    parsedDocumentVersion: "parsed-protected",
    normalizedContentVersion: "normalized-protected",
    normalizerVersion: "v21-normalizer-1",
    normalizedModelVersion: "v21-content-1",
    blocks: protectedBlocks,
  },
  { ...baseRequest, strategy: "token", chunkSize: 32, chunkOverlap: 8 },
);
for (const type of ["formula", "code", "warning"] as const) {
  const sourceId = protectedBlocks.find((block) => block.contentType === type)!.contentBlockId;
  const owners = protectedPreview.chunks.filter((chunk) =>
    chunk.sourceSegments.some((segment) => segment.contentBlockId === sourceId),
  );
  assert.equal(owners.length, 1, `${type} stays in one protected Chunk`);
  assert.deepEqual(owners[0].contentTypes, [type]);
  assert.equal(owners[0].sourceSegments.some((segment) => segment.isOverlap), false);
}

console.log("V2.1 Preview contract tests passed");
