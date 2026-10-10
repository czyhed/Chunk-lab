import assert from "node:assert/strict";
import {
  buildLocalParsedDocument,
  buildMineruParsedDocument,
} from "./v21-parsed-document.js";

const parsed = buildMineruParsedDocument(
  [
    {
      id: "mineru-title-1",
      type: "title",
      text: "A1 智能料理机",
      page_idx: 0,
      bbox: [10, 20, 300, 60],
    },
    {
      id: "mineru-table-1",
      type: "table",
      table_title: "产品参数",
      table_body:
        "<table><tr><th>型号</th><th>功率</th></tr><tr><td>A1</td><td>1200 W</td></tr></table>",
      page_idx: 1,
      bbox: [10, 80, 500, 400],
    },
    {
      id: "mineru-unknown-1",
      type: "custom_widget",
      text: "internal widget",
      page_idx: 1,
    },
  ],
  {
    sourceDocumentVersion: "src-test",
    parserVersion: "mineru-vlm-test",
    sourceViewKind: "visual_copy",
  },
);

const mapped = buildMineruParsedDocument(
  [{ type: "text", text: "mapped", page_idx: 0, bbox: [10, 20, 100, 80] }],
  {
    sourceDocumentVersion: "src-mapped",
    parserVersion: "mineru-vlm-test",
    sourceViewKind: "original_file",
    sourceMapping: {
      mappingVersion: "pdf-map-v1",
      sourceDocumentVersion: "src-mapped",
      pages: [{ page: 1, pageWidth: 200, pageHeight: 300, coordinateUnit: "pdf_point", coordinateOrigin: "top-left", orientation: 0, transform: [1, 0, 0, 1, 0, 0], mediaBox: [0, 0, 200, 300], cropBox: [0, 0, 200, 300] }],
    },
  },
);
assert.deepEqual(mapped.blocks[0].sourceLocation.bbox, [10, 20, 100, 80]);
assert.equal(mapped.blocks[0].sourceLocation.locationQuality, "exact");
assert.equal(mapped.blocks[0].sourceLocation.bboxEvidence?.mappingVersion, "pdf-map-v1");

const normalizedMineruBbox = buildMineruParsedDocument(
  [{ type: "text", text: "normalized bbox", page_idx: 0, bbox: [100, 200, 900, 800] }],
  {
    sourceDocumentVersion: "src-normalized",
    parserVersion: "mineru-content-list-test",
    sourceMapping: {
      mappingVersion: "mineru-content-list-1000+pdfjs-test",
      sourceDocumentVersion: "src-normalized",
      pages: [{
        page: 1,
        pageWidth: 612,
        pageHeight: 792,
        bboxPageWidth: 1000,
        bboxPageHeight: 1000,
        coordinateUnit: "mineru_normalized_1000",
        coordinateOrigin: "top-left",
        orientation: 0,
        transform: [0.612, 0, 0, 0.792, 0, 0],
        mediaBox: [0, 0, 612, 792],
        cropBox: [0, 0, 612, 792],
      }],
    },
  },
);
assert.equal(normalizedMineruBbox.blocks[0].sourceLocation.locationQuality, "exact");
assert.deepEqual(normalizedMineruBbox.blocks[0].sourceLocation.bbox, [100, 200, 900, 800]);
assert.equal(normalizedMineruBbox.blocks[0].sourceLocation.bboxEvidence?.pageWidth, 1000);
assert.equal(normalizedMineruBbox.blocks[0].sourceLocation.bboxEvidence?.pageHeight, 1000);

assert.equal(parsed.contractVersion, "2.1");
assert.match(parsed.parsedDocumentVersion, /^parsed-/);
assert.match(parsed.normalizedContentVersion, /^normalized-/);
assert.deepEqual(parsed.blocks.map((block) => block.contentType), [
  "heading",
  "table",
  "unsupported",
]);
assert.equal(parsed.blocks[1].searchText, "产品参数\n型号 | 功率\nA1 | 1200 W");
assert.equal(parsed.blocks[1].searchText.includes("<tr>"), false);
assert.match(parsed.blocks[1].raw.rawTableHtml ?? "", /<table>/);
assert.equal(parsed.blocks[1].sourceLocation.page, 2);
assert.equal(parsed.blocks[1].sourceLocation.bbox, null);
assert.equal(parsed.blocks[1].sourceLocation.locationQuality, "page_only");
assert.equal(parsed.blocks[1].sourceLocation.sourceViewKind, "visual_copy");
assert.equal(parsed.blocks[2].normalizationStatus, "unsupported");
assert.equal(parsed.blocks[2].searchText, "");
assert.equal(JSON.stringify(parsed.ordinaryBlocks).includes("rawTableHtml"), false);

const local = buildLocalParsedDocument("# A1\n\n说明 🔥", {
  kind: "markdown",
  sourceDocumentVersion: "src-md-test",
  parserVersion: "commonmark-0.31.2",
});
assert.equal(local.contractVersion, "2.1");
assert.deepEqual(local.blocks.map((block) => block.contentType), [
  "heading",
  "paragraph",
]);
assert.deepEqual(local.blocks[1].sourceRange, {
  sourceStart: 6,
  sourceEnd: 11,
  startLine: 3,
  endLine: 3,
});
assert.equal(local.blocks[1].sourceLocation.locationQuality, "exact");
assert.equal(local.blocks[1].sourceLocation.page, null);

console.log("V2.1 Parsed Document tests passed");
