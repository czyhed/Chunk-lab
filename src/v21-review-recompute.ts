import { countTokens } from "./chunking.js";
import type {
  ContentBlock,
  ContentType,
  NormalizationStatus,
  NormalizedContent,
} from "./v21-contract.js";
import {
  evaluateEmbeddingEligibility,
  type EmbeddingExclusionReason,
  type LocationQuality,
} from "./v21-eligibility.js";
import type { SourceSegmentV21 } from "./v21-provenance.js";

type ContextReviewState =
  | "not_generated"
  | "generating"
  | "awaiting_review"
  | "confirmed"
  | "human_modified"
  | "failed"
  | "stale";

export type ReviewedTableCell = {
  cellId: string;
  text: string;
  rowSpan: number;
  colSpan: number;
};

export type ReviewedTableRowGroup = {
  rowGroupId: string;
  order: number;
  repeatedHeader: boolean;
  sourceSegmentIds: readonly string[];
  rowStart: number;
  rowCount: number;
};

export type ReviewedModel =
  | { type: "heading"; text: string; level: number }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: readonly string[] }
  | {
      type: "table";
      title?: string;
      tableId?: string;
      columns: readonly string[];
      rows: readonly (readonly ReviewedTableCell[])[];
      rowGroups?: readonly ReviewedTableRowGroup[];
      notes?: readonly string[];
      footnotes?: readonly string[];
    }
  | {
      type: "image";
      imageId: string;
      assetReference?: string;
      caption?: string;
      productIdentity?: string;
      summary?: string;
    }
  | { type: "formula"; latex: string; context?: string }
  | { type: "code"; source: string; language?: string; title?: string }
  | { type: "warning"; level: string; title?: string; body: string }
  | { type: "caption"; text: string; targetId?: string }
  | { type: "footnote"; text: string; marker?: string }
  | {
      type: "plain_text_repair";
      classification: "heading" | "paragraph" | "list" | "caption" | "footnote";
      text: string;
    }
  | { type: "unsupported" };

export type ReviewedModelRevision = {
  type: "reviewed_model";
  at: string;
  before: ReviewedModel | null;
  after: ReviewedModel;
  beforeFinalText: string;
  afterFinalText: string;
};

export type ReviewableChunk = {
  chunkId: string;
  sourceBlock: ContentBlock;
  reviewedModel?: ReviewedModel | null;
  finalText?: string;
  automaticText: string;
  sourceSegments: readonly SourceSegmentV21[];
  locationQuality: LocationQuality;
  qualityFlags: readonly string[];
  contextText: string;
  contextReviewState: ContextReviewState;
  contextStaleReason?: string;
  revisions: readonly ReviewedModelRevision[];
};

export type ReviewRecomputeRequest = {
  at: string;
  reviewedModel: unknown;
  imageAssetAvailable?: boolean;
  tokenBudget?: { minimum?: number; maximum?: number };
  display?: unknown;
  displayHtml?: unknown;
  searchText?: unknown;
  finalText?: unknown;
  qualityFlags?: unknown;
  embeddingEligible?: unknown;
};

export type RecomputedReviewedChunk = {
  chunkId: string;
  contentType: ContentType;
  normalizedModel: NormalizedContent | null;
  reviewedModel: ReviewedModel;
  normalizationStatus: NormalizationStatus;
  automaticText: string;
  display: { text: string; html?: string };
  searchText: string;
  finalText: string;
  metrics: { tokenCount: number; characterCount: number; lineCount: number };
  qualityFlags: string[];
  embeddingEligible: boolean;
  embeddingExclusionReasons: EmbeddingExclusionReason[];
  embeddingText: null;
  sourceSegments: SourceSegmentV21[];
  contextText: string;
  contextReviewState: ContextReviewState;
  contextStaleReason?: string;
  revisions: ReviewedModelRevision[];
};

const SERVER_DERIVED_FIELDS = [
  "display",
  "displayHtml",
  "searchText",
  "finalText",
  "qualityFlags",
  "embeddingEligible",
] as const;

export function recomputeReviewedChunk(
  chunk: ReviewableChunk,
  request: ReviewRecomputeRequest,
): RecomputedReviewedChunk {
  if (SERVER_DERIVED_FIELDS.some((field) => Object.hasOwn(request, field)))
    throw new Error("Display, text, quality, and eligibility are server-derived fields");
  if (!isIsoDate(request.at)) throw new Error("Revision time must be an ISO timestamp");

  const reviewedModel = validateReviewedModel(request.reviewedModel);
  const semantic = semanticModel(reviewedModel);
  const searchText = serializeReviewedSearchText(reviewedModel, semantic);
  const display = renderReviewedDisplay(reviewedModel, searchText);
  const eligibilityBlock: ContentBlock = {
    ...chunk.sourceBlock,
    contentType: semantic.type,
    searchText,
    finalText: searchText,
    normalizationStatus: "manual_fixed",
    excludedFromContentFlow: false,
  };
  const eligibility = evaluateEmbeddingEligibility({
    block: eligibilityBlock,
    locationQuality: chunk.locationQuality,
    imageAssetAvailable: request.imageAssetAvailable,
    manualValidation: {
      reviewedModelValid: true,
      sourceValid: chunk.sourceSegments.length > 0,
      searchTextValid: Boolean(searchText),
    },
  });
  const metrics = {
    tokenCount: countTokens(searchText),
    characterCount: searchText.length,
    lineCount: searchText.split("\n").length,
  };
  const qualityFlags = recomputeQualityFlags(
    chunk.qualityFlags,
    eligibility.qualityFlags,
    metrics.tokenCount,
    request.tokenBudget,
  );
  const contextChanged =
    chunk.reviewedModel === undefined ||
    stableJson(chunk.reviewedModel) !== stableJson(reviewedModel) ||
    (chunk.finalText ?? chunk.automaticText) !== searchText;
  const contextReviewState =
    contextChanged && chunk.contextReviewState !== "not_generated"
      ? "stale"
      : chunk.contextReviewState;
  const revision: ReviewedModelRevision = {
    type: "reviewed_model",
    at: request.at,
    before: chunk.reviewedModel ? structuredClone(chunk.reviewedModel) : null,
    after: structuredClone(reviewedModel),
    beforeFinalText: chunk.finalText ?? chunk.automaticText,
    afterFinalText: searchText,
  };

  return {
    chunkId: chunk.chunkId,
    contentType: semantic.type,
    normalizedModel: structuredClone(chunk.sourceBlock.normalized),
    reviewedModel: structuredClone(reviewedModel),
    normalizationStatus: "manual_fixed",
    automaticText: chunk.automaticText,
    display,
    searchText,
    finalText: searchText,
    metrics,
    qualityFlags,
    embeddingEligible: eligibility.embeddingEligible,
    embeddingExclusionReasons: eligibility.embeddingExclusionReasons,
    embeddingText: null,
    sourceSegments: [...structuredClone(chunk.sourceSegments)],
    contextText: chunk.contextText,
    contextReviewState,
    ...(contextReviewState === "stale"
      ? {
          contextStaleReason: reviewedModel.type === "table"
            ? "表格结构或审阅文本已修改"
            : "Chunk 审阅模型或最终文本已修改",
        }
      : chunk.contextStaleReason
        ? { contextStaleReason: chunk.contextStaleReason }
        : {}),
    revisions: [...structuredClone(chunk.revisions), revision],
  };
}

export function serializeReviewedModelSearchText(model: ReviewedModel): string {
  return serializeReviewedSearchText(model, semanticModel(model));
}

function validateReviewedModel(value: unknown): ReviewedModel {
  const model = record(value, "reviewed model");
  const type = requiredString(model.type, "reviewed model type");
  switch (type) {
    case "heading":
      return {
        type,
        text: requiredSemanticText(model.text),
        level: integerInRange(model.level, "heading level", 1, 6),
      };
    case "paragraph":
      return { type, text: requiredSemanticText(model.text) };
    case "list":
      return {
        type,
        ordered: boolean(model.ordered, "list ordered"),
        items: nonEmptyStrings(model.items, "list items"),
      };
    case "table":
      return validateTable(model);
    case "image": {
      const result: Extract<ReviewedModel, { type: "image" }> = {
        type,
        imageId: requiredString(model.imageId, "imageId"),
        ...optionalTextFields(model, ["assetReference", "caption", "productIdentity", "summary"]),
      };
      if (!result.caption && !result.productIdentity && !result.summary)
        throw new Error("Image requires reliable caption, product identity, or summary text");
      return result;
    }
    case "formula":
      return compact({ type, latex: requiredString(model.latex, "formula LaTeX"), context: optionalString(model.context) });
    case "code":
      return compact({
        type,
        source: requiredSource(model.source),
        language: optionalString(model.language),
        title: optionalSemanticText(model.title),
      });
    case "warning":
      return compact({
        type,
        level: requiredSemanticText(model.level),
        title: optionalSemanticText(model.title),
        body: requiredSemanticText(model.body),
      });
    case "caption":
      return compact({ type, text: requiredSemanticText(model.text), targetId: optionalString(model.targetId) });
    case "footnote":
      return compact({ type, text: requiredSemanticText(model.text), marker: optionalSemanticText(model.marker) });
    case "plain_text_repair": {
      const classification = requiredString(model.classification, "plain-text classification");
      if (!["heading", "paragraph", "list", "caption", "footnote"].includes(classification))
        throw new Error("Plain-text repair requires an explicit supported type classification");
      return {
        type,
        classification: classification as Extract<ReviewedModel, { type: "plain_text_repair" }>["classification"],
        text: requiredSemanticText(model.text),
      };
    }
    case "unsupported":
      throw new Error("Unsupported content requires an explicit supported type classification");
    default:
      throw new Error(`Unknown reviewed model type: ${type}`);
  }
}

function validateTable(model: Record<string, unknown>): Extract<ReviewedModel, { type: "table" }> {
  const columns = nonEmptyStrings(model.columns, "table columns");
  const rawRows = model.rows;
  if (!Array.isArray(rawRows) || rawRows.length === 0)
    throw new Error("Table requires at least one row");
  const occupied: boolean[][] = [];
  const cellIds = new Set<string>();
  const cellPlacements: Array<{ rowIndex: number; rowSpan: number }> = [];
  const rows = rawRows.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length === 0) throw new Error("Table rows cannot be empty");
    let columnIndex = 0;
    return row.map((cellValue) => {
      const cell = record(cellValue, "table cell");
      while (occupied[rowIndex]?.[columnIndex]) columnIndex += 1;
      const rowSpan = integerInRange(cell.rowSpan, "table rowSpan", 1, rawRows.length);
      const colSpan = integerInRange(cell.colSpan, "table colSpan", 1, columns.length);
      if (rowIndex + rowSpan > rawRows.length || columnIndex + colSpan > columns.length)
        throw new Error("Table span exceeds the table grid");
      const cellId = requiredString(cell.cellId, "table cellId");
      if (cellIds.has(cellId)) throw new Error("Table cellId must be unique");
      cellIds.add(cellId);
      cellPlacements.push({ rowIndex, rowSpan });
      for (let rowOffset = 0; rowOffset < rowSpan; rowOffset += 1) {
        const targetRow = rowIndex + rowOffset;
        occupied[targetRow] ??= [];
        for (let columnOffset = 0; columnOffset < colSpan; columnOffset += 1) {
          const targetColumn = columnIndex + columnOffset;
          if (occupied[targetRow][targetColumn]) throw new Error("Table spans cannot overlap");
          occupied[targetRow][targetColumn] = true;
        }
      }
      columnIndex += colSpan;
      return {
        cellId,
        text: requiredSemanticText(cell.text),
        rowSpan,
        colSpan,
      };
    });
  });
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1)
    if (columns.some((_, columnIndex) => !occupied[rowIndex]?.[columnIndex]))
      throw new Error("Table rows must fill the table grid without gaps");
  const rowGroups = validateRowGroups(model.rowGroups, rows.length);
  if (rowGroups)
    for (const placement of cellPlacements) {
      const group = rowGroups.find((candidate) =>
        placement.rowIndex >= candidate.rowStart &&
        placement.rowIndex < candidate.rowStart + candidate.rowCount
      );
      if (!group || placement.rowIndex + placement.rowSpan > group.rowStart + group.rowCount)
        throw new Error("Table merged cells cannot cross row-group boundaries");
    }
  return compact({
    type: "table",
    title: typeof model.title === "string" && !model.title.trim()
      ? undefined
      : optionalSemanticText(model.title),
    tableId: optionalString(model.tableId),
    columns,
    rows,
    rowGroups,
    notes: optionalStrings(model.notes, "table notes"),
    footnotes: optionalStrings(model.footnotes, "table footnotes"),
  });
}

function validateRowGroups(value: unknown, rowCount: number): ReviewedTableRowGroup[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("Table row groups must be a non-empty array");
  const groups = value.map((item) => {
    const group = record(item, "table row group");
    return {
      rowGroupId: requiredString(group.rowGroupId, "table row group id"),
      order: integerInRange(group.order, "table row group order", 0, value.length - 1),
      repeatedHeader: boolean(group.repeatedHeader, "table repeated header"),
      sourceSegmentIds: nonEmptyStrings(group.sourceSegmentIds, "table row group sources"),
      rowStart: integerInRange(group.rowStart, "table row group start", 0, rowCount - 1),
      rowCount: integerInRange(group.rowCount, "table row group row count", 1, rowCount),
    };
  }).sort((left, right) => left.order - right.order);
  if (new Set(groups.map((group) => group.rowGroupId)).size !== groups.length)
    throw new Error("Table row group ids must be unique");
  if (groups.some((group, index) => group.order !== index))
    throw new Error("Table row group order must be continuous");
  let nextRow = 0;
  for (const group of groups) {
    if (group.rowStart !== nextRow || group.rowStart + group.rowCount > rowCount)
      throw new Error("Table row groups must cover rows continuously");
    nextRow += group.rowCount;
  }
  if (nextRow !== rowCount) throw new Error("Table row groups must cover every row");
  return groups;
}

function semanticModel(model: ReviewedModel): NormalizedContent {
  if (model.type === "unsupported")
    throw new Error("Unsupported content requires an explicit supported type classification");
  if (model.type === "plain_text_repair") {
    if (model.classification === "heading") return { type: "heading", text: model.text, level: 1 };
    if (model.classification === "list") return { type: "list", ordered: false, items: [model.text] };
    if (model.classification === "caption") return { type: "caption", text: model.text };
    if (model.classification === "footnote") return { type: "footnote", text: model.text };
    return { type: "paragraph", text: model.text };
  }
  if (model.type === "table")
    return {
      type: "table",
      ...(model.title ? { title: model.title } : {}),
      columns: [...model.columns],
      rows: model.rows.map((row) => row.map((cell) => cell.text)),
    };
  if (model.type === "list") return { ...model, items: [...model.items] };
  return structuredClone(model);
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
        .filter(Boolean).join("\n");
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

function serializeReviewedSearchText(
  model: ReviewedModel,
  semantic: NormalizedContent,
): string {
  const text = serializeSearchText(semantic);
  if (model.type !== "table") return text;
  return [
    text,
    ...(model.notes ?? []).map((note) => `Note: ${note}`),
    ...(model.footnotes ?? []).map((note) => `Footnote: ${note}`),
  ].join("\n");
}

export function renderReviewedDisplay(model: ReviewedModel, searchText: string): { text: string; html?: string } {
  if (model.type !== "table") return { text: searchText };
  const caption = model.title ? `<caption>${escapeHtml(model.title)}</caption>` : "";
  const head = `<thead><tr>${model.columns.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead>`;
  const body = `<tbody>${model.rows.map((row) => `<tr>${row.map((cell) =>
    `<td${cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : ""}${cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : ""}>${escapeHtml(cell.text)}</td>`,
  ).join("")}</tr>`).join("")}</tbody>`;
  return { text: searchText, html: `<table>${caption}${head}${body}</table>` };
}

function recomputeQualityFlags(
  current: readonly string[],
  eligibility: readonly string[],
  tokenCount: number,
  budget?: { minimum?: number; maximum?: number },
): string[] {
  const derived = new Set(["needs_review", "normalization_failed", "unsupported_content", "partial_content", "undersized", "oversized"]);
  return [...new Set([
    ...current.filter((flag) => !derived.has(flag) && !flag.startsWith("source_location_") && flag !== "image_asset_unavailable"),
    ...eligibility,
    ...(budget?.minimum !== undefined && tokenCount < budget.minimum ? ["undersized"] : []),
    ...(budget?.maximum !== undefined && tokenCount > budget.maximum ? ["oversized"] : []),
  ])];
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function requiredSemanticText(value: unknown): string {
  const text = requiredString(value, "Reviewed model field").replace(/<\/?[A-Za-z][^>]*>/g, "").trim();
  if (!text) throw new Error("Reviewed model requires non-empty text");
  return text;
}

function optionalSemanticText(value: unknown): string | undefined {
  return value === undefined ? undefined : requiredSemanticText(value);
}

function requiredSource(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Code requires non-empty source");
  return value;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : requiredString(value, "Reviewed model field");
}

function nonEmptyStrings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must be a non-empty array`);
  return value.map(requiredSemanticText);
}

function optionalStrings(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map(requiredSemanticText);
}

function optionalTextFields<K extends "assetReference" | "caption" | "productIdentity" | "summary">(
  model: Record<string, unknown>,
  fields: readonly K[],
): Partial<Record<K, string>> {
  return Object.fromEntries(fields.flatMap((field) => {
    const value = field === "assetReference" ? optionalString(model[field]) : optionalSemanticText(model[field]);
    return value ? [[field, value]] : [];
  })) as Partial<Record<K, string>>;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}

function integerInRange(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value as number;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== "")) as T;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function isIsoDate(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
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
