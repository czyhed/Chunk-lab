export const CONTENT_TYPES = [
  "heading",
  "paragraph",
  "list",
  "table",
  "image",
  "formula",
  "code",
  "warning",
  "caption",
  "footnote",
] as const;

export type ContentType = (typeof CONTENT_TYPES)[number];
export type NormalizedContentType = ContentType | "unsupported";
export type NormalizationStatus =
  | "normalized"
  | "partial"
  | "unsupported"
  | "failed"
  | "manual_fixed";

export type SourceRange = {
  sourceStart: number;
  sourceEnd: number;
  startLine: number;
  endLine: number;
};

export type TableModel = {
  title?: string;
  columns: string[];
  rows: string[][];
};

export type NormalizedContent =
  | { type: "heading"; text: string; level: number }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | ({ type: "table" } & TableModel)
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
  | { type: "footnote"; text: string; marker?: string };

export type DiagnosticRaw = {
  type?: string;
  source?: string;
  rawTableHtml?: string;
  parserMetadata?: Record<string, string | number | boolean | null>;
};

export type ContentBlock = {
  contractVersion: "2.1";
  parsedDocumentVersion: string;
  parser: string;
  parserVersion: string;
  normalizerVersion: string;
  normalizedModelVersion: string;
  rawBlockId: string | null;
  contentType: NormalizedContentType;
  raw: DiagnosticRaw;
  normalized: NormalizedContent | null;
  display: { text: string; html?: string };
  searchText: string;
  normalizationStatus: NormalizationStatus;
  automaticText: string;
  finalText: string;
  excludedFromContentFlow: boolean;
  sourceRange: SourceRange | null;
};

export type ContentGroup = {
  contentGroupId: string;
  kind: "text" | "table" | "image" | "warning" | "unsupported";
  contentBlockIds: string[];
  protectedFromTextSplitting: boolean;
};

export type ParsedSourceDocument = {
  source: string;
  ast: { type: NormalizedContentType; sourceRange: SourceRange }[];
  blocks: ContentBlock[];
};
