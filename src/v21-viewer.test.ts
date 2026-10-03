import assert from "node:assert/strict";
import {
  availableSourceViews,
  createSelectionState,
  overlayForSegment,
  reduceSelection,
  resolveSelection,
  setVisiblePage,
  setZoom,
  virtualPageWindow,
  type ViewerChunk,
  type ViewerSourceSegment,
} from "./v21-viewer.js";

assert.deepEqual(
  availableSourceViews({ format: "pdf", originalAvailable: true, parsedAvailable: true }),
  ["original_file", "parsed_document"],
);
assert.deepEqual(
  availableSourceViews({ format: "docx", visualCopyState: "ready", parsedAvailable: true }),
  ["visual_copy", "parsed_document"],
);
assert.deepEqual(
  availableSourceViews({ format: "xlsx", visualCopyState: "failed", parsedAvailable: true }),
  ["parsed_document"],
  "a failed Visual Copy must not create a simulated page view",
);
assert.deepEqual(
  availableSourceViews({
    format: "md",
    sourceAvailable: true,
    renderedAvailable: true,
    parsedAvailable: true,
  }),
  ["markdown_source", "markdown_rendered", "parsed_document"],
);
assert.deepEqual(
  availableSourceViews({ format: "txt", sourceAvailable: true, parsedAvailable: true }),
  ["txt_source", "parsed_document"],
);

const exactSegment: ViewerSourceSegment = {
  sourceSegmentId: "segment-a",
  sourceDocumentVersion: "source-v1",
  parsedDocumentVersion: "parsed-v1",
  contentBlockId: "block-a",
  rawBlockId: "raw-a",
  sourceViewKind: "original_file",
  page: 2,
  bbox: [10, 20, 110, 80],
  sourceStart: 0,
  sourceEnd: 12,
  chunkStart: 0,
  chunkEnd: 12,
  isOverlap: false,
  mappingQuality: "exact",
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
};

assert.deepEqual(
  overlayForSegment(exactSegment, { sourceDocumentVersion: "source-v1" }),
  {
    sourceSegmentId: "segment-a",
    page: 2,
    bbox: [10, 20, 110, 80],
    pageWidth: 612,
    pageHeight: 792,
  },
);
for (const locationQuality of ["page_only", "parsed_only", "unavailable"] as const) {
  assert.equal(
    overlayForSegment(
      { ...exactSegment, locationQuality },
      { sourceDocumentVersion: "source-v1" },
    ),
    null,
    `${locationQuality} never creates an overlay`,
  );
}
assert.equal(
  overlayForSegment(
    {
      ...exactSegment,
      bboxEvidence: { ...exactSegment.bboxEvidence!, mappingVersion: "" },
    },
    { sourceDocumentVersion: "source-v1" },
  ),
  null,
  "incomplete mapping evidence never creates an overlay",
);
assert.equal(
  overlayForSegment(exactSegment, { sourceDocumentVersion: "source-v2" }),
  null,
  "a stale source version never creates an overlay",
);
assert.equal(
  overlayForSegment(
    {
      ...exactSegment,
      sourceViewKind: "visual_copy",
      visualCopyVersion: "visual-v1",
      bboxEvidence: {
        ...exactSegment.bboxEvidence!,
        sourceDocumentVersion: undefined,
        visualCopyVersion: "visual-v1",
      },
    },
    { sourceDocumentVersion: "source-v1", visualCopyVersion: "visual-v2" },
  ),
  null,
  "a stale Visual Copy mapping never creates an overlay",
);

assert.deepEqual(virtualPageWindow(10, 1), [1, 2]);
assert.deepEqual(virtualPageWindow(10, 6), [5, 6, 7]);
assert.deepEqual(virtualPageWindow(10, 10), [9, 10]);
assert.equal(setVisiblePage(4, 10), 4);
assert.equal(setVisiblePage(0, 10), 1);
assert.equal(setVisiblePage(99, 10), 10);
assert.deepEqual(setZoom("fit"), { mode: "fit", percent: null });
assert.deepEqual(setZoom("actual"), { mode: "actual", percent: 100 });
assert.deepEqual(setZoom("custom", 10), { mode: "custom", percent: 25 });
assert.deepEqual(setZoom("custom", 500), { mode: "custom", percent: 400 });

const segmentB: ViewerSourceSegment = {
  ...exactSegment,
  sourceSegmentId: "segment-b",
  contentBlockId: "block-b",
  page: 3,
  bbox: [20, 30, 120, 90],
  bboxEvidence: { ...exactSegment.bboxEvidence!, page: 3 },
};
const chunks: ViewerChunk[] = [
  { chunkId: "chunk-a", sourceSegments: [exactSegment, segmentB] },
  { chunkId: "chunk-b", sourceSegments: [segmentB] },
];

let selection = reduceSelection(createSelectionState(), { type: "hover_chunk", chunkId: "chunk-a" });
assert.deepEqual(resolveSelection(selection, chunks), {
  chunkIds: ["chunk-a"],
  sourceSegmentIds: ["segment-a", "segment-b"],
  firstSourceSegmentId: "segment-a",
  markedPages: [2, 3],
  locked: false,
});
selection = reduceSelection(selection, { type: "lock_source", sourceSegmentId: "segment-b" });
assert.deepEqual(resolveSelection(selection, chunks), {
  chunkIds: ["chunk-a", "chunk-b"],
  sourceSegmentIds: ["segment-b"],
  firstSourceSegmentId: "segment-b",
  markedPages: [3],
  locked: true,
});
selection = reduceSelection(selection, { type: "hover_chunk", chunkId: "chunk-a" });
assert.deepEqual(
  resolveSelection(selection, chunks).sourceSegmentIds,
  ["segment-b"],
  "a lock remains authoritative while hover changes",
);
selection = reduceSelection(selection, { type: "escape" });
assert.deepEqual(resolveSelection(selection, chunks), {
  chunkIds: [],
  sourceSegmentIds: [],
  firstSourceSegmentId: null,
  markedPages: [],
  locked: false,
});

console.log("V2.1 viewer model tests passed");
