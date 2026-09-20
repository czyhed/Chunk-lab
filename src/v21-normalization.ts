import { Parser, type Node as CommonMarkNode } from "commonmark";
import {
  CONTENT_TYPES,
  type ContentBlock,
  type ContentType,
  type DiagnosticRaw,
  type NormalizedContent,
  type ParsedSourceDocument,
  type SourceRange,
  type TableModel,
} from "./v21-contract.js";

const NORMALIZER_VERSION = "v21-normalizer-1";
const MODEL_VERSION = "v21-content-1";
const TYPES = new Set<string>(CONTENT_TYPES);

export type RawContentInput = Record<string, unknown> & {
  type: string;
  parser: string;
  parserVersion: string;
  parsedDocumentVersion: string;
  rawBlockId?: string | null;
  raw?: Record<string, unknown>;
  sourceRange?: SourceRange | null;
};

export function normalizeContentBlock(input: RawContentInput): ContentBlock {
  const contentType = TYPES.has(input.type) ? (input.type as ContentType) : "unsupported";
  const normalized = contentType === "unsupported" ? null : normalizeKnown(contentType, input);
  const normalizationStatus =
    contentType === "unsupported"
      ? "unsupported"
      : normalized
        ? isPartial(normalized)
          ? "partial"
          : "normalized"
        : "failed";
  const searchText = normalized ? serializeSearchText(normalized) : "";
  const display = normalized ? renderDisplay(normalized) : { text: "Unsupported content" };

  return {
    contractVersion: "2.1",
    parsedDocumentVersion: input.parsedDocumentVersion,
    parser: input.parser,
    parserVersion: input.parserVersion,
    normalizerVersion: NORMALIZER_VERSION,
    normalizedModelVersion: MODEL_VERSION,
    rawBlockId: typeof input.rawBlockId === "string" ? input.rawBlockId : null,
    contentType,
    raw: diagnosticRaw(input),
    normalized,
    display,
    searchText,
    normalizationStatus,
    automaticText: searchText,
    finalText: searchText,
    excludedFromContentFlow: contentType === "unsupported" || !normalized,
    sourceRange: input.sourceRange ?? null,
  };
}

export function parseMarkdownContent(
  source: string,
  version: { parsedDocumentVersion: string; parserVersion: string },
): ParsedSourceDocument {
  const lines = sourceLines(source);
  const document = new Parser().parse(source);
  const blocks: ContentBlock[] = [];
  const walker = document.walker();
  let event;
  while ((event = walker.next())) {
    const node = event.node;
    if (!event.entering || !isTopLevelContentNode(node)) continue;
    const sourceNode = outerSourceNode(node);
    const sourceRange = rangeFromCommonMark(sourceNode, lines);
    if (!sourceRange) continue;
    const input = commonMarkInput(node, source, sourceRange);
    blocks.push(normalizeContentBlock({
      ...input,
      type: String(input.type),
      parser: "commonmark",
      parserVersion: version.parserVersion,
      parsedDocumentVersion: version.parsedDocumentVersion,
      rawBlockId: `source-${blocks.length + 1}`,
      sourceRange,
      raw: { type: input.type, source: source.slice(sourceRange.sourceStart, sourceRange.sourceEnd) },
    }));
  }
  return parsedDocument(source, blocks);
}

function outerSourceNode(node: CommonMarkNode): CommonMarkNode {
  let sourceNode = node;
  for (let parent = node.parent; parent && parent.type !== "document"; parent = parent.parent)
    if (parent.type === "block_quote") sourceNode = parent;
  return sourceNode;
}

function isTopLevelContentNode(node: CommonMarkNode): boolean {
  if (!["heading", "paragraph", "list", "code_block"].includes(node.type)) return false;
  for (let parent = node.parent; parent && parent.type !== "document"; parent = parent.parent)
    if (["heading", "paragraph", "list", "code_block"].includes(parent.type)) return false;
  return true;
}

function commonMarkInput(
  node: CommonMarkNode,
  source: string,
  range: SourceRange,
): Record<string, unknown> {
  if (node.type === "heading")
    return { type: "heading", level: node.level ?? 1, text: commonMarkText(node) };
  if (node.type === "list") {
    const items: string[] = [];
    for (let item = node.firstChild; item; item = item.next)
      items.push(commonMarkText(item));
    return { type: "list", ordered: node.listType === "ordered", items };
  }
  if (node.type === "code_block")
    return {
      type: "code",
      language: node.info || undefined,
      source: originalCodeSource(source.slice(range.sourceStart, range.sourceEnd), node.literal ?? ""),
    };
  const literal = source.slice(range.sourceStart, range.sourceEnd);
  if (/^\s*\|?\s*[^\n|]+\|/.test(literal) && /\n\s*\|?\s*:?-{3,}/.test(literal)) {
    const tableLines = literal.split(/\r?\n/).filter(Boolean);
    return {
      type: "table",
      table: {
        columns: splitTableRow(tableLines[0]),
        rows: tableLines.slice(2).map(splitTableRow),
      },
    };
  }
  return { type: "paragraph", text: commonMarkText(node) };
}

function originalCodeSource(raw: string, fallback: string): string {
  const firstLineEnd = raw.search(/\r\n|\n|\r/);
  if (firstLineEnd < 0 || !/^\s*(`{3,}|~{3,})/.test(raw)) return fallback;
  const newline = raw.startsWith("\r\n", firstLineEnd) ? "\r\n" : raw[firstLineEnd];
  const bodyStart = firstLineEnd + newline.length;
  const closing = raw.match(/(?:\r\n|\n|\r)\s*(?:`{3,}|~{3,})\s*$/);
  return closing ? raw.slice(bodyStart, closing.index! + closing[0].match(/^(?:\r\n|\n|\r)/)![0].length) : raw.slice(bodyStart);
}

function commonMarkText(node: CommonMarkNode): string {
  const values: string[] = [];
  const walker = node.walker();
  let event;
  while ((event = walker.next())) {
    if (!event.entering) continue;
    if (event.node.type === "text" || event.node.type === "code")
      values.push(event.node.literal ?? "");
    else if (event.node.type === "softbreak" || event.node.type === "linebreak")
      values.push("\n");
  }
  return values.join("").trim();
}

function rangeFromCommonMark(
  node: CommonMarkNode,
  lines: SourceLine[],
): SourceRange | null {
  const sourcepos = node.sourcepos;
  if (!sourcepos) return null;
  const startLine = sourcepos[0][0];
  const endLine = sourcepos[1][0];
  const first = lines[startLine - 1];
  const last = lines[endLine - 1];
  if (!first || !last) return null;
  return {
    sourceStart: first.start + sourcepos[0][1] - 1,
    sourceEnd: Math.min(last.end, last.start + sourcepos[1][1]),
    startLine,
    endLine,
  };
}

export function parseTxtContent(
  source: string,
  version: { parsedDocumentVersion: string; parserVersion: string },
): ParsedSourceDocument {
  const lines = sourceLines(source);
  const blocks: ContentBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    while (index < lines.length && !lines[index].text.trim()) index += 1;
    if (index >= lines.length) break;
    const start = index;
    while (index + 1 < lines.length && lines[index + 1].text.trim()) index += 1;
    const end = index;
    const range = rangeFor(lines, start, end);
    blocks.push(
      normalizeContentBlock({
        type: "paragraph",
        text: source.slice(range.sourceStart, range.sourceEnd),
        parser: "txt",
        parserVersion: version.parserVersion,
        parsedDocumentVersion: version.parsedDocumentVersion,
        rawBlockId: `source-${blocks.length + 1}`,
        sourceRange: range,
        raw: { type: "paragraph", source: source.slice(range.sourceStart, range.sourceEnd) },
      }),
    );
    index += 1;
  }
  return parsedDocument(source, blocks);
}

function normalizeKnown(type: ContentType, input: Record<string, unknown>): NormalizedContent | null {
  switch (type) {
    case "heading": {
      const text = string(input.text);
      return text ? { type, text, level: boundedLevel(input.level) } : null;
    }
    case "paragraph": {
      const text = string(input.text);
      return text ? { type, text } : null;
    }
    case "list": {
      const items = strings(input.items);
      return items.length ? { type, ordered: input.ordered === true, items } : null;
    }
    case "table": {
      const model = tableModel(input.table);
      return model ? { type, ...model, ...(string(input.title) ? { title: string(input.title) } : {}) } : null;
    }
    case "image": {
      const imageId = string(input.imageId);
      if (!imageId) return null;
      return compact({
        type,
        imageId,
        assetReference: string(input.imagePath),
        caption: string(input.caption),
        productIdentity: string(input.productIdentity),
        summary: string(input.summary),
      });
    }
    case "formula": {
      const latex = string(input.latex);
      return latex ? compact({ type, latex, context: string(input.context) }) : null;
    }
    case "code": {
      const source = typeof input.source === "string" ? input.source : "";
      return compact({ type, source, language: string(input.language), title: string(input.title) });
    }
    case "warning": {
      const body = string(input.body);
      return body
        ? compact({ type, level: string(input.warningLevel) || "warning", title: string(input.title), body })
        : null;
    }
    case "caption": {
      const text = string(input.text);
      return text ? compact({ type, text, targetId: string(input.targetId) }) : null;
    }
    case "footnote": {
      const text = string(input.text);
      return text ? compact({ type, text, marker: string(input.marker) }) : null;
    }
  }
}

function isPartial(value: NormalizedContent): boolean {
  return (
    (value.type === "image" && !value.caption && !value.productIdentity && !value.summary) ||
    (value.type === "table" && value.rows.length === 0)
  );
}

function serializeSearchText(value: NormalizedContent): string {
  switch (value.type) {
    case "heading":
    case "paragraph":
      return value.text;
    case "list":
      return value.items.map((item, index) => `${value.ordered ? `${index + 1}.` : "-"} ${item}`).join("\n");
    case "table":
      return [value.title, value.columns.join(" | "), ...value.rows.map((row) => row.join(" | "))]
        .filter(Boolean)
        .join("\n");
    case "image":
      return [
        value.caption && `Caption: ${value.caption}`,
        value.productIdentity && `Product: ${value.productIdentity}`,
        value.summary && `Summary: ${value.summary}`,
      ].filter(Boolean).join("\n");
    case "formula":
      return [value.context, value.latex].filter(Boolean).join("\n");
    case "code":
      return [value.language && `Language: ${value.language}`, value.title, value.source].filter(Boolean).join("\n");
    case "warning":
      return [value.level, value.title, value.body].filter(Boolean).join("\n");
    case "caption":
      return value.text;
    case "footnote":
      return [value.marker, value.text].filter(Boolean).join(" ");
  }
}

function renderDisplay(value: NormalizedContent): { text: string; html?: string } {
  const text = serializeSearchText(value);
  if (value.type !== "table") return { text };
  const head = `<thead><tr>${value.columns.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead>`;
  const body = `<tbody>${value.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return { text, html: `<table>${head}${body}</table>` };
}

function diagnosticRaw(input: RawContentInput): DiagnosticRaw {
  const raw = input.raw ?? {};
  const result: DiagnosticRaw = {};
  const type = string(raw.type) || input.type;
  const source = typeof raw.source === "string" ? raw.source : undefined;
  const rawTableHtml = rawString(raw.table_body) || rawString(input.table_body);
  if (type) result.type = type;
  if (source !== undefined) result.source = source;
  if (rawTableHtml) result.rawTableHtml = rawTableHtml;
  return result;
}

function parsedDocument(source: string, blocks: ContentBlock[]): ParsedSourceDocument {
  return {
    source,
    ast: blocks.flatMap((block) =>
      block.sourceRange ? [{ type: block.contentType, sourceRange: block.sourceRange }] : [],
    ),
    blocks,
  };
}

type SourceLine = { text: string; start: number; end: number; number: number };

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const pattern = /.*?(?:\r\n|\n|\r|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) && match[0]) {
    const full = match[0];
    const text = full.replace(/(?:\r\n|\n|\r)$/, "");
    lines.push({ text, start: match.index, end: match.index + text.length, number: lines.length + 1 });
  }
  return lines;
}

function rangeFor(lines: SourceLine[], start: number, end: number): SourceRange {
  return {
    sourceStart: lines[start].start,
    sourceEnd: lines[end].end,
    startLine: lines[start].number,
    endLine: lines[end].number,
  };
}

function isListLine(value: string): boolean {
  return /^\s*(?:[-+*]|\d+[.)])\s+/.test(value);
}

function isTableStart(lines: SourceLine[], index: number): boolean {
  return (
    index + 1 < lines.length &&
    /\|/.test(lines[index].text) &&
    /^\s*\|?\s*:?-{3,}/.test(lines[index + 1].text)
  );
}

function isBlockStart(lines: SourceLine[], index: number): boolean {
  const value = lines[index].text;
  return /^\s*```/.test(value) || /^(#{1,6})\s+/.test(value) || isListLine(value) || isTableStart(lines, index);
}

function splitTableRow(value: string): string[] {
  return value.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

function tableModel(value: unknown): TableModel | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const columns = strings(row.columns);
  const rows = Array.isArray(row.rows)
    ? row.rows.map(strings).filter((cells) => cells.length)
    : [];
  return columns.length ? { columns, rows } : null;
}

function string(value: unknown): string {
  return typeof value === "string" ? stripTags(value).trim() : "";
}

function rawString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(string).filter(Boolean) : [];
}

function stripTags(value: string): string {
  return value.replace(/<\/?[A-Za-z][^>]*>/g, "");
}

function boundedLevel(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? Math.min(6, Math.max(1, value)) : 1;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== "")) as T;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}
