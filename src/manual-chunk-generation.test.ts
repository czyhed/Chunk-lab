import assert from "node:assert/strict";
import { buildMineruParsedDocument, type SourcePageMapping } from "./v21-parsed-document.js";
import { generateManualChunks, preparePreviousChunksForManualGeneration } from "./manual-chunk-generation.js";

const sourceMapping: SourcePageMapping = {
  mappingVersion: "t06-fixed-mapping-v1",
  sourceDocumentVersion: "source-t06-v1",
  pages: [{
    page: 1,
    pageWidth: 600,
    pageHeight: 800,
    bboxPageWidth: 1000,
    bboxPageHeight: 1000,
    coordinateUnit: "mineru_normalized_1000",
    coordinateOrigin: "top-left",
    orientation: 0,
    transform: [0.6, 0, 0, 0.8, 0, 0],
    mediaBox: [0, 0, 600, 800],
    cropBox: [0, 0, 600, 800],
  }],
};
const parsedDocument = buildMineruParsedDocument([
  { id: "raw-title", type: "title", text: "独立标题", page_idx: 0, bbox: [100, 80, 900, 140] },
  { id: "raw-body", type: "text", text: "不应进入标题 Chunk 的正文", page_idx: 0, bbox: [100, 180, 900, 360] },
  { id: "raw-table", type: "table", table_body: "<table><tr><th>列</th></tr><tr><td>值</td></tr></table>", page_idx: 0, bbox: [100, 420, 900, 700] },
], {
  sourceDocumentVersion: "source-t06-v1",
  parserVersion: "mineru-t06-fixture",
  sourceMapping,
});
const [title, body, table] = parsedDocument.blocks;

const first = generateManualChunks({
  document: parsedDocument,
  sourceMapping,
  scope: { kind: "page", page: 1, selectedAnnotationIds: [title.contentBlockId] },
  effectiveAnnotations: [title, body, table].map((block, readingOrder) => ({
    id: block.contentBlockId,
    sourceBlockIds: [block.contentBlockId],
    page: 1,
    bbox: [
      block.sourceLocation.bbox![0] / 1000,
      block.sourceLocation.bbox![1] / 1000,
      block.sourceLocation.bbox![2] / 1000,
      block.sourceLocation.bbox![3] / 1000,
    ],
    type: readingOrder === 0 ? "heading" : readingOrder === 2 ? "table" : "text",
    readingOrder,
    layer: "detection",
  })),
  suppressedSourceBlockIds: [],
  previousChunks: [],
  imagePolicy: "reference",
});

assert.equal(first.chunks.length, 1, "selected current-page generation creates one logical Chunk");
assert.equal(first.chunks[0]?.finalText, "独立标题", "the title selection never absorbs body or table content");
assert.deepEqual(first.chunks[0]?.sourceBlockIds, [title.contentBlockId], "the Chunk retains the exact source block identity");
assert.deepEqual(parsedDocument.blocks.map((block) => block.rawBlockId), ["raw-title", "raw-body", "raw-table"], "generation keeps the Parsed Document immutable");

const multipageMapping: SourcePageMapping = {
  mappingVersion: "t06-multipage-mapping-v1",
  sourceDocumentVersion: "source-t06-multi",
  pages: [1, 2, 3, 7].map((page) => ({
    page,
    pageWidth: 1000,
    pageHeight: 1000,
    bboxPageWidth: 1000,
    bboxPageHeight: 1000,
    coordinateUnit: "fixture-pixel",
    coordinateOrigin: "top-left" as const,
    orientation: 0 as const,
    transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    mediaBox: [0, 0, 1000, 1000] as [number, number, number, number],
    cropBox: [0, 0, 1000, 1000] as [number, number, number, number],
  })),
};
const multipageDocument = buildMineruParsedDocument([
  { id: "p7-member", type: "text", text: "跨页七", page_idx: 6, bbox: [100, 100, 300, 180] },
  { id: "p1-first", type: "text", text: "同页甲", page_idx: 0, bbox: [100, 100, 300, 180] },
  { id: "p1-gap-text", type: "text", text: "间隙正文", page_idx: 0, bbox: [100, 220, 300, 300] },
  { id: "p1-gap-table", type: "table", table_body: "<table><tr><th>间隙表</th></tr></table>", page_idx: 0, bbox: [350, 220, 650, 360] },
  { id: "p1-gap-image", type: "image", img_path: "gap.png", page_idx: 0, bbox: [700, 220, 900, 400] },
  { id: "p1-last", type: "text", text: "同页乙", page_idx: 0, bbox: [100, 440, 300, 520] },
  { id: "p3-member", type: "text", text: "跨页三", page_idx: 2, bbox: [100, 100, 300, 180] },
  { id: "p1-cross", type: "text", text: "跨页一", page_idx: 0, bbox: [600, 100, 800, 180] },
], {
  sourceDocumentVersion: "source-t06-multi",
  parserVersion: "mineru-t06-fixture",
  sourceMapping: multipageMapping,
});
const blockByRawId = new Map(multipageDocument.blocks.map((block) => [block.rawBlockId, block]));
const detection = (rawId: string, type = "text") => {
  const block = blockByRawId.get(rawId)!;
  return {
    id: block.contentBlockId,
    sourceBlockIds: [block.contentBlockId],
    page: block.sourceLocation.page!,
    bbox: block.sourceLocation.bbox!.map((value) => value / 1000) as [number, number, number, number],
    type,
    readingOrder: multipageDocument.blocks.indexOf(block),
    layer: "detection" as const,
  };
};
const samePageGroup = [
  { ...detection("p1-first"), id: "same-region-a", layer: "manual" as const, logicalGroupId: "same-gap-group" },
  { ...detection("p1-last"), id: "same-region-b", layer: "manual" as const, logicalGroupId: "same-gap-group" },
];
const crossPageGroup = [
  { ...detection("p7-member"), id: "cross-p7", layer: "manual" as const, logicalGroupId: "cross-p1-p3-p7", readingOrder: 30 },
  { ...detection("p3-member"), id: "cross-p3", layer: "manual" as const, logicalGroupId: "cross-p1-p3-p7", readingOrder: 20 },
  { ...detection("p1-cross"), id: "cross-p1", layer: "manual" as const, logicalGroupId: "cross-p1-p3-p7", readingOrder: 10 },
];
const grouped = generateManualChunks({
  document: multipageDocument,
  sourceMapping: multipageMapping,
  scope: { kind: "document" },
  effectiveAnnotations: [...samePageGroup, ...crossPageGroup],
  suppressedSourceBlockIds: [...samePageGroup, ...crossPageGroup].flatMap((item) => item.sourceBlockIds),
  previousChunks: [],
  imagePolicy: "reference",
});
assert.equal(grouped.chunks.length, 2, "each same-page or cross-page logical group creates exactly one Chunk");
const sameChunk = grouped.chunks.find((chunk) => chunk.manualGenerationKey === "group:same-gap-group")!;
assert.equal(sameChunk.finalText, "同页甲\n同页乙", "non-contiguous same-page content contains explicit members only");
assert.deepEqual(sameChunk.sourceBlockIds, [blockByRawId.get("p1-first")!.contentBlockId, blockByRawId.get("p1-last")!.contentBlockId], "gap text, table, and image source IDs stay excluded");
const crossChunk = grouped.chunks.find((chunk) => chunk.manualGenerationKey === "group:cross-p1-p3-p7")!;
assert.equal(crossChunk.finalText, "跨页一\n跨页三\n跨页七", "cross-page group content follows page and reading order");
assert.deepEqual(crossChunk.sourceSegments.map((segment) => segment.page), [1, 3, 7], "cross-page source evidence is stably ordered");

const suppressedDirect = detection("p1-gap-text");
const suppressionResult = generateManualChunks({
  document: multipageDocument,
  sourceMapping: multipageMapping,
  scope: { kind: "document" },
  effectiveAnnotations: [suppressedDirect],
  suppressedSourceBlockIds: suppressedDirect.sourceBlockIds,
  previousChunks: [],
  imagePolicy: "reference",
});
assert.equal(suppressionResult.chunks.length, 0, "suppressed MinerU detections never generate a Chunk");
const replacementResult = generateManualChunks({
  document: multipageDocument,
  sourceMapping: multipageMapping,
  scope: { kind: "document" },
  effectiveAnnotations: samePageGroup,
  suppressedSourceBlockIds: samePageGroup.flatMap((item) => item.sourceBlockIds),
  previousChunks: [],
  imagePolicy: "reference",
});
assert.deepEqual(replacementResult.chunks[0]?.sourceBlockIds, sameChunk.sourceBlockIds, "replacement regions retain every suppressed original Source Block ID");

const spatialAnnotation = {
  id: "drawn-body-only",
  sourceBlockIds: [],
  page: 1,
  bbox: [0.1, 0.19, 0.9, 0.35] as [number, number, number, number],
  type: "text",
  readingOrder: 1,
  layer: "manual" as const,
};
const spatial = generateManualChunks({
  document: parsedDocument,
  sourceMapping,
  scope: { kind: "document" },
  effectiveAnnotations: [spatialAnnotation],
  suppressedSourceBlockIds: [],
  previousChunks: [],
  imagePolicy: "reference",
});
assert.equal(spatial.chunks[0]?.finalText, "不应进入标题 Chunk 的正文", "a drawn bbox reads only intersecting trusted blocks");
assert.throws(() => generateManualChunks({
  document: parsedDocument,
  sourceMapping,
  scope: { kind: "document" },
  effectiveAnnotations: [{ ...spatialAnnotation, id: "drawn-empty", bbox: [0.01, 0.75, 0.05, 0.8] }],
  suppressedSourceBlockIds: [],
  previousChunks: [],
  imagePolicy: "reference",
}), (error: unknown) => {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "EMPTY_BBOX_INTERSECTION" || !("details" in error))
    return false;
  assert.deepEqual(error.details, {
    problemAnnotations: [{
      id: "drawn-empty",
      page: 1,
      type: "text",
      bbox: [0.01, 0.75, 0.05, 0.8],
    }],
  });
  return true;
}, "an empty bbox intersection identifies the problem annotation without page-text fallback");

const emptyBrandImage = {
  id: "empty-brand-image",
  sourceBlockIds: [],
  page: 1,
  bbox: [0.01, 0.75, 0.05, 0.8] as [number, number, number, number],
  type: "image",
  readingOrder: 2,
  layer: "manual" as const,
};
const emptyBrandImageResult = generateManualChunks({
  document: parsedDocument,
  sourceMapping,
  scope: { kind: "document" },
  effectiveAnnotations: [emptyBrandImage],
  suppressedSourceBlockIds: [],
  previousChunks: [],
  imagePolicy: "reference",
});
assert.equal(emptyBrandImageResult.chunks.length, 1, "an empty manual image bbox still creates an image Chunk");
assert.equal(emptyBrandImageResult.chunks[0]?.type, "image");
assert.equal(emptyBrandImageResult.chunks[0]?.finalText, "", "reference-only image starts without summary text");
assert.equal(emptyBrandImageResult.chunks[0]?.embeddingEligible, false, "reference-only image is excluded from text Embedding");
assert.deepEqual(emptyBrandImageResult.chunks[0]?.sourceBlockIds, [], "an empty manual image does not fabricate Source Block identity");
assert.equal(emptyBrandImageResult.chunks[0]?.sourceSegments[0]?.page, 1);
assert.deepEqual(
  (emptyBrandImageResult.chunks[0]?.sourceSegments[0] as Record<string, unknown>).provenance,
  { kind: "human_image_region", annotationId: "empty-brand-image", source: "human" },
  "empty image provenance is the manual region, not a fabricated Source Block",
);

const missingBboxDocument = buildMineruParsedDocument([
  { id: "missing-bbox", type: "text", text: "不可猜测", page_idx: 0 },
], { sourceDocumentVersion: "source-t06-v1", parserVersion: "mineru-t06-fixture", sourceMapping });
const missingBlock = missingBboxDocument.blocks[0];
assert.throws(() => generateManualChunks({
  document: missingBboxDocument,
  sourceMapping,
  scope: { kind: "document" },
  effectiveAnnotations: [{ ...spatialAnnotation, id: missingBlock.contentBlockId, sourceBlockIds: [missingBlock.contentBlockId] }],
  suppressedSourceBlockIds: [],
  previousChunks: [],
  imagePolicy: "reference",
}), (error: unknown) => {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "BBOX_UNTRUSTED" || !("details" in error))
    return false;
  assert.deepEqual(error.details, {
    problemAnnotations: [{
      id: missingBlock.contentBlockId,
      page: 1,
      type: "text",
      bbox: spatialAnnotation.bbox,
    }],
  });
  return true;
}, "missing bbox evidence identifies the problem annotation");
const staleVersionDocument = structuredClone(parsedDocument);
staleVersionDocument.blocks[0]!.sourceLocation.bboxEvidence!.sourceDocumentVersion = "stale-source-version";
assert.throws(() => generateManualChunks({
  document: staleVersionDocument,
  sourceMapping,
  scope: { kind: "document" },
  effectiveAnnotations: [detectionForDocument(staleVersionDocument, 0)],
  suppressedSourceBlockIds: [],
  previousChunks: [],
  imagePolicy: "reference",
}), /过期|版本不匹配/, "stale bbox evidence fails explicitly");
const outOfBoundsDocument = structuredClone(parsedDocument);
outOfBoundsDocument.blocks[0]!.sourceLocation.bbox = [100, 80, 1200, 140];
assert.throws(() => generateManualChunks({
  document: outOfBoundsDocument,
  sourceMapping,
  scope: { kind: "document" },
  effectiveAnnotations: [detectionForDocument(outOfBoundsDocument, 0)],
  suppressedSourceBlockIds: [],
  previousChunks: [],
  imagePolicy: "reference",
}), /越界/, "out-of-bounds bbox evidence fails explicitly");

const rotatedMapping: SourcePageMapping = {
  mappingVersion: "t06-rotated-cropped-v1",
  sourceDocumentVersion: "source-t06-rotated",
  pages: [{ page: 1, pageWidth: 1000, pageHeight: 1000, bboxPageWidth: 1000, bboxPageHeight: 1000, coordinateUnit: "fixture-pixel", coordinateOrigin: "top-left", orientation: 90, transform: [1, 0, 0, 1, 0, 0], mediaBox: [0, 0, 1000, 1000], cropBox: [100, 100, 900, 900] }],
};
const rotatedDocument = buildMineruParsedDocument([
  { id: "rotated", type: "text", text: "旋转裁剪仍精确", page_idx: 0, bbox: [200, 200, 400, 300] },
], { sourceDocumentVersion: "source-t06-rotated", parserVersion: "mineru-t06-fixture", sourceMapping: rotatedMapping });
const rotated = generateManualChunks({
  document: rotatedDocument,
  sourceMapping: rotatedMapping,
  scope: { kind: "document" },
  effectiveAnnotations: [{ id: "rotated-selection", sourceBlockIds: [rotatedDocument.blocks[0]!.contentBlockId], page: 1, bbox: [0.74, 0.12, 0.88, 0.38], type: "text", readingOrder: 0, layer: "manual" }],
  suppressedSourceBlockIds: [],
  previousChunks: [],
  imagePolicy: "reference",
});
assert.equal(rotated.chunks[0]?.finalText, "旋转裁剪仍精确", "scale, 90-degree rotation, and crop mapping preserve bbox intersection");

const twoSingles = [detection("p1-gap-text"), detection("p3-member")];
const initial = generateManualChunks({ document: multipageDocument, sourceMapping: multipageMapping, scope: { kind: "document" }, effectiveAnnotations: twoSingles, suppressedSourceBlockIds: [], previousChunks: [], imagePolicy: "reference" });
const revisedPrevious = structuredClone(initial.chunks);
revisedPrevious[0]!.finalText = "人工修订保持";
revisedPrevious[0]!.revisions.push({ type: "text", at: "2026-08-15T00:00:00.000Z", before: revisedPrevious[0]!.automaticText, after: "人工修订保持" });
revisedPrevious[1]!.finalText = "受影响人工修订会覆盖";
revisedPrevious[1]!.revisions.push({ type: "text", at: "2026-08-15T00:00:00.000Z" });
const unchangedRepeat = generateManualChunks({ document: multipageDocument, sourceMapping: multipageMapping, scope: { kind: "document" }, effectiveAnnotations: twoSingles, suppressedSourceBlockIds: [], previousChunks: revisedPrevious, imagePolicy: "reference" });
assert.deepEqual(unchangedRepeat.chunks, revisedPrevious, "repeat generation is idempotent and preserves unchanged human revisions");
const changedAnnotation = { ...twoSingles[1]!, type: "heading" };
const affected = generateManualChunks({ document: multipageDocument, sourceMapping: multipageMapping, scope: { kind: "document" }, effectiveAnnotations: [twoSingles[0]!, changedAnnotation], suppressedSourceBlockIds: [], previousChunks: revisedPrevious, imagePolicy: "reference" });
assert.equal(affected.chunks[0]?.finalText, "人工修订保持", "unrelated Chunk content and revision remain untouched");
assert.deepEqual(affected.chunks[0]?.revisions, revisedPrevious[0]?.revisions, "unrelated Chunk revision history remains untouched");
assert.equal(affected.chunks[1]?.finalText, affected.chunks[1]?.automaticText, "an affected Chunk is replaced by automatic content");
assert.deepEqual(affected.chunks[1]?.revisions, [], "affected automatic recompute overwrites its human revision");

const pageOne = generateManualChunks({ document: multipageDocument, sourceMapping: multipageMapping, scope: { kind: "page", page: 1 }, effectiveAnnotations: twoSingles, suppressedSourceBlockIds: [], previousChunks: [], imagePolicy: "reference" });
const pageThree = generateManualChunks({ document: multipageDocument, sourceMapping: multipageMapping, scope: { kind: "page", page: 3 }, effectiveAnnotations: twoSingles, suppressedSourceBlockIds: [], previousChunks: pageOne.chunks, imagePolicy: "reference" });
assert.equal(pageThree.chunks.length, 2, "current-page generation accumulates across pages without duplicates");
const afterDelete = generateManualChunks({ document: multipageDocument, sourceMapping: multipageMapping, scope: { kind: "page", page: 1 }, effectiveAnnotations: [twoSingles[1]!], suppressedSourceBlockIds: [twoSingles[0]!.sourceBlockIds[0]!], previousChunks: pageThree.chunks, imagePolicy: "reference" });
assert.deepEqual(afterDelete.chunks.map((chunk) => chunk.sourceBlockIds), [twoSingles[1]!.sourceBlockIds], "current-page regeneration deletes the removed affected Chunk and preserves other pages");

const beforeMerge = generateManualChunks({ document: multipageDocument, sourceMapping: multipageMapping, scope: { kind: "document" }, effectiveAnnotations: [detection("p1-first"), detection("p1-last")], suppressedSourceBlockIds: [], previousChunks: [], imagePolicy: "reference" });
const afterMerge = generateManualChunks({ document: multipageDocument, sourceMapping: multipageMapping, scope: { kind: "page", page: 1, selectedAnnotationIds: samePageGroup.map((item) => item.id) }, effectiveAnnotations: samePageGroup, suppressedSourceBlockIds: samePageGroup.flatMap((item) => item.sourceBlockIds), previousChunks: beforeMerge.chunks, imagePolicy: "reference" });
assert.equal(afterMerge.chunks.length, 1, "merge recompute removes replaced direct Chunks instead of duplicating their sources");
assert.equal(afterMerge.chunks[0]?.manualGenerationKey, "group:same-gap-group");

const tableAbove = detection("p1-gap-table", "table");
const tableBelow = { ...detection("p3-member", "table"), id: "table-below" };
const tablePageOne = generateManualChunks({ document: multipageDocument, sourceMapping: multipageMapping, scope: { kind: "page", page: 1 }, effectiveAnnotations: [tableAbove], suppressedSourceBlockIds: [], previousChunks: [], imagePolicy: "reference" });
const tablePages = generateManualChunks({ document: multipageDocument, sourceMapping: multipageMapping, scope: { kind: "page", page: 3 }, effectiveAnnotations: [tableBelow], suppressedSourceBlockIds: [], previousChunks: tablePageOne.chunks, imagePolicy: "reference" });
const tableGroup = [
  { ...tableAbove, id: "table-group-above", logicalGroupId: "table-cross-page", layer: "manual" as const },
  { ...tableBelow, logicalGroupId: "table-cross-page", layer: "manual" as const },
];
const afterTableMerge = generateManualChunks({
  document: multipageDocument,
  sourceMapping: multipageMapping,
  scope: { kind: "page", page: 3, selectedAnnotationIds: tableGroup.map((item) => item.id) },
  effectiveAnnotations: tableGroup,
  suppressedSourceBlockIds: tableGroup.flatMap((item) => item.sourceBlockIds),
  previousChunks: tablePages.chunks,
  imagePolicy: "reference",
});
assert.equal(afterTableMerge.chunks.length, 1, "cross-page table regeneration removes both old direct Chunks");
assert.equal(afterTableMerge.chunks[0]?.manualGenerationKey, "group:table-cross-page", "cross-page tables regenerate as one logical group Chunk");

const mixedTableDocument = buildMineruParsedDocument([
  { id: "structured-table", type: "table", table_body: "<table><tr><th>月份</th><th>销量</th></tr><tr><td>2025-01</td><td>5668</td></tr></table>", page_idx: 0, bbox: [100, 100, 900, 700] },
  { id: "empty-table-continuation", type: "table", table_body: "", page_idx: 1, bbox: [100, 100, 900, 700] },
], {
  sourceDocumentVersion: "source-t06-multi",
  parserVersion: "mineru-t06-fixture",
  sourceMapping: multipageMapping,
});
const mixedTableAnnotations = mixedTableDocument.blocks.map((block, index) => ({
  id: `mixed-table-${index}`,
  sourceBlockIds: [block.contentBlockId],
  page: block.sourceLocation.page!,
  bbox: block.sourceLocation.bbox!.map((value) => value / 1000) as [number, number, number, number],
  type: "table",
  readingOrder: index,
  layer: "manual" as const,
  logicalGroupId: "mixed-table",
}));
const mixedTableMerge = generateManualChunks({
  document: mixedTableDocument,
  sourceMapping: multipageMapping,
  scope: { kind: "page", page: 2, selectedAnnotationIds: mixedTableAnnotations.map((item) => item.id) },
  effectiveAnnotations: mixedTableAnnotations,
  suppressedSourceBlockIds: mixedTableAnnotations.flatMap((item) => item.sourceBlockIds),
  previousChunks: [],
  imagePolicy: "reference",
});
assert.equal(mixedTableMerge.chunks[0]?.embeddingEligible, true, "a merged table with reliable structure and text is eligible even when one continuation block is empty");
assert.deepEqual(mixedTableMerge.chunks[0]?.embeddingExclusionReasons, []);

const mixedTextDocument = buildMineruParsedDocument([
  { id: "reliable-text", type: "text", text: "合并后的正文完整且可用于检索。", page_idx: 0, bbox: [100, 100, 900, 260] },
  { id: "empty-text-continuation", type: "text", text: "", page_idx: 1, bbox: [100, 100, 900, 260] },
], {
  sourceDocumentVersion: "source-t06-multi",
  parserVersion: "mineru-t06-fixture",
  sourceMapping: multipageMapping,
});
const mixedTextAnnotations = mixedTextDocument.blocks.map((block, index) => ({
  id: `mixed-text-${index}`,
  sourceBlockIds: [block.contentBlockId],
  page: block.sourceLocation.page!,
  bbox: block.sourceLocation.bbox!.map((value) => value / 1000) as [number, number, number, number],
  type: "text",
  readingOrder: index,
  layer: "manual" as const,
  logicalGroupId: "mixed-text",
}));
const mixedTextMerge = generateManualChunks({
  document: mixedTextDocument,
  sourceMapping: multipageMapping,
  scope: { kind: "document" },
  effectiveAnnotations: mixedTextAnnotations,
  suppressedSourceBlockIds: mixedTextAnnotations.flatMap((item) => item.sourceBlockIds),
  previousChunks: [],
  imagePolicy: "reference",
});
assert.equal(mixedTextMerge.chunks[0]?.finalText, "合并后的正文完整且可用于检索。");
assert.equal(mixedTextMerge.chunks[0]?.embeddingEligible, true, "an empty failed source does not block reliable merged text");
assert.deepEqual(mixedTextMerge.chunks[0]?.embeddingExclusionReasons, []);

const visibleFailedTextDocument = structuredClone(mixedTextDocument);
Object.assign(visibleFailedTextDocument.blocks[1]!, {
  searchText: "仍有文字但规范化失败",
  automaticText: "仍有文字但规范化失败",
  finalText: "仍有文字但规范化失败",
  normalizationStatus: "failed",
});
const visibleFailedTextMerge = generateManualChunks({
  document: visibleFailedTextDocument,
  sourceMapping: multipageMapping,
  scope: { kind: "document" },
  effectiveAnnotations: mixedTextAnnotations,
  suppressedSourceBlockIds: mixedTextAnnotations.flatMap((item) => item.sourceBlockIds),
  previousChunks: [],
  imagePolicy: "reference",
});
assert.equal(visibleFailedTextMerge.chunks[0]?.embeddingEligible, false, "a failed source with its own text still blocks the merged Chunk");
assert.deepEqual(visibleFailedTextMerge.chunks[0]?.embeddingExclusionReasons, ["normalization_failed"]);

const emptyOnlyTableDocument = buildMineruParsedDocument([
  { id: "empty-only-table", type: "table", table_body: "", page_idx: 0, bbox: [100, 100, 900, 700] },
], {
  sourceDocumentVersion: "source-t06-multi",
  parserVersion: "mineru-t06-fixture",
  sourceMapping,
});
const emptyOnlyTable = emptyOnlyTableDocument.blocks[0]!;
const emptyOnlyTableResult = generateManualChunks({
  document: emptyOnlyTableDocument,
  sourceMapping: multipageMapping,
  scope: { kind: "document" },
  effectiveAnnotations: [{
    id: "empty-only-table-annotation",
    sourceBlockIds: [emptyOnlyTable.contentBlockId],
    page: 1,
    bbox: emptyOnlyTable.sourceLocation.bbox!.map((value) => value / 1000) as [number, number, number, number],
    type: "table",
    readingOrder: 0,
    layer: "detection",
  }],
  suppressedSourceBlockIds: [],
  previousChunks: [],
  imagePolicy: "reference",
});
assert.equal(emptyOnlyTableResult.chunks.length, 0, "an unusable empty table does not become a broken Table Chunk");

const firstSelectedMerge = generateManualChunks({
  document: multipageDocument,
  sourceMapping: multipageMapping,
  scope: { kind: "page", page: 3, selectedAnnotationIds: tableGroup.map((item) => item.id) },
  effectiveAnnotations: [detection("p1-first"), detection("p1-last"), ...tableGroup],
  suppressedSourceBlockIds: tableGroup.flatMap((item) => item.sourceBlockIds),
  previousChunks: [],
  imagePolicy: "reference",
});
assert.equal(firstSelectedMerge.chunks.length, 3, "a first selected merge builds the unaffected baseline instead of returning only the merged table");
assert.equal(firstSelectedMerge.chunks.filter((chunk) => chunk.manualGenerationKey === "group:table-cross-page").length, 1);
assert.ok(firstSelectedMerge.chunks.some((chunk) => chunk.sourceBlockIds.includes(blockByRawId.get("p1-first")!.contentBlockId)));
assert.ok(firstSelectedMerge.chunks.some((chunk) => chunk.sourceBlockIds.includes(blockByRawId.get("p1-last")!.contentBlockId)));

const automaticChunk = { ...afterTableMerge.chunks[0]!, id: "automatic-neighbor", manualGenerationKey: undefined };
const mixedPrevious = [automaticChunk, ...tablePages.chunks];
const preparedMixedPrevious = preparePreviousChunksForManualGeneration(mixedPrevious);
assert.equal(preparedMixedPrevious.length, mixedPrevious.length, "incremental manual generation keeps automatic neighboring Chunks");
assert.equal(preparedMixedPrevious[0]?.id, automaticChunk.id, "automatic neighboring Chunk reaches the generator unchanged");

function detectionForDocument(document: typeof parsedDocument, index: number) {
  const block = document.blocks[index]!;
  return {
    id: block.contentBlockId,
    sourceBlockIds: [block.contentBlockId],
    page: block.sourceLocation.page!,
    bbox: [0.1, 0.08, 0.9, 0.14] as [number, number, number, number],
    type: "heading",
    readingOrder: index,
    layer: "detection" as const,
  };
}
