import { SentenceSplitter, TokenTextSplitter, similarity } from "llamaindex";
import type { EmbedTexts } from "./embedding.js";
import type { ImageObjectReference } from "./image-object-store.js";
import type { AssetDescriptor } from "./asset-contract.js";

export type BlockType = "text" | "table" | "image";
export type BlockRole =
  | "heading"
  | "paragraph"
  | "list"
  | "caption"
  | "warning"
  | "table"
  | "image";

export type ParsedBlock = {
  id: string;
  type: BlockType;
  text: string;
  page: number | null;
  bbox: number[] | null;
  readingOrder?: number;
  parentId?: string;
  role?: BlockRole;
  groupId?: string;
  productIdentity?: string;
  sourceBackend?: string;
  sourceVersion?: string;
  imagePath?: string;
};

export type SourceSegment = {
  blockId: string;
  page: number | null;
  bbox: number[] | null;
  sourceStart: number;
  sourceEnd: number;
  chunkStart: number;
  chunkEnd: number;
  isOverlap: boolean;
};

export type QualityFlag =
  | "oversized"
  | "undersized"
  | "semantic_budget_boundary"
  | "reading_order_uncertain";

export type Chunk = {
  id: string;
  parentChunk?: { id: string; text: string; sourceSegments: SourceSegment[]; childCount: number };
  type: BlockType;
  automaticType?: string;
  finalType?: string;
  text: string;
  automaticText: string;
  finalText: string;
  page: number | null;
  bbox: number[] | null;
  imagePath?: string;
  sourceSegments: SourceSegment[];
  sourceBlockIds: string[];
  tokenCount: number;
  qualityFlags: QualityFlag[];
  parentSectionId?: string;
  productIdentity?: string;
  relatedChunkIds: string[];
  tableId?: string;
  imageId?: string;
  imageObjectReference?: ImageObjectReference;
  pageRenderObjectReference?: AssetDescriptor;
  excluded: boolean;
  /** Reviewed SPU routing facts. Omitted on legacy chunks. */
  scope?: "assigned" | "common" | "unassigned" | "conflicted";
  targetSpuIds?: string[];
  contextText: string;
  contextCandidateReasons: string[];
  contextReviewState:
    | "not_generated"
    | "generating"
    | "awaiting_review"
    | "confirmed"
    | "human_modified"
    | "failed"
    | "stale";
  contextError?: string;
  contextModel?: string;
  contextProfileId?: string;
  contextProfileName?: string;
  contextPromptVersion?: string;
  contextGeneratedAt?: string;
  contextScope?: string[];
  skippedNeighborReasons?: Array<{ chunkId: string; reasons: string[] }>;
  revisions: Array<{
    type: "text" | "type" | "split" | "merge" | "exclude" | "source" | "manual_transcription";
    at: string;
    before?: string;
    after?: string;
    annotationId?: string;
    source?: string;
  }>;
};

export type ChunkRequest = {
  strategy: "structure" | "sentence" | "token" | "semantic" | "parent-child";
  parentChunkSize?: number;
  chunkSize: number;
  chunkOverlap: number;
  bufferSize: number;
  breakpointPercentile: number;
  semanticMaxChunkSize: number;
  imagePolicy: "summary" | "reference" | "exclude";
};

export type SemanticSignal = {
  sentence: string;
  index: number;
  distance: number;
  isBreakpoint: boolean;
};

export type ChunkPreviewMetrics = {
  chunkCount: number;
  token: { minimum: number; average: number; maximum: number };
  tokenDistribution: {
    under80: number;
    "80to255": number;
    "256to511": number;
    "512to1023": number;
    "1024plus": number;
  };
  oversizedCount: number;
  undersizedCount: number;
  actualOverlapRatio: number;
  crossPageCount: number;
  typeCounts: Record<BlockType, number>;
  missingProductIdentityCount: number;
  contextCandidateCount: number;
};

export type ChunkPreview = {
  chunks: Chunk[];
  semanticSignals: Array<SemanticSignal & { flowId: string }>;
  metrics: ChunkPreviewMetrics;
};

type FlowSpan = { block: ParsedBlock; start: number; end: number };
type TextFlow = { id: string; text: string; spans: FlowSpan[] };
type ProtectedGroup = { id: string; blocks: ParsedBlock[] };
type LocatedPart = { text: string; start: number; end: number };

const tokenCounter = new SentenceSplitter({ chunkSize: 1024, chunkOverlap: 0 });

export function countTokens(text: string): number {
  return tokenCounter.tokenSize(text);
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s*|\n+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function analyzeSemanticText(
  text: string,
  bufferSize: number,
  percentile: number,
  embedTexts: EmbedTexts,
): Promise<SemanticSignal[]> {
  const sentences = splitSentences(text);
  if (sentences.length < 2)
    return sentences.map((sentence, index) => ({
      sentence,
      index,
      distance: 0,
      isBreakpoint: false,
    }));
  const windows = sentences.map((_, index) =>
    sentences
      .slice(
        Math.max(0, index - bufferSize),
        Math.min(sentences.length, index + bufferSize + 1),
      )
      .join(" "),
  );
  const embeddings = await embedTexts(windows);
  const distances = windows
    .slice(0, -1)
    .map(
      (_, index) => 1 - similarity(embeddings[index], embeddings[index + 1]),
    );
  const sorted = [...distances].sort((a, b) => a - b);
  const cutoff =
    sorted[
      Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1),
      )
    ];
  const hasDistanceVariation = sorted[0] !== sorted.at(-1);
  return sentences.map((sentence, index) => ({
    sentence,
    index,
    distance: distances[index] ?? 0,
    isBreakpoint:
      hasDistanceVariation &&
      index < distances.length &&
      distances[index] >= cutoff,
  }));
}

function orderedBlocks(blocks: ParsedBlock[]): ParsedBlock[] {
  return blocks
    .map((block, inputOrder) => ({ block, inputOrder }))
    .sort(
      (left, right) => {
        if (left.block.page !== null && right.block.page !== null) {
          const pageDifference = left.block.page - right.block.page;
          if (pageDifference) return pageDifference;
        } else if (left.block.page !== right.block.page) {
          return left.block.page === null ? 1 : -1;
        }
        return (
          (left.block.readingOrder ?? left.inputOrder) -
          (right.block.readingOrder ?? right.inputOrder)
        );
      },
    )
    .map(({ block }) => block);
}

function assembleTextFlows(
  blocks: ParsedBlock[],
  structureAware = false,
): Array<TextFlow | ParsedBlock | ProtectedGroup> {
  const protectedGroupIds = new Set(
    blocks
      .filter(
        (block) =>
          block.groupId &&
          (block.type !== "text" ||
            block.role === "warning" ||
            block.role === "caption"),
      )
      .map((block) => block.groupId!),
  );
  const units: Array<TextFlow | ParsedBlock | ProtectedGroup> = [];
  let current: TextFlow | null = null;
  let protectedGroup: ProtectedGroup | null = null;
  let flowIndex = 0;
  for (const block of orderedBlocks(blocks)) {
    const existingProtectedGroup = protectedGroup as ProtectedGroup | null;
    const protectedByGroup =
      Boolean(block.groupId) && protectedGroupIds.has(block.groupId!);
    if (protectedByGroup) {
      current = null;
      if (existingProtectedGroup && existingProtectedGroup.id === block.groupId)
        existingProtectedGroup.blocks.push(block);
      else {
        protectedGroup = { id: block.groupId!, blocks: [block] };
        units.push(protectedGroup);
      }
      continue;
    }
    protectedGroup = null;
    if (block.type !== "text" || block.role === "warning") {
      current = null;
      units.push(block);
      continue;
    }
    if (!block.text.trim()) continue;
    const previousIdentity = current?.spans.at(-1)?.block.productIdentity;
    if (
      (block.role === "heading" && current?.spans.length) ||
      (structureAware &&
        previousIdentity &&
        block.productIdentity &&
        previousIdentity !== block.productIdentity)
    )
      current = null;
    if (!current) {
      current = { id: `flow-${++flowIndex}`, text: "", spans: [] };
      units.push(current);
    }
    if (current.text) current.text += "\n\n";
    const start = current.text.length;
    current.text += block.text;
    current.spans.push({ block, start, end: current.text.length });
  }
  return units;
}

function locateParts(flowText: string, parts: string[]): LocatedPart[] {
  let previousStart = -1;
  let previousEnd = -1;
  return parts.map((part) => {
    const candidates: number[] = [];
    let cursor = flowText.indexOf(part);
    while (cursor >= 0) {
      candidates.push(cursor);
      cursor = flowText.indexOf(part, cursor + 1);
    }
    const start = candidates.find(
      (candidate) =>
        candidate > previousStart ||
        (candidate === previousStart && candidate + part.length > previousEnd),
    );
    if (start === undefined)
      throw new Error("Splitter output cannot be mapped exactly to source text");
    previousStart = start;
    previousEnd = start + part.length;
    return { text: part, start, end: start + part.length };
  });
}

function addTokenOverlap(
  flowText: string,
  parts: LocatedPart[],
  overlapBudget: number,
  chunkBudget: number,
): LocatedPart[] {
  if (!overlapBudget) return parts;
  return parts.map((part, index) => {
    if (!index) return part;
    const previous = parts[index - 1];
    let bestStart = part.start;
    const prefix = flowText.slice(previous.start, previous.end);
    const boundaries = [previous.end];
    let offset = 0;
    for (const character of prefix) {
      offset += character.length;
      boundaries.push(previous.start + offset);
    }
    for (const candidate of boundaries.reverse()) {
      if (candidate >= previous.end) continue;
      const overlapText = flowText.slice(candidate, previous.end);
      const expandedText = flowText.slice(candidate, part.end);
      if (
        countTokens(overlapText) <= overlapBudget &&
        countTokens(expandedText) <= chunkBudget
      )
        bestStart = candidate;
      else if (bestStart < part.start) break;
    }
    return {
      text: flowText.slice(bestStart, part.end),
      start: bestStart,
      end: part.end,
    };
  });
}

function intervalOverlap(
  blockId: string,
  start: number,
  end: number,
  previous: SourceSegment[],
): Array<[number, number]> {
  return previous
    .filter(
      (segment) =>
        segment.blockId === blockId &&
        segment.sourceStart < end &&
        segment.sourceEnd > start,
    )
    .map(
      (segment) =>
        [
          Math.max(start, segment.sourceStart),
          Math.min(end, segment.sourceEnd),
        ] as [number, number],
    )
    .sort((left, right) => left[0] - right[0]);
}

function segmentRange(
  span: FlowSpan,
  part: LocatedPart,
  previous: SourceSegment[],
): SourceSegment[] {
  const globalStart = Math.max(span.start, part.start);
  const globalEnd = Math.min(span.end, part.end);
  if (globalStart >= globalEnd) return [];
  const sourceStart = globalStart - span.start;
  const sourceEnd = globalEnd - span.start;
  const overlaps = intervalOverlap(span.block.id, sourceStart, sourceEnd, previous);
  const boundaries = new Set([sourceStart, sourceEnd]);
  overlaps.forEach(([start, end]) => {
    boundaries.add(start);
    boundaries.add(end);
  });
  const points = [...boundaries].sort((left, right) => left - right);
  return points.slice(0, -1).map((start, index) => {
    const end = points[index + 1];
    const isOverlap = overlaps.some(
      ([overlapStart, overlapEnd]) =>
        overlapStart <= start && overlapEnd >= end,
    );
    return {
      blockId: span.block.id,
      page: span.block.page,
      bbox: span.block.bbox,
      sourceStart: start,
      sourceEnd: end,
      chunkStart: span.start + start - part.start,
      chunkEnd: span.start + end - part.start,
      isOverlap,
    };
  });
}

function textChunk(
  flow: TextFlow,
  part: LocatedPart,
  index: number,
  previous: SourceSegment[],
  extraFlags: QualityFlag[] = [],
): Chunk {
  const sourceSegments = flow.spans.flatMap((span) =>
    segmentRange(span, part, previous),
  );
  if (!sourceSegments.length)
    throw new Error("Chunk has no exact Source Segment");
  const firstBlock = flow.spans.find((span) =>
    sourceSegments.some((segment) => segment.blockId === span.block.id),
  )?.block;
  const tokenCount = countTokens(part.text);
  return {
    id: `${flow.id}-${index + 1}`,
    type: "text",
    text: part.text,
    automaticText: part.text,
    finalText: part.text,
    page: firstBlock?.page ?? null,
    bbox: firstBlock?.bbox ?? null,
    sourceSegments,
    sourceBlockIds: [...new Set(sourceSegments.map((segment) => segment.blockId))],
    tokenCount,
    qualityFlags: [
      ...(tokenCount < 80 ? (["undersized"] as QualityFlag[]) : []),
      ...extraFlags,
    ],
    parentSectionId: firstBlock?.parentId,
    productIdentity: firstBlock?.productIdentity,
    relatedChunkIds: [],
    excluded: false,
    contextText: "",
    contextCandidateReasons: [],
    contextReviewState: "not_generated",
    revisions: [],
  };
}

function protectedChunk(block: ParsedBlock, index: number): Chunk {
  const tokenCount = countTokens(block.text);
  const sourceSegments: SourceSegment[] = [
    {
      blockId: block.id,
      page: block.page,
      bbox: block.bbox,
      sourceStart: 0,
      sourceEnd: block.text.length,
      chunkStart: 0,
      chunkEnd: block.text.length,
      isOverlap: false,
    },
  ];
  return {
    id: `${block.id}-${index + 1}`,
    type: block.type,
    text: block.text,
    automaticText: block.text,
    finalText: block.text,
    page: block.page,
    bbox: block.bbox,
    imagePath: block.imagePath,
    sourceSegments,
    sourceBlockIds: [block.id],
    tokenCount,
    qualityFlags: tokenCount < 80 ? ["undersized"] : [],
    parentSectionId: block.parentId,
    productIdentity: block.productIdentity,
    relatedChunkIds: [],
    excluded: false,
    contextText: "",
    contextCandidateReasons: [],
    contextReviewState: "not_generated",
    revisions: [],
  };
}

function protectedGroupChunk(group: ProtectedGroup, index: number): Chunk {
  const type = protectedGroupType(group);
  let text = "";
  const sourceSegments: SourceSegment[] = [];
  group.blocks.forEach((block) => {
    if (text && block.text) text += "\n\n";
    const chunkStart = text.length;
    text += block.text;
    sourceSegments.push({
      blockId: block.id,
      page: block.page,
      bbox: block.bbox,
      sourceStart: 0,
      sourceEnd: block.text.length,
      chunkStart,
      chunkEnd: chunkStart + block.text.length,
      isOverlap: false,
    });
  });
  const representative = group.blocks.find((block) => block.type === type) ?? group.blocks[0];
  const tokenCount = countTokens(text);
  return {
    id: `${group.id}-${index + 1}`,
    type,
    text,
    automaticText: text,
    finalText: text,
    page: representative.page,
    bbox: representative.bbox,
    imagePath: group.blocks.find((block) => block.imagePath)?.imagePath,
    sourceSegments,
    sourceBlockIds: group.blocks.map((block) => block.id),
    tokenCount,
    qualityFlags: tokenCount < 80 ? ["undersized"] : [],
    parentSectionId: group.blocks.find((block) => block.parentId)?.parentId,
    productIdentity: group.blocks.find((block) => block.productIdentity)?.productIdentity,
    relatedChunkIds: [],
    ...(type === "table" ? { tableId: group.id } : {}),
    ...(type === "image" ? { imageId: group.id } : {}),
    excluded: false,
    contextText: "",
    contextCandidateReasons: [],
    contextReviewState: "not_generated",
    revisions: [],
  };
}

function protectedGroupType(group: ProtectedGroup): BlockType {
  return group.blocks.some((block) => block.type === "table")
    ? "table"
    : group.blocks.some((block) => block.type === "image")
      ? "image"
      : "text";
}

function validateRequest(request: ChunkRequest): void {
  if (request.chunkOverlap >= request.chunkSize)
    throw new Error("Chunk overlap must be less than chunk size");
  if (request.strategy === "parent-child" &&
      (!Number.isInteger(request.parentChunkSize ?? 1536) || (request.parentChunkSize ?? 1536) <= request.chunkSize || (request.parentChunkSize ?? 1536) > 8192))
    throw Object.assign(new Error("父块大小必须大于子块大小，且不超过 8192 Token"), { statusCode: 400 });
}

function sourceSegmentForBlock(
  block: ParsedBlock,
  sourceStart: number,
  sourceEnd: number,
  chunkStart: number,
  isOverlap = false,
): SourceSegment {
  return {
    blockId: block.id,
    page: block.page,
    bbox: block.bbox,
    sourceStart,
    sourceEnd,
    chunkStart,
    chunkEnd: chunkStart + sourceEnd - sourceStart,
    isOverlap,
  };
}

function baseProtectedChunk(
  group: ProtectedGroup,
  id: string,
  type: BlockType,
  text: string,
  sourceSegments: SourceSegment[],
  qualityFlags: QualityFlag[],
): Chunk {
  const representative =
    group.blocks.find((block) => block.type === type) ?? group.blocks[0];
  return {
    id,
    type,
    text,
    automaticText: text,
    finalText: text,
    page: representative.page,
    bbox: representative.bbox,
    imagePath: group.blocks.find((block) => block.imagePath)?.imagePath,
    sourceSegments,
    sourceBlockIds: [...new Set(sourceSegments.map((segment) => segment.blockId))],
    tokenCount: countTokens(text),
    qualityFlags,
    parentSectionId: group.blocks.find((block) => block.parentId)?.parentId,
    productIdentity: group.blocks.find((block) => block.productIdentity)?.productIdentity,
    relatedChunkIds: [],
    ...(type === "table" ? { tableId: group.id } : {}),
    ...(type === "image" ? { imageId: group.id } : {}),
    excluded: false,
    contextText: "",
    contextCandidateReasons: [],
    contextReviewState: "not_generated",
    revisions: [],
  };
}

function splitTableGroup(group: ProtectedGroup, budget: number): Chunk[] {
  const tables = group.blocks.filter((block) => block.type === "table");
  const table = tables[0];
  if (!table) return [protectedGroupChunk(group, 0)];
  if (tables.length > 1) {
    const combined = protectedGroupChunk(group, 0);
    if (combined.tokenCount <= budget) return [combined];
    return tables.flatMap((block) =>
      splitTableGroup({ id: group.id, blocks: [block] }, budget),
    );
  }
  const lines = table.text.split("\n");
  if (lines.length < 3 || !/^\s*\|?.*-{3}/.test(lines[1])) {
    const chunk = protectedGroupChunk(group, 0);
    if (chunk.tokenCount > budget) chunk.qualityFlags.push("oversized");
    return [chunk];
  }
  const headerLines = lines.slice(0, 2);
  const header = headerLines.join("\n");
  const rows = lines.slice(2);
  const starts: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    starts.push(cursor);
    cursor += line.length + 1;
  }
  const rowGroups: Array<{ first: number; rows: string[] }> = [];
  let currentRows: string[] = [];
  let firstRow = 2;
  rows.forEach((row, rowIndex) => {
    const candidate = [...currentRows, row];
    if (
      currentRows.length &&
      countTokens(`${header}\n${candidate.join("\n")}`) > budget
    ) {
      rowGroups.push({ first: firstRow, rows: currentRows });
      currentRows = [row];
      firstRow = rowIndex + 2;
    } else currentRows = candidate;
  });
  if (currentRows.length) rowGroups.push({ first: firstRow, rows: currentRows });
  return rowGroups.map((rowGroup, index) => {
    const text = `${header}\n${rowGroup.rows.join("\n")}`;
    const rowStart = starts[rowGroup.first];
    const lastLineIndex = rowGroup.first + rowGroup.rows.length - 1;
    const rowEnd = starts[lastLineIndex] + lines[lastLineIndex].length;
    const segments = [
      sourceSegmentForBlock(table, 0, header.length, 0, index > 0),
      sourceSegmentForBlock(table, rowStart, rowEnd, header.length + 1),
    ];
    const flags: QualityFlag[] = countTokens(text) > budget ? ["oversized"] : [];
    return baseProtectedChunk(
      group,
      `${group.id}-rows-${index + 1}`,
      "table",
      text,
      segments,
      flags,
    );
  });
}

function captionParts(blocks: ParsedBlock[], budget: number): Array<{
  text: string;
  segments: SourceSegment[];
}> {
  const flow: TextFlow = { id: "protected-copy", text: "", spans: [] };
  for (const block of blocks) {
    if (!block.text) continue;
    if (flow.text) flow.text += "\n\n";
    const start = flow.text.length;
    flow.text += block.text;
    flow.spans.push({ block, start, end: flow.text.length });
  }
  if (!flow.text) return [{ text: "", segments: [] }];
  const splitter = new SentenceSplitter({ chunkSize: budget, chunkOverlap: 0 });
  return locateParts(flow.text, splitter.splitText(flow.text)).map((part) => ({
    text: part.text,
    segments: flow.spans.flatMap((span) => segmentRange(span, part, [])),
  }));
}

function splitWarningGroup(group: ProtectedGroup, budget: number): Chunk[] {
  const title = group.blocks.find((block) => block.role === "warning") ?? group.blocks[0];
  const body = group.blocks.filter((block) => block !== title);
  const copyBudget = Math.max(8, budget - countTokens(`${title.text}\n\n`));
  return captionParts(body, copyBudget).map((part, index) => {
    const text = part.text ? `${title.text}\n\n${part.text}` : title.text;
    const titleSegment = sourceSegmentForBlock(
      title,
      0,
      title.text.length,
      0,
      index > 0,
    );
    const shifted = part.segments.map((segment) => ({
      ...segment,
      chunkStart: segment.chunkStart + title.text.length + 2,
      chunkEnd: segment.chunkEnd + title.text.length + 2,
    }));
    return baseProtectedChunk(
      group,
      `${group.id}-warning-${index + 1}`,
      "text",
      text,
      [titleSegment, ...shifted],
      countTokens(text) > budget ? ["oversized"] : [],
    );
  });
}

function splitImageGroup(group: ProtectedGroup, budget: number): Chunk[] {
  const image = group.blocks.find((block) => block.type === "image")!;
  const captions = group.blocks.filter((block) => block !== image);
  return captionParts(captions, budget).map((part, index) => {
    const imageSegment = sourceSegmentForBlock(image, 0, image.text.length, 0, index > 0);
    const sourceOrder = new Map(
      group.blocks.map((block, blockIndex) => [block.id, blockIndex]),
    );
    const sourceSegments = [imageSegment, ...part.segments].sort(
      (left, right) =>
        (sourceOrder.get(left.blockId) ?? 0) -
        (sourceOrder.get(right.blockId) ?? 0),
    );
    return baseProtectedChunk(
      group,
      `${group.id}-image-${index + 1}`,
      "image",
      part.text,
      sourceSegments,
      countTokens(part.text) > budget ? ["oversized"] : [],
    );
  });
}

function splitProtectedGroup(group: ProtectedGroup, budget: number): Chunk[] {
  const type = protectedGroupType(group);
  if (type === "table") return splitTableGroup(group, budget);
  if (type === "image") return splitImageGroup(group, budget);
  if (group.blocks.some((block) => block.role === "warning"))
    return splitWarningGroup(group, budget);
  const chunk = protectedGroupChunk(group, 0);
  if (chunk.tokenCount > budget) chunk.qualityFlags.push("oversized");
  return [chunk];
}

function uncertainReadingOrderIds(blocks: ParsedBlock[]): Set<string> {
  const seen = new Map<string, string>();
  const uncertain = new Set<string>();
  for (const block of blocks) {
    if (block.readingOrder === undefined) continue;
    const key = `${block.page ?? "none"}:${block.readingOrder}`;
    const existing = seen.get(key);
    if (existing) {
      uncertain.add(existing);
      uncertain.add(block.id);
    } else seen.set(key, block.id);
  }
  return uncertain;
}

function applyReadingOrderFlags(chunks: Chunk[], uncertain: Set<string>): void {
  for (const chunk of chunks)
    if (chunk.sourceSegments.some((segment) => uncertain.has(segment.blockId)))
      chunk.qualityFlags = [...new Set([...chunk.qualityFlags, "reading_order_uncertain"])] as QualityFlag[];
}

function splitFlow(flow: TextFlow, request: ChunkRequest): Chunk[] {
  let located: LocatedPart[];
  if (request.strategy === "token") {
    const uniqueBudget = Math.max(1, request.chunkSize - request.chunkOverlap);
    const splitter = new TokenTextSplitter({
      chunkSize: uniqueBudget,
      chunkOverlap: 0,
    });
    located = addTokenOverlap(
      flow.text,
      locateParts(flow.text, splitter.splitText(flow.text)),
      request.chunkOverlap,
      request.chunkSize,
    );
  } else {
    const splitter = new SentenceSplitter({
          chunkSize: request.chunkSize,
          chunkOverlap: request.chunkOverlap,
        });
    located = locateParts(flow.text, splitter.splitText(flow.text));
  }
  const chunks: Chunk[] = [];
  located.forEach((part, index) => {
    chunks.push(
      textChunk(flow, part, index, chunks.at(-1)?.sourceSegments ?? []),
    );
  });
  return chunks;
}

function semanticParts(
  flow: TextFlow,
  signals: SemanticSignal[],
  maximumTokens: number,
): Array<LocatedPart & { budgetFallback: boolean }> {
  const sentences = locateParts(
    flow.text,
    signals.map((signal) => signal.sentence),
  );
  if (!sentences.length) return [];
  const groups: LocatedPart[] = [];
  let start = sentences[0].start;
  sentences.forEach((sentence, index) => {
    if (signals[index]?.isBreakpoint || index === sentences.length - 1) {
      const end = sentence.end;
      groups.push({ text: flow.text.slice(start, end), start, end });
      start = sentences[index + 1]?.start ?? end;
    }
  });
  const result: Array<LocatedPart & { budgetFallback: boolean }> = [];
  for (const group of groups) {
    if (countTokens(group.text) <= maximumTokens)
      result.push({ ...group, budgetFallback: false });
    else {
    const splitter = new SentenceSplitter({
      chunkSize: maximumTokens,
      chunkOverlap: 0,
    });
      result.push(
        ...locateParts(group.text, splitter.splitText(group.text)).map(
          (part) => ({
        text: part.text,
        start: group.start + part.start,
        end: group.start + part.end,
        budgetFallback: true,
          }),
        ),
      );
    }
  }
  return result;
}

function contextCandidate(chunk: Chunk): boolean {
  return (
    !chunk.productIdentity ||
    /本产品|该模式|上述参数|如下图|安装方法|注意事项/.test(chunk.finalText)
  );
}

export function previewMetrics(chunks: Chunk[]): ChunkPreviewMetrics {
  const counts = chunks.map((chunk) => chunk.tokenCount);
  const overlapCharacters = chunks.reduce(
    (total, chunk) =>
      total +
      chunk.sourceSegments
        .filter((segment) => segment.isOverlap)
        .reduce((sum, segment) => sum + segment.chunkEnd - segment.chunkStart, 0),
    0,
  );
  const totalCharacters = chunks.reduce(
    (total, chunk) => total + chunk.finalText.length,
    0,
  );
  return {
    chunkCount: chunks.length,
    token: {
      minimum: counts.length ? Math.min(...counts) : 0,
      average: counts.length
        ? Number((counts.reduce((sum, count) => sum + count, 0) / counts.length).toFixed(1))
        : 0,
      maximum: counts.length ? Math.max(...counts) : 0,
    },
    tokenDistribution: {
      under80: counts.filter((count) => count < 80).length,
      "80to255": counts.filter((count) => count >= 80 && count < 256).length,
      "256to511": counts.filter((count) => count >= 256 && count < 512).length,
      "512to1023": counts.filter((count) => count >= 512 && count < 1024).length,
      "1024plus": counts.filter((count) => count >= 1024).length,
    },
    oversizedCount: chunks.filter((chunk) => chunk.qualityFlags.includes("oversized"))
      .length,
    undersizedCount: chunks.filter((chunk) => chunk.qualityFlags.includes("undersized"))
      .length,
    actualOverlapRatio: totalCharacters
      ? Number((overlapCharacters / totalCharacters).toFixed(4))
      : 0,
    crossPageCount: chunks.filter(
      (chunk) =>
        new Set(
          chunk.sourceSegments
            .map((segment) => segment.page)
            .filter((page) => page !== null),
        ).size > 1,
    ).length,
    typeCounts: {
      text: chunks.filter((chunk) => chunk.type === "text").length,
      image: chunks.filter((chunk) => chunk.type === "image").length,
      table: chunks.filter((chunk) => chunk.type === "table").length,
    },
    missingProductIdentityCount: chunks.filter((chunk) => !chunk.productIdentity)
      .length,
    contextCandidateCount: chunks.filter(contextCandidate).length,
  };
}

export async function buildChunkPreview(
  blocks: ParsedBlock[],
  request: ChunkRequest,
  embedTexts?: EmbedTexts,
): Promise<ChunkPreview> {
  validateRequest(request);
  if (request.strategy !== "semantic") {
    const chunks = chunkBlocks(blocks, request);
    return { chunks, semanticSignals: [], metrics: previewMetrics(chunks) };
  }
  if (!embedTexts)
    throw new Error("Semantic Boundary requires an embedding model");
  const chunks: Chunk[] = [];
  const uncertain = uncertainReadingOrderIds(blocks);
  const semanticSignals: Array<SemanticSignal & { flowId: string }> = [];
  for (const [unitIndex, unit] of assembleTextFlows(blocks, true).entries()) {
    if (!("spans" in unit)) {
      if ("blocks" in unit) {
        if (
          protectedGroupType(unit) === "image" &&
          request.imagePolicy === "exclude"
        )
          continue;
        chunks.push(...splitProtectedGroup(unit, request.semanticMaxChunkSize));
        continue;
      }
      if (unit.type !== "image" || request.imagePolicy !== "exclude") {
        const chunk = protectedChunk(unit, unitIndex);
        if (chunk.tokenCount > request.semanticMaxChunkSize)
          chunk.qualityFlags.push("oversized");
        chunks.push(chunk);
      }
      continue;
    }
    const signals = await analyzeSemanticText(
      unit.text,
      request.bufferSize,
      request.breakpointPercentile,
      embedTexts,
    );
    semanticSignals.push(
      ...signals.map((signal) => ({ ...signal, flowId: unit.id })),
    );
    for (const part of semanticParts(
      unit,
      signals,
      request.semanticMaxChunkSize,
    )) {
      chunks.push(
        textChunk(
          unit,
          part,
          chunks.length,
          [],
          part.budgetFallback ? ["semantic_budget_boundary"] : [],
        ),
      );
    }
  }
  applyReadingOrderFlags(chunks, uncertain);
  return { chunks, semanticSignals, metrics: previewMetrics(chunks) };
}

export function chunkBlocks(
  blocks: ParsedBlock[],
  request: ChunkRequest,
  _semanticSignals = new Map<string, SemanticSignal[]>(),
): Chunk[] {
  validateRequest(request);
  if (request.strategy === "parent-child") return parentChildChunks(blocks, request);
  const chunks = assembleTextFlows(blocks, request.strategy === "structure").flatMap((unit, index) => {
    if (!("spans" in unit)) {
      if ("blocks" in unit) {
        if (
          protectedGroupType(unit) === "image" &&
          request.imagePolicy === "exclude"
        )
          return [];
        return splitProtectedGroup(unit, request.chunkSize);
      }
      if (unit.type === "image" && request.imagePolicy === "exclude") return [];
      const chunk = protectedChunk(unit, index);
      if (chunk.tokenCount > request.chunkSize) chunk.qualityFlags.push("oversized");
      return [chunk];
    }
    return splitFlow(unit, request);
  });
  applyReadingOrderFlags(chunks, uncertainReadingOrderIds(blocks));
  return chunks;
}

function parentChildChunks(blocks: ParsedBlock[], request: ChunkRequest): Chunk[] {
  const parentSize = request.parentChunkSize ?? 1536;
  const chunks = assembleTextFlows(blocks, true).flatMap((unit, unitIndex): Chunk[] => {
    if (!("spans" in unit)) {
      const protectedChunks = "blocks" in unit
        ? (protectedGroupType(unit) === "image" && request.imagePolicy === "exclude" ? [] : splitProtectedGroup(unit, parentSize))
        : (unit.type === "image" && request.imagePolicy === "exclude" ? [] : [protectedChunk(unit, unitIndex)]);
      return protectedChunks.map((chunk) => ({ ...chunk, parentChunk: {
        id: `parent-${chunk.id}`, text: chunk.text, sourceSegments: structuredClone(chunk.sourceSegments), childCount: 1,
      } }));
    }
    const parentParts = locateParts(unit.text, new SentenceSplitter({ chunkSize: parentSize, chunkOverlap: 0 }).splitText(unit.text));
    return parentParts.flatMap((part, index) => {
      const parentId = `${unit.id}-parent-${index + 1}`;
      const parent = textChunk(unit, part, index, []);
      const childFlow: TextFlow = { id: parentId, text: part.text, spans: unit.spans
        .filter((span) => span.end > part.start && span.start < part.end)
        .map((span) => ({ ...span, start: span.start - part.start, end: span.end - part.start })) };
      const children = splitFlow(childFlow, { ...request, strategy: "token" });
      return children.map((child) => ({ ...child, parentChunk: {
        id: parentId, text: part.text, sourceSegments: structuredClone(parent.sourceSegments), childCount: children.length,
      } }));
    });
  });
  applyReadingOrderFlags(chunks, uncertainReadingOrderIds(blocks));
  return chunks;
}
