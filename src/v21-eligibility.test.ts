import assert from "node:assert/strict";
import type { ContentBlock } from "./v21-contract.js";
import { evaluateEmbeddingEligibility } from "./v21-eligibility.js";

const normalizedParagraph = {
  contractVersion: "2.1",
  parsedDocumentVersion: "parsed-v1",
  parser: "mineru",
  parserVersion: "mineru-test",
  normalizerVersion: "normalizer-test",
  normalizedModelVersion: "model-test",
  rawBlockId: "raw-1",
  contentType: "paragraph",
  raw: { type: "paragraph" },
  normalized: { type: "paragraph", text: "A1 额定功率为 1200 W。" },
  display: { text: "A1 额定功率为 1200 W。" },
  searchText: "A1 额定功率为 1200 W。",
  normalizationStatus: "normalized",
  automaticText: "A1 额定功率为 1200 W。",
  finalText: "A1 额定功率为 1200 W。",
  excludedFromContentFlow: false,
  sourceRange: null,
} satisfies ContentBlock;

const unavailableLocation = evaluateEmbeddingEligibility({
  block: normalizedParagraph,
  locationQuality: "unavailable",
});
assert.equal(unavailableLocation.embeddingEligible, true);
assert.deepEqual(unavailableLocation.embeddingExclusionReasons, []);
assert.equal(unavailableLocation.embeddingText, null);

const ocrFallback = evaluateEmbeddingEligibility({
  block: { ...normalizedParagraph, searchText: "", finalText: "扫描 OCR 文本", automaticText: "扫描 OCR 文本" },
  locationQuality: "parsed_only",
});
assert.equal(ocrFallback.embeddingEligible, true, "OCR text already present in the Chunk remains searchable");
assert.deepEqual(ocrFallback.embeddingExclusionReasons, []);
assert.deepEqual(unavailableLocation.qualityFlags, ["source_location_unavailable"]);

const unsupported = evaluateEmbeddingEligibility({
  block: {
    ...normalizedParagraph,
    contentType: "unsupported",
    normalized: null,
    searchText: "",
    normalizationStatus: "unsupported",
    automaticText: "",
    finalText: "",
    excludedFromContentFlow: true,
  },
  locationQuality: "exact",
});
assert.equal(unsupported.embeddingEligible, false);
assert.deepEqual(unsupported.embeddingExclusionReasons, [
  "unsupported_content",
  "missing_reliable_search_text",
]);
assert.equal(unsupported.embeddingText, null);

for (const locationQuality of ["exact", "page_only", "parsed_only", "unavailable"] as const) {
  const result = evaluateEmbeddingEligibility({ block: normalizedParagraph, locationQuality });
  assert.equal(result.embeddingEligible, true, `${locationQuality} is independent from eligibility`);
  assert.deepEqual(result.embeddingExclusionReasons, []);
  assert.equal(result.embeddingText, null, "G1 reserves embeddingText composition for Plan 03");
}

const failed = evaluateEmbeddingEligibility({
  block: {
    ...normalizedParagraph,
    normalized: null,
    searchText: "",
    normalizationStatus: "failed",
    automaticText: "",
    finalText: "",
    excludedFromContentFlow: true,
  },
  locationQuality: "exact",
});
assert.deepEqual(failed.embeddingExclusionReasons, [
  "normalization_failed",
  "missing_reliable_search_text",
]);

const partialBlock: ContentBlock = {
  ...normalizedParagraph,
  normalizationStatus: "partial",
};
assert.deepEqual(
  evaluateEmbeddingEligibility({ block: partialBlock, locationQuality: "exact" })
    .embeddingExclusionReasons,
  ["partial_content_unconfirmed"],
);
assert.equal(
  evaluateEmbeddingEligibility({
    block: partialBlock,
    locationQuality: "exact",
    partialSemanticsConfirmed: true,
  }).embeddingEligible,
  true,
);

const manualFixed: ContentBlock = {
  ...normalizedParagraph,
  normalizationStatus: "manual_fixed",
};
assert.deepEqual(
  evaluateEmbeddingEligibility({ block: manualFixed, locationQuality: "page_only" })
    .embeddingExclusionReasons,
  ["manual_fix_unvalidated"],
);
assert.equal(
  evaluateEmbeddingEligibility({
    block: manualFixed,
    locationQuality: "page_only",
    manualValidation: {
      reviewedModelValid: true,
      sourceValid: true,
      searchTextValid: true,
    },
  }).embeddingEligible,
  true,
);

const imageWithCaption: ContentBlock = {
  ...normalizedParagraph,
  contentType: "image",
  normalized: {
    type: "image",
    imageId: "image-1",
    caption: "杯体安装方向",
  },
  display: { text: "Caption: 杯体安装方向" },
  searchText: "Caption: 杯体安装方向",
  automaticText: "Caption: 杯体安装方向",
  finalText: "Caption: 杯体安装方向",
};
const missingAssetWithCaption = evaluateEmbeddingEligibility({
  block: imageWithCaption,
  locationQuality: "parsed_only",
  imageAssetAvailable: false,
});
assert.equal(missingAssetWithCaption.embeddingEligible, true);
assert.deepEqual(missingAssetWithCaption.embeddingExclusionReasons, []);
assert.deepEqual(missingAssetWithCaption.qualityFlags, [
  "source_location_parsed_only",
  "image_asset_unavailable",
]);

const imageOnly = evaluateEmbeddingEligibility({
  block: {
    ...imageWithCaption,
    normalized: { type: "image", imageId: "image-2" },
    display: { text: "" },
    searchText: "",
    normalizationStatus: "partial",
    automaticText: "",
    finalText: "",
  },
  locationQuality: "exact",
  imageAssetAvailable: false,
  partialSemanticsConfirmed: true,
});
assert.equal(imageOnly.embeddingEligible, false);
assert.deepEqual(imageOnly.embeddingExclusionReasons, [
  "missing_reliable_search_text",
  "image_only_without_reliable_text",
]);
assert.ok(
  [unavailableLocation, unsupported, failed, missingAssetWithCaption, imageOnly].every(
    (result) => result.embeddingText === null,
  ),
  "all G1 qualification results carry the null embeddingText placeholder",
);

console.log("V2.1 eligibility tests passed");
