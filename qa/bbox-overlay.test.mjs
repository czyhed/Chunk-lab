import assert from "node:assert/strict";
import { normalizeTrustedBbox } from "../bbox-mapping.js";

const input = {
  sourceDocumentVersion: "source-v1",
  sourceViewKind: "original_file",
  page: 1,
  bbox: [100, 200, 300, 400],
  evidence: {
    page: 1,
    pageWidth: 1000,
    pageHeight: 1000,
    coordinateUnit: "mineru_normalized_1000",
    coordinateOrigin: "top-left",
    orientation: 0,
    transform: [0.612, 0, 0, 0.792, 0, 0],
    mappingVersion: "mineru-content-list-1000+pdfjs-5.4.149",
    sourceDocumentVersion: "source-v1",
    mediaBox: [0, 0, 612, 792],
    cropBox: [0, 0, 612, 792],
  },
  pageGeometry: {
    mediaBox: [0, 0, 612, 792],
    cropBox: [0, 0, 612, 792],
    rotation: 0,
    cssWidth: 612,
    cssHeight: 792,
    devicePixelRatio: 1,
  },
  current: { sourceDocumentVersion: "source-v1" },
};

function assertBox(actual, expected, message) {
  assert.ok(actual, message);
  assert.equal(actual.length, 4, message);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-12, message));
}

assertBox(
  normalizeTrustedBbox(input),
  [0.1, 0.2, 0.3, 0.4],
  "MinerU 0-1000 coordinates normalize against the transformed PDF page",
);
assertBox(
  normalizeTrustedBbox({
    ...input,
    evidence: { ...input.evidence, orientation: 90 },
    pageGeometry: { ...input.pageGeometry, rotation: 90, cssWidth: 792, cssHeight: 612 },
  }),
  [0.6, 0.1, 0.8, 0.3],
  "normalization preserves the trusted 90-degree rotation transform",
);
assert.equal(
  normalizeTrustedBbox({ ...input, current: { sourceDocumentVersion: "source-v2" } }),
  null,
  "version-mismatched evidence never produces an overlay",
);
assert.equal(
  normalizeTrustedBbox({ ...input, bbox: [900, 900, 1100, 1200] }),
  null,
  "out-of-bounds evidence never produces an overlay",
);

console.log("BBox overlay normalization tests passed");
