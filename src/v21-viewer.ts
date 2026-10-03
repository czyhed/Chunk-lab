import type {
  Bbox,
  BboxEvidence,
  LocationQuality,
  MappingQuality,
  SourceViewKind,
} from "./v21-provenance.js";

export type ViewerFormat =
  | "pdf"
  | "png"
  | "jpg"
  | "jpeg"
  | "docx"
  | "pptx"
  | "xlsx"
  | "md"
  | "txt";

export type ViewerSourceViewKind = SourceViewKind | "markdown_rendered";

export type SourceViewAvailability = {
  format: ViewerFormat;
  originalAvailable?: boolean;
  sourceAvailable?: boolean;
  renderedAvailable?: boolean;
  parsedAvailable?: boolean;
  visualCopyState?: "not_requested" | "generating" | "ready" | "failed";
};

export type ViewerSourceSegment = {
  sourceSegmentId: string;
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
  bboxEvidence?: BboxEvidence;
  visualCopyVersion?: string;
};

export type ViewerChunk = {
  chunkId: string;
  sourceSegments: ViewerSourceSegment[];
};

export type ViewerOverlay = {
  sourceSegmentId: string;
  page: number;
  bbox: Bbox;
  pageWidth: number;
  pageHeight: number;
};

export type ViewerAssetVersions = {
  sourceDocumentVersion: string;
  visualCopyVersion?: string;
};

export type ViewerZoom =
  | { mode: "fit"; percent: null }
  | { mode: "actual"; percent: 100 }
  | { mode: "custom"; percent: number };

export type ViewerSelectionState = {
  hover: SelectionTarget | null;
  lock: SelectionTarget | null;
};

export type ViewerSelectionAction =
  | { type: "hover_chunk"; chunkId: string }
  | { type: "hover_source"; sourceSegmentId: string }
  | { type: "lock_chunk"; chunkId: string }
  | { type: "lock_source"; sourceSegmentId: string }
  | { type: "clear_hover" }
  | { type: "escape" };

type SelectionTarget =
  | { kind: "chunk"; id: string }
  | { kind: "source"; id: string };

export type ResolvedViewerSelection = {
  chunkIds: string[];
  sourceSegmentIds: string[];
  firstSourceSegmentId: string | null;
  markedPages: number[];
  locked: boolean;
};

export function availableSourceViews(
  availability: SourceViewAvailability,
): ViewerSourceViewKind[] {
  const views: ViewerSourceViewKind[] = [];
  if (
    ["pdf", "png", "jpg", "jpeg"].includes(availability.format) &&
    availability.originalAvailable
  ) views.push("original_file");
  if (
    ["docx", "pptx", "xlsx"].includes(availability.format) &&
    availability.visualCopyState === "ready"
  ) views.push("visual_copy");
  if (availability.format === "md" && availability.sourceAvailable)
    views.push("markdown_source");
  if (availability.format === "md" && availability.renderedAvailable)
    views.push("markdown_rendered");
  if (availability.format === "txt" && availability.sourceAvailable)
    views.push("txt_source");
  if (availability.parsedAvailable) views.push("parsed_document");
  return views;
}

export function overlayForSegment(
  segment: ViewerSourceSegment,
  current: ViewerAssetVersions,
): ViewerOverlay | null {
  const evidence = segment.bboxEvidence;
  if (
    segment.locationQuality !== "exact" ||
    (segment.sourceViewKind !== "original_file" && segment.sourceViewKind !== "visual_copy") ||
    segment.sourceDocumentVersion !== current.sourceDocumentVersion ||
    !segment.bbox ||
    !evidence ||
    !Number.isSafeInteger(segment.page) ||
    segment.page! < 1 ||
    evidence.page !== segment.page ||
    !validPageEvidence(evidence) ||
    !bboxWithinPage(segment.bbox, evidence.pageWidth, evidence.pageHeight)
  ) return null;

  if (
    segment.sourceViewKind === "original_file" &&
    evidence.sourceDocumentVersion !== current.sourceDocumentVersion
  ) return null;
  if (
    segment.sourceViewKind === "visual_copy" &&
    (!current.visualCopyVersion ||
      segment.visualCopyVersion !== current.visualCopyVersion ||
      evidence.visualCopyVersion !== current.visualCopyVersion)
  ) return null;

  return {
    sourceSegmentId: segment.sourceSegmentId,
    page: segment.page,
    bbox: segment.bbox,
    pageWidth: evidence.pageWidth,
    pageHeight: evidence.pageHeight,
  };
}

export function virtualPageWindow(
  pageCount: number,
  visiblePage: number,
  radius = 1,
): number[] {
  const current = setVisiblePage(visiblePage, pageCount);
  const safeRadius = Number.isSafeInteger(radius) && radius >= 0 ? radius : 1;
  const start = Math.max(1, current - safeRadius);
  const end = Math.min(pageCount, current + safeRadius);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

export function setVisiblePage(requestedPage: number, pageCount: number): number {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1)
    throw new Error("pageCount must be a positive integer");
  if (!Number.isFinite(requestedPage)) return 1;
  return Math.min(pageCount, Math.max(1, Math.trunc(requestedPage)));
}

export function setZoom(
  mode: "fit" | "actual" | "custom",
  requestedPercent?: number,
): ViewerZoom {
  if (mode === "fit") return { mode, percent: null };
  if (mode === "actual") return { mode, percent: 100 };
  if (!Number.isFinite(requestedPercent))
    throw new Error("custom zoom requires a finite percent");
  return {
    mode,
    percent: Math.min(400, Math.max(25, Math.round(requestedPercent!))),
  };
}

export function createSelectionState(): ViewerSelectionState {
  return { hover: null, lock: null };
}

export function reduceSelection(
  state: ViewerSelectionState,
  action: ViewerSelectionAction,
): ViewerSelectionState {
  switch (action.type) {
    case "hover_chunk":
      return { ...state, hover: { kind: "chunk", id: action.chunkId } };
    case "hover_source":
      return { ...state, hover: { kind: "source", id: action.sourceSegmentId } };
    case "lock_chunk":
      return { ...state, lock: { kind: "chunk", id: action.chunkId } };
    case "lock_source":
      return { ...state, lock: { kind: "source", id: action.sourceSegmentId } };
    case "clear_hover":
      return { ...state, hover: null };
    case "escape":
      return createSelectionState();
  }
}

export function resolveSelection(
  state: ViewerSelectionState,
  chunks: ViewerChunk[],
): ResolvedViewerSelection {
  const target = state.lock ?? state.hover;
  if (!target)
    return {
      chunkIds: [],
      sourceSegmentIds: [],
      firstSourceSegmentId: null,
      markedPages: [],
      locked: false,
    };

  const selectedChunks = target.kind === "chunk"
    ? chunks.filter((chunk) => chunk.chunkId === target.id)
    : chunks.filter((chunk) =>
        chunk.sourceSegments.some((segment) => segment.sourceSegmentId === target.id),
      );
  const selectedSegments = target.kind === "chunk"
    ? selectedChunks.flatMap((chunk) => chunk.sourceSegments)
    : selectedChunks
        .flatMap((chunk) => chunk.sourceSegments)
        .filter((segment) => segment.sourceSegmentId === target.id);
  const uniqueSegments = uniqueById(selectedSegments);
  return {
    chunkIds: selectedChunks.map((chunk) => chunk.chunkId),
    sourceSegmentIds: uniqueSegments.map((segment) => segment.sourceSegmentId),
    firstSourceSegmentId: uniqueSegments[0]?.sourceSegmentId ?? null,
    markedPages: [
      ...new Set(
        uniqueSegments
          .map((segment) => segment.page)
          .filter((page): page is number => page !== null),
      ),
    ].sort((left, right) => left - right),
    locked: state.lock !== null,
  };
}

function validPageEvidence(evidence: BboxEvidence): boolean {
  return (
    Number.isFinite(evidence.pageWidth) &&
    evidence.pageWidth > 0 &&
    Number.isFinite(evidence.pageHeight) &&
    evidence.pageHeight > 0 &&
    evidence.coordinateUnit.length > 0 &&
    Number.isFinite(evidence.orientation) &&
    evidence.transform.length === 6 &&
    evidence.transform.every(Number.isFinite) &&
    evidence.mappingVersion.length > 0
  );
}

function bboxWithinPage(bbox: Bbox, width: number, height: number): boolean {
  const [left, top, right, bottom] = bbox;
  return (
    bbox.every(Number.isFinite) &&
    left >= 0 &&
    top >= 0 &&
    right > left &&
    bottom > top &&
    right <= width &&
    bottom <= height
  );
}

function uniqueById(segments: ViewerSourceSegment[]): ViewerSourceSegment[] {
  const seen = new Set<string>();
  return segments.filter((segment) => {
    if (seen.has(segment.sourceSegmentId)) return false;
    seen.add(segment.sourceSegmentId);
    return true;
  });
}
