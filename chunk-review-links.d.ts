export type ReviewLinkChunk = {
  id: string;
  sourceSegments: Array<{ blockId?: string; contentBlockId?: string }>;
  manualAnnotationIds?: string[];
};

export type ReviewLinkSelection = {
  sourceIds: string[];
  chunkIds: string[];
  primaryChunkId: string | null;
  missingSourceIds: string[];
};

export function linkedTargetsForSource(
  chunks: ReviewLinkChunk[],
  sourceId: string,
): { chunkIds: string[]; primaryChunkId: string | null; missing: boolean };

export function linkedTargetsForChunk(
  chunks: ReviewLinkChunk[],
  chunkId: string,
): { sourceIds: string[]; chunkIds: string[]; primaryChunkId: string | null };

export function scrollReviewTargetIntoView(
  element: Pick<Element, "scrollIntoView"> | null | undefined,
  block?: ScrollLogicalPosition,
): boolean;

export function updateReviewLinkSelection(
  chunks: ReviewLinkChunk[],
  current: ReviewLinkSelection | null,
  target: { kind: "source" | "chunk"; id: string },
  additive?: boolean,
): ReviewLinkSelection;
