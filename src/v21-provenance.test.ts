import assert from "node:assert/strict";
import { normalizeContentBlock } from "./v21-normalization.js";
import {
  buildCrossPageTableGroup,
  buildProvenancedContentBlock,
  buildSourceSegment,
  toOrdinarySemanticBlock,
} from "./v21-provenance.js";

const normalizedTable = normalizeContentBlock({
  type: "table",
  parser: "mineru",
  parserVersion: "mineru-test",
  parsedDocumentVersion: "parsed-v1",
  rawBlockId: "mineru-table-7",
  table: {
    columns: ["型号", "功率"],
    rows: [["A1", "1200 W"]],
  },
  table_body: "<table><tr><td>A1</td><td>1200 W</td></tr></table>",
});

const table = buildProvenancedContentBlock(normalizedTable, {
  sourceDocumentVersion: "source-v1",
  blockIndex: 6,
});
const sameTable = buildProvenancedContentBlock(normalizedTable, {
  sourceDocumentVersion: "source-v1",
  blockIndex: 6,
});
const reparsedTable = buildProvenancedContentBlock(
  { ...normalizedTable, parsedDocumentVersion: "parsed-v2" },
  { sourceDocumentVersion: "source-v1", blockIndex: 6 },
);

assert.equal(table.rawBlockId, "mineru-table-7");
assert.equal(table.contentBlockId, sameTable.contentBlockId);
assert.notEqual(table.contentBlockId, reparsedTable.contentBlockId);
assert.match(table.contentBlockId, /^parsed-v1:content-block:000007$/);

const semantic = toOrdinarySemanticBlock(table);
assert.equal("raw" in semantic, false, "diagnostics are not ordinary semantic data");
assert.equal("display" in semantic, false, "display HTML is not ordinary semantic data");
assert.equal(JSON.stringify(semantic).includes("rawTableHtml"), false);
assert.equal(JSON.stringify(semantic).includes("<tr>"), false);
assert.equal(semantic.searchText, "型号 | 功率\nA1 | 1200 W");

const exact = buildSourceSegment({
  block: table,
  sourceViewKind: "original_file",
  page: 2,
  bbox: [10, 20, 110, 80],
  sourceStart: 0,
  sourceEnd: table.searchText.length,
  chunkStart: 0,
  chunkEnd: table.searchText.length,
  isOverlap: false,
  mappingQuality: "cell",
  locationQuality: "exact",
  bboxEvidence: {
    sourceDocumentVersion: "source-v1",
    page: 2,
    pageWidth: 612,
    pageHeight: 792,
    coordinateUnit: "points",
    orientation: 0,
    transform: [1, 0, 0, 1, 0, 0],
    mappingVersion: "mapping-v1",
  },
});
assert.deepEqual(exact.bbox, [10, 20, 110, 80]);
assert.equal(exact.locationQuality, "exact");
assert.equal(exact.sourceDocumentVersion, "source-v1");
assert.equal(exact.parsedDocumentVersion, "parsed-v1");

assert.throws(
  () => buildSourceSegment({
    block: table,
    sourceViewKind: "original_file",
    page: 2,
    bbox: [10, 20, 110, 80],
    sourceStart: null,
    sourceEnd: null,
    chunkStart: 0,
    chunkEnd: table.searchText.length,
    isOverlap: false,
    mappingQuality: "block-only",
    locationQuality: "exact",
    bboxEvidence: {
      sourceDocumentVersion: "stale-source-version",
      page: 2,
      pageWidth: 612,
      pageHeight: 792,
      coordinateUnit: "points",
      orientation: 0,
      transform: [1, 0, 0, 1, 0, 0],
      mappingVersion: "mapping-v1",
    },
  }),
  /source document version/i,
  "a stale mapping may not authorize an exact bbox",
);

const pageOnly = buildSourceSegment({
  block: table,
  sourceViewKind: "original_file",
  page: 2,
  bbox: null,
  sourceStart: null,
  sourceEnd: null,
  chunkStart: 0,
  chunkEnd: table.searchText.length,
  isOverlap: false,
  mappingQuality: "block-only",
  locationQuality: "page_only",
});
assert.equal(pageOnly.bbox, null, "missing coordinates stay null");

assert.throws(
  () => buildSourceSegment({
    block: table,
    sourceViewKind: "original_file",
    page: 2,
    bbox: [10, 20, 700, 80],
    sourceStart: null,
    sourceEnd: null,
    chunkStart: 0,
    chunkEnd: table.searchText.length,
    isOverlap: false,
    mappingQuality: "block-only",
    locationQuality: "exact",
    bboxEvidence: {
      sourceDocumentVersion: "source-v1",
      page: 2,
      pageWidth: 612,
      pageHeight: 792,
      coordinateUnit: "points",
      orientation: 0,
      transform: [1, 0, 0, 1, 0, 0],
      mappingVersion: "mapping-v1",
    },
  }),
  /page bounds/i,
  "out-of-bounds coordinates are rejected rather than clamped",
);

const group = buildCrossPageTableGroup({
  contentGroupId: "group-spec-table",
  tableId: "spec-table",
  contentBlockIds: ["parsed-v1:content-block:000007", "parsed-v1:content-block:000008"],
  rowGroups: [
    { rowGroupIndex: 0, startRow: 0, endRow: 12, pages: [2], repeatedHeaderRows: 1 },
    { rowGroupIndex: 1, startRow: 12, endRow: 24, pages: [3], repeatedHeaderRows: 1 },
  ],
});
assert.equal(group.protectedFromTextSplitting, true);
assert.equal(group.tableId, "spec-table");
assert.deepEqual(group.rowGroups.map((rowGroup) => rowGroup.pages), [[2], [3]]);

console.log("V2.1 provenance tests passed");
