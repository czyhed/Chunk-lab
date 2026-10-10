import { createHash } from "node:crypto";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { deriveNormalizedVersion } from "./v21-eligibility.js";
import {
  normalizeContentBlock,
  parseMarkdownContent,
  parseTxtContent,
  type RawContentInput,
} from "./v21-normalization.js";
import {
  buildProvenancedContentBlock,
  toOrdinarySemanticBlock,
  type Bbox,
  type BboxEvidence,
  type LocationQuality,
  type ProvenancedContentBlock,
} from "./v21-provenance.js";

type MineruRawBlock = Record<string, unknown>;
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

export type ParsedDocumentBlock = ProvenancedContentBlock & {
  sourceLocation: {
    sourceViewKind: "original_file" | "visual_copy" | "parsed_document" | "markdown_source" | "txt_source";
    page: number | null;
    bbox: Bbox | null;
    locationQuality: LocationQuality;
    bboxEvidence?: BboxEvidence;
  };
};

export type SourcePageMapping = {
  mappingVersion: string;
  sourceDocumentVersion: string;
  pages: Array<{
    page: number;
    pageWidth: number;
    pageHeight: number;
    bboxPageWidth?: number;
    bboxPageHeight?: number;
    coordinateUnit: string;
    coordinateOrigin: "top-left" | "bottom-left";
    orientation: 0 | 90 | 180 | 270;
    transform: [number, number, number, number, number, number];
    mediaBox: Bbox;
    cropBox: Bbox;
  }>;
};

export function buildMineruParsedDocument(
  rawBlocks: MineruRawBlock[],
  input: {
    sourceDocumentVersion: string;
    parserVersion: string;
    sourceViewKind?: "original_file" | "visual_copy";
    sourceMapping?: SourcePageMapping;
  },
) {
  const parsedFingerprint = createHash("sha256")
    .update(JSON.stringify({ input, rawBlocks }))
    .digest("hex");
  const parsedDocumentVersion = `parsed-${parsedFingerprint.slice(0, 16)}`;
  const blocks = rawBlocks.map((raw, index) => {
    const normalized = normalizeContentBlock({
      ...mineruNormalizedInput(raw),
      parser: "mineru",
      parserVersion: input.parserVersion,
      parsedDocumentVersion,
      rawBlockId: string(raw.id) || null,
      raw: allowlistedRaw(raw),
    });
    const block = buildProvenancedContentBlock(normalized, {
      sourceDocumentVersion: input.sourceDocumentVersion,
      blockIndex: index,
    });
    const page = number(raw.page_idx);
    const pageNumber = page === null ? null : page + 1;
    const mapping = pageNumber === null
      ? undefined
      : input.sourceMapping?.pages.find((candidate) => candidate.page === pageNumber);
    const rawBbox = bboxFromRaw(raw.bbox);
    const bboxPageWidth = mapping?.bboxPageWidth ?? mapping?.pageWidth;
    const bboxPageHeight = mapping?.bboxPageHeight ?? mapping?.pageHeight;
    const trustedBbox = mapping && rawBbox && rawBbox.every(Number.isFinite) &&
      rawBbox[0] >= 0 && rawBbox[1] >= 0 && rawBbox[2] > rawBbox[0] && rawBbox[3] > rawBbox[1] &&
      rawBbox[2] <= bboxPageWidth! && rawBbox[3] <= bboxPageHeight!;
    return {
      ...block,
      sourceLocation: {
        sourceViewKind: input.sourceViewKind ?? "original_file",
        page: pageNumber,
        bbox: trustedBbox ? rawBbox : null,
        locationQuality: pageNumber === null ? "parsed_only" : trustedBbox ? "exact" : "page_only",
        ...(trustedBbox ? {
          bboxEvidence: {
            ...mapping,
            pageWidth: bboxPageWidth!,
            pageHeight: bboxPageHeight!,
            mappingVersion: input.sourceMapping?.mappingVersion ?? "",
            sourceDocumentVersion: input.sourceDocumentVersion,
          },
        } : {}),
      },
    } satisfies ParsedDocumentBlock;
  });
  const version = deriveNormalizedVersion({
    sourceDocumentVersion: input.sourceDocumentVersion,
    parsedDocumentVersion,
    normalizerVersion: blocks[0]?.normalizerVersion ?? "v21-normalizer-1",
    normalizedModelVersion: blocks[0]?.normalizedModelVersion ?? "v21-content-1",
    normalizedModelInput: blocks.map(toOrdinarySemanticBlock),
  });
  return {
    contractVersion: "2.1" as const,
    sourceDocumentVersion: input.sourceDocumentVersion,
    parsedDocumentVersion,
    normalizedContentVersion: version.normalizedContentVersion,
    normalizerVersion: blocks[0]?.normalizerVersion ?? "v21-normalizer-1",
    normalizedModelVersion: blocks[0]?.normalizedModelVersion ?? "v21-content-1",
    parser: "mineru",
    parserVersion: input.parserVersion,
    blocks,
    ordinaryBlocks: blocks.map(toOrdinarySemanticBlock),
  };
}

function bboxFromRaw(value: unknown): Bbox | null {
  return Array.isArray(value) && value.length === 4 && value.every((item) => typeof item === "number" && Number.isFinite(item))
    ? [value[0], value[1], value[2], value[3]]
    : null;
}

export function buildLocalParsedDocument(
  source: string,
  input: {
    kind: "markdown" | "txt";
    sourceDocumentVersion: string;
    parserVersion: string;
  },
) {
  const parsedDocumentVersion = `parsed-${createHash("sha256")
    .update(JSON.stringify({ source, input }))
    .digest("hex")
    .slice(0, 16)}`;
  const parsed = input.kind === "markdown"
    ? parseMarkdownContent(source, { parsedDocumentVersion, parserVersion: input.parserVersion })
    : parseTxtContent(source, { parsedDocumentVersion, parserVersion: input.parserVersion });
  const blocks = parsed.blocks.map((normalized, index) => ({
    ...buildProvenancedContentBlock(normalized, {
      sourceDocumentVersion: input.sourceDocumentVersion,
      blockIndex: index,
    }),
    sourceLocation: {
      sourceViewKind: input.kind === "markdown" ? "markdown_source" : "txt_source",
      page: null,
      bbox: null,
      locationQuality: normalized.sourceRange ? "exact" : "unavailable",
    },
  } satisfies ParsedDocumentBlock));
  const version = deriveNormalizedVersion({
    sourceDocumentVersion: input.sourceDocumentVersion,
    parsedDocumentVersion,
    normalizerVersion: blocks[0]?.normalizerVersion ?? "v21-normalizer-1",
    normalizedModelVersion: blocks[0]?.normalizedModelVersion ?? "v21-content-1",
    normalizedModelInput: blocks.map(toOrdinarySemanticBlock),
  });
  return {
    contractVersion: "2.1" as const,
    sourceDocumentVersion: input.sourceDocumentVersion,
    parsedDocumentVersion,
    normalizedContentVersion: version.normalizedContentVersion,
    normalizerVersion: blocks[0]?.normalizerVersion ?? "v21-normalizer-1",
    normalizedModelVersion: blocks[0]?.normalizedModelVersion ?? "v21-content-1",
    parser: input.kind === "markdown" ? "commonmark" : "txt",
    parserVersion: input.parserVersion,
    blocks,
    ordinaryBlocks: blocks.map(toOrdinarySemanticBlock),
    sourceAst: parsed.ast,
  };
}

function mineruNormalizedInput(
  raw: MineruRawBlock,
): Pick<RawContentInput, "type"> & Record<string, unknown> {
  const rawType = string(raw.type).toLowerCase();
  if (/title|heading/.test(rawType))
    return { type: "heading", text: string(raw.text), level: number(raw.text_level) ?? 1 };
  if (/list/.test(rawType))
    return { type: "list", ordered: false, items: string(raw.text).split(/\r?\n/).filter(Boolean) };
  if (/table/.test(rawType)) {
    const table = htmlTable(string(raw.table_body));
    return { type: "table", title: string(raw.table_title), table, table_body: raw.table_body };
  }
  if (/image/.test(rawType))
    return {
      type: "image",
      imageId: string(raw.id) || `image-${string(raw.img_path)}`,
      imagePath: string(raw.img_path),
      caption: Array.isArray(raw.image_caption)
        ? raw.image_caption.map(string).filter(Boolean).join(" ")
        : string(raw.image_caption),
    };
  if (/formula|equation/.test(rawType))
    return { type: "formula", latex: string(raw.latex) || string(raw.text) };
  if (/code/.test(rawType))
    return { type: "code", source: string(raw.code) || string(raw.text), language: string(raw.language) };
  if (/warning|caution|notice/.test(rawType))
    return { type: "warning", warningLevel: rawType, title: string(raw.title), body: string(raw.text) };
  if (/caption/.test(rawType)) return { type: "caption", text: string(raw.text) };
  if (/footnote/.test(rawType)) return { type: "footnote", text: string(raw.text) };
  if (/text|paragraph/.test(rawType)) return { type: "paragraph", text: string(raw.text) };
  return { type: "unsupported", text: string(raw.text) };
}

function allowlistedRaw(raw: MineruRawBlock): Record<string, unknown> {
  return {
    type: string(raw.type),
    source: string(raw.text),
    table_body: string(raw.table_body),
  };
}

function htmlTable(html: string): { columns: string[]; rows: string[][] } {
  const fragment = parseFragment(html);
  const rows = descendants(fragment as Node, "tr").map((row) =>
    childElements(row)
      .filter((child) => child.tagName === "th" || child.tagName === "td")
      .map(textContent),
  );
  if (!rows.length) return { columns: [], rows: [] };
  const firstRow = descendants(fragment as Node, "tr")[0];
  const headerCells = childElements(firstRow).filter((child) => child.tagName === "th");
  return headerCells.length
    ? { columns: rows[0], rows: rows.slice(1) }
    : { columns: rows[0], rows: rows.slice(1) };
}

function descendants(node: Node, tagName: string): Element[] {
  const result: Element[] = [];
  for (const child of "childNodes" in node ? node.childNodes : []) {
    if ("tagName" in child && child.tagName === tagName) result.push(child as Element);
    result.push(...descendants(child as Node, tagName));
  }
  return result;
}

function childElements(node: Element): Element[] {
  return node.childNodes.filter((child): child is Element => "tagName" in child);
}

function textContent(node: Node): string {
  if ("value" in node) return node.value.trim();
  return ("childNodes" in node ? node.childNodes : []).map((child) => textContent(child as Node)).join("").trim();
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
