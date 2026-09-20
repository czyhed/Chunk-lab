import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export type SourceInput = {
  id: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
};

export type VisualCopyResult = {
  converter: string;
  converterVersion: string;
  pageDimensions: { width: number; height: number }[];
  coordinateMapping: unknown;
  mappingVersion: string;
};

export type InputAdapters = {
  submitMineru(source: SourceInput): Promise<{ jobId: string }>;
  createVisualCopy(source: SourceInput): Promise<VisualCopyResult>;
};

export type VisualCopyRecord =
  | { state: "not_requested" }
  | { state: "generating"; retryTicket: string }
  | {
      state: "ready";
      retryTicket?: string;
      visualCopyVersion: string;
      converter: string;
      converterVersion: string;
      generatedAt: string;
      pageCount: number;
      pageDimensions: { width: number; height: number }[];
      coordinateMapping: unknown;
      mappingVersion: string;
    }
  | {
      state: "failed";
      retryTicket?: string;
      error: string;
      qualityFlag: "visual_copy_unavailable";
    };

export type SourceDocumentRecord = {
  id: string;
  name: string;
  mimeType: string;
  sourceDocumentVersion: string;
  parseRoute: "mineru" | "local";
  parseState: "pending" | "done";
  parseJobId: string | null;
  sourceViewKind:
    | "original_file"
    | "visual_copy"
    | "parsed_document"
    | "markdown_source"
    | "txt_source";
  visualCopy: VisualCopyRecord;
  downstreamAvailable: true;
};

export async function createSourceDocument(
  source: SourceInput,
  adapters: InputAdapters,
): Promise<SourceDocumentRecord> {
  const classification = classifySource(source.name);
  const sourceDocumentVersion = version("src", source.bytes);
  if (classification.parseRoute === "local")
    return {
      id: source.id,
      name: source.name,
      mimeType: source.mimeType,
      sourceDocumentVersion,
      parseRoute: "local",
      parseState: "done",
      parseJobId: null,
      sourceViewKind: classification.preferredSourceViewKind,
      visualCopy: { state: "not_requested" },
      downstreamAvailable: true,
    };

  const parseJob = adapters.submitMineru(source);
  const visualCopy = classification.requiresVisualCopy
    ? createVisualCopyRecord(source, adapters.createVisualCopy)
    : Promise.resolve<VisualCopyRecord>({ state: "not_requested" });
  const [parsed, visual] = await Promise.all([parseJob, visualCopy]);
  return {
    id: source.id,
    name: source.name,
    mimeType: source.mimeType,
    sourceDocumentVersion,
    parseRoute: "mineru",
    parseState: "pending",
    parseJobId: parsed.jobId,
    sourceViewKind:
      visual.state === "ready"
        ? "visual_copy"
        : classification.requiresVisualCopy
          ? "parsed_document"
          : "original_file",
    visualCopy: visual,
    downstreamAvailable: true,
  };
}

export type SourceClassification = {
  extension: string;
  parseRoute: "mineru" | "local";
  preferredSourceViewKind:
    | "original_file"
    | "visual_copy"
    | "markdown_source"
    | "txt_source";
  requiresVisualCopy: boolean;
};

export function classifySource(name: string): SourceClassification {
  const extension = /\.[^.]+$/.exec(name.toLowerCase())?.[0] ?? "";
  if ([".pdf", ".png", ".jpg", ".jpeg"].includes(extension))
    return {
      extension,
      parseRoute: "mineru",
      preferredSourceViewKind: "original_file",
      requiresVisualCopy: false,
    };
  if ([".docx", ".pptx", ".xlsx"].includes(extension))
    return {
      extension,
      parseRoute: "mineru",
      preferredSourceViewKind: "visual_copy",
      requiresVisualCopy: true,
    };
  if (extension === ".md")
    return {
      extension,
      parseRoute: "local",
      preferredSourceViewKind: "markdown_source",
      requiresVisualCopy: false,
    };
  if (extension === ".txt")
    return {
      extension,
      parseRoute: "local",
      preferredSourceViewKind: "txt_source",
      requiresVisualCopy: false,
    };
  throw new Error(`不支持的文件格式: ${extension || "无扩展名"}`);
}

export async function retryVisualCopy(
  document: SourceDocumentRecord,
  source: SourceInput,
  createVisualCopy: InputAdapters["createVisualCopy"],
): Promise<SourceDocumentRecord> {
  if (!classifySource(source.name).requiresVisualCopy)
    throw new Error("该文件不需要 Visual Copy");
  const visualCopy = await createVisualCopyRecord(source, createVisualCopy);
  return {
    ...document,
    visualCopy,
    sourceViewKind:
      visualCopy.state === "ready" ? "visual_copy" : "parsed_document",
  };
}

export function beginVisualCopy(retryTicket: string): VisualCopyRecord {
  return { state: "generating", retryTicket };
}

export function finishVisualCopy(
  current: Extract<VisualCopyRecord, { state: "generating" }>,
  result: VisualCopyResult | Error,
): VisualCopyRecord {
  if (result instanceof Error)
    return {
      state: "failed",
      retryTicket: current.retryTicket,
      error: result.message,
      qualityFlag: "visual_copy_unavailable",
    };
  return { ...toReadyVisualCopy(result), retryTicket: current.retryTicket };
}

async function createVisualCopyRecord(
  source: SourceInput,
  createVisualCopy: InputAdapters["createVisualCopy"],
): Promise<VisualCopyRecord> {
  try {
    return toReadyVisualCopy(await createVisualCopy(source));
  } catch (error) {
    return {
      state: "failed",
      error: error instanceof Error ? error.message : "Visual Copy failed",
      qualityFlag: "visual_copy_unavailable",
    };
  }
}

function toReadyVisualCopy(
  result: VisualCopyResult,
): Extract<VisualCopyRecord, { state: "ready" }> {
  const serialized = new TextEncoder().encode(JSON.stringify(result));
  return {
    state: "ready",
    visualCopyVersion: version("visual", serialized),
    converter: result.converter,
    converterVersion: result.converterVersion,
    generatedAt: new Date().toISOString(),
    pageCount: result.pageDimensions.length,
    pageDimensions: result.pageDimensions,
    coordinateMapping: result.coordinateMapping,
    mappingVersion: result.mappingVersion,
  };
}

function version(prefix: string, bytes: Uint8Array): string {
  return `${prefix}-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
}

export async function sourceVersionFromFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `src-${hash.digest("hex").slice(0, 16)}`;
}
