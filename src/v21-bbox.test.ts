import assert from "node:assert/strict";
import { mapTrustedBbox, type BboxMappingInput } from "./v21-bbox.js";

const base: BboxMappingInput = {
  sourceDocumentVersion: "source-v1",
  visualCopyVersion: "visual-v1",
  sourceViewKind: "original_file",
  page: 1,
  bbox: [30, 50, 110, 70],
  evidence: {
    page: 1,
    pageWidth: 200,
    pageHeight: 300,
    coordinateUnit: "pdf_point",
    coordinateOrigin: "bottom-left",
    orientation: 0,
    transform: [1, 0, 0, 1, 0, 0],
    mappingVersion: "map-v1",
    sourceDocumentVersion: "source-v1",
  },
  pageGeometry: {
    mediaBox: [0, 0, 200, 300],
    cropBox: [20, 30, 180, 270],
    rotation: 0,
    cssWidth: 320,
    cssHeight: 480,
    devicePixelRatio: 2,
  },
  current: { sourceDocumentVersion: "source-v1", visualCopyVersion: "visual-v1" },
};

assert.deepEqual(mapTrustedBbox(base), {
  quality: "exact",
  page: 1,
  cssBox: [20, 400, 180, 440],
  deviceBox: [40, 800, 360, 880],
  pageCssWidth: 320,
  pageCssHeight: 480,
});

for (const rotation of [90, 180, 270] as const) {
  const mapped = mapTrustedBbox({
    ...base,
    evidence: { ...base.evidence!, orientation: rotation },
    pageGeometry: { ...base.pageGeometry, rotation, cssWidth: 480, cssHeight: 320 },
  });
  assert.equal(mapped.quality, "exact", `rotation ${rotation} remains mappable`);
  assert.ok(mapped.cssBox.every(Number.isFinite));
  assert.ok(mapped.deviceBox.every(Number.isFinite));
}

assert.equal(
  mapTrustedBbox({ ...base, evidence: { ...base.evidence!, sourceDocumentVersion: "source-v2" } }).quality,
  "unavailable",
  "stale source evidence never creates a guessed bbox",
);
assert.equal(
  mapTrustedBbox({ ...base, bbox: [190, 20, 220, 70] }).quality,
  "page_only",
  "an out-of-bounds bbox downgrades to page-only",
);
assert.equal(
  mapTrustedBbox({ ...base, page: 2 }).quality,
  "page_only",
  "a cross-page segment without matching page evidence downgrades",
);
assert.equal(
  mapTrustedBbox({ ...base, evidence: { ...base.evidence!, orientation: 45 } }).quality,
  "unavailable",
  "unsupported rotation is unavailable rather than guessed",
);
assert.equal(
  mapTrustedBbox({ ...base, sourceViewKind: "visual_copy", visualCopyVersion: "visual-v2" }).quality,
  "unavailable",
  "visual copy version mismatch is unavailable",
);

console.log("V2.1 bbox mapping tests passed");
