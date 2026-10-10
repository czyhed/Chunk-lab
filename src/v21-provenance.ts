import type { ContentBlock, ContentGroup } from "./v21-contract.js";

export type SourceViewKind =
  | "original_file"
  | "visual_copy"
  | "parsed_document"
  | "markdown_source"
  | "txt_source";

export type MappingQuality = "exact" | "cell" | "row" | "block-only";
export type LocationQuality = "exact" | "page_only" | "parsed_only" | "unavailable";
export type Bbox = readonly [number, number, number, number];

export type ProvenancedContentBlock = ContentBlock & {
  sourceDocumentVersion: string;
  contentBlockId: string;
  contentBlockIdNamespace: string;
};

export type SourceSegmentV21 = {
  sourceDocumentVersion: string;
  parsedDocumentVersion: string;
  contentBlockId: string;
  rawBlockId: string | null;
  sourceViewKind: SourceViewKind;
  page: number | null;
  bbox: Bbox | null;
  sourceStart: number | null;
  sourceEnd: number | null;
  chunkStart: number | null;
  chunkEnd: number | null;
  isOverlap: boolean;
  mappingQuality: MappingQuality;
  locationQuality: LocationQuality;
};

export type BboxEvidence = {
  page: number;
  pageWidth: number;
  pageHeight: number;
  coordinateUnit: string;
  orientation: number;
  transform: readonly [number, number, number, number, number, number];
  mappingVersion: string;
  sourceDocumentVersion?: string;
  visualCopyVersion?: string;
  coordinateOrigin?: "top-left" | "bottom-left";
  mediaBox?: Bbox;
  cropBox?: Bbox;
};

export type SourceSegmentInput = {
  block: ProvenancedContentBlock;
  sourceViewKind: SourceViewKind;
  page: number | null;
  bbox: Bbox | null;
  sourceStart: number | null;
  sourceEnd: number | null;
  chunkStart: number | null;
  chunkEnd: number | null;
  isOverlap: boolean;
  mappingQuality: MappingQuality;
  locationQuality: LocationQuality;
  bboxEvidence?: BboxEvidence;
  visualCopyVersion?: string;
};

export type OrdinarySemanticBlock = Omit<
  ProvenancedContentBlock,
  "raw" | "display"
>;

export type TableRowGroup = {
  rowGroupIndex: number;
  startRow: number;
  endRow: number;
  pages: number[];
  repeatedHeaderRows: number;
};

export type CrossPageTableGroup = ContentGroup & {
  kind: "table";
  tableId: string;
  rowGroups: TableRowGroup[];
};

export function buildProvenancedContentBlock(
  block: ContentBlock,
  input: { sourceDocumentVersion: string; blockIndex: number },
): ProvenancedContentBlock {
  if (!input.sourceDocumentVersion) throw new Error("sourceDocumentVersion is required");
  if (!Number.isSafeInteger(input.blockIndex) || input.blockIndex < 0)
    throw new Error("blockIndex must be a non-negative integer");
  const contentBlockIdNamespace = `${block.parsedDocumentVersion}:content-block`;
  return {
    ...block,
    sourceDocumentVersion: input.sourceDocumentVersion,
    contentBlockId: `${contentBlockIdNamespace}:${String(input.blockIndex + 1).padStart(6, "0")}`,
    contentBlockIdNamespace,
  };
}

export function toOrdinarySemanticBlock(
  block: ProvenancedContentBlock,
): OrdinarySemanticBlock {
  const { raw: _raw, display: _display, ...semantic } = block;
  return semantic;
}

export function buildSourceSegment(input: SourceSegmentInput): SourceSegmentV21 {
  validateRangePair("source", input.sourceStart, input.sourceEnd, input.block.searchText.length);
  validateRangePair("chunk", input.chunkStart, input.chunkEnd);
  validateLocation(input);
  return {
    sourceDocumentVersion: input.block.sourceDocumentVersion,
    parsedDocumentVersion: input.block.parsedDocumentVersion,
    contentBlockId: input.block.contentBlockId,
    rawBlockId: input.block.rawBlockId,
    sourceViewKind: input.sourceViewKind,
    page: input.page,
    bbox: input.bbox,
    sourceStart: input.sourceStart,
    sourceEnd: input.sourceEnd,
    chunkStart: input.chunkStart,
    chunkEnd: input.chunkEnd,
    isOverlap: input.isOverlap,
    mappingQuality: input.mappingQuality,
    locationQuality: input.locationQuality,
  };
}

export function buildCrossPageTableGroup(input: {
  contentGroupId: string;
  tableId: string;
  contentBlockIds: string[];
  rowGroups: TableRowGroup[];
}): CrossPageTableGroup {
  if (!input.contentGroupId || !input.tableId || input.contentBlockIds.length === 0)
    throw new Error("table group identity and content blocks are required");
  let previousEnd = 0;
  input.rowGroups.forEach((group, index) => {
    if (
      group.rowGroupIndex !== index ||
      group.startRow !== previousEnd ||
      group.endRow <= group.startRow ||
      group.repeatedHeaderRows < 0 ||
      group.pages.length === 0 ||
      group.pages.some((page) => !Number.isSafeInteger(page) || page < 1)
    ) throw new Error("table row groups must be ordered, contiguous, and page-located");
    previousEnd = group.endRow;
  });
  return {
    contentGroupId: input.contentGroupId,
    kind: "table",
    tableId: input.tableId,
    contentBlockIds: [...input.contentBlockIds],
    protectedFromTextSplitting: true,
    rowGroups: structuredClone(input.rowGroups),
  };
}

function validateLocation(input: SourceSegmentInput): void {
  if (input.locationQuality === "unavailable") {
    if (input.page !== null || input.bbox !== null)
      throw new Error("unavailable location cannot contain page or bbox evidence");
    return;
  }
  if (input.locationQuality === "parsed_only") {
    if (input.sourceViewKind !== "parsed_document" || input.page !== null || input.bbox !== null)
      throw new Error("parsed_only location must target parsed_document without page coordinates");
    return;
  }
  if (input.sourceViewKind === "markdown_source" || input.sourceViewKind === "txt_source") {
    if (
      input.locationQuality !== "exact" ||
      input.page !== null ||
      input.bbox !== null ||
      input.sourceStart === null ||
      input.sourceEnd === null
    ) throw new Error("source text exact location requires verified character ranges only");
    return;
  }
  if (input.sourceViewKind !== "original_file" && input.sourceViewKind !== "visual_copy")
    throw new Error("page location requires an original_file or visual_copy view");
  if (!Number.isSafeInteger(input.page) || input.page! < 1)
    throw new Error("page location requires a positive page number");
  if (input.locationQuality === "page_only") {
    if (input.bbox !== null) throw new Error("page_only location cannot claim a bbox");
    return;
  }
  validateExactBbox(input);
}

function validateExactBbox(input: SourceSegmentInput): void {
  const evidence = input.bboxEvidence;
  if (!input.bbox || !evidence) throw new Error("exact page location requires bbox evidence");
  if (
    evidence.page !== input.page ||
    !Number.isFinite(evidence.pageWidth) ||
    !Number.isFinite(evidence.pageHeight) ||
    evidence.pageWidth <= 0 ||
    evidence.pageHeight <= 0 ||
    !evidence.coordinateUnit ||
    !Number.isFinite(evidence.orientation) ||
    !evidence.mappingVersion ||
    evidence.transform.some((value) => !Number.isFinite(value))
  ) throw new Error("bbox evidence is incomplete");
  if (
    input.sourceViewKind === "original_file" &&
    evidence.sourceDocumentVersion !== input.block.sourceDocumentVersion
  ) throw new Error("bbox evidence source document version does not match");
  if (
    input.sourceViewKind === "visual_copy" &&
    (!input.visualCopyVersion || evidence.visualCopyVersion !== input.visualCopyVersion)
  ) throw new Error("bbox evidence visual copy version does not match");
  const [left, top, right, bottom] = input.bbox;
  if (
    !input.bbox.every(Number.isFinite) ||
    left < 0 || top < 0 || right <= left || bottom <= top ||
    right > evidence.pageWidth || bottom > evidence.pageHeight
  ) throw new Error("bbox is outside page bounds");
}

function validateRangePair(
  name: string,
  start: number | null,
  end: number | null,
  maximum = Number.MAX_SAFE_INTEGER,
): void {
  if (start === null && end === null) return;
  if (
    start === null || end === null ||
    !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
    start < 0 || end < start || end > maximum
  ) throw new Error(`${name} range must be a valid UTF-16 half-open range or null`);
}
