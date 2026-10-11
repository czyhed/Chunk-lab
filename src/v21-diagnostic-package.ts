const DIAGNOSTIC_TTL_MS = 24 * 60 * 60 * 1000;

export type DiagnosticCategory =
  | "parse_failed"
  | "mineru_result_anomaly"
  | "bbox_page_anomaly"
  | "visual_conversion_failed";

type DiagnosticPageMapping = {
  pages: Array<{
    page: number;
    pageWidth: number;
    pageHeight: number;
    bboxPageWidth?: number;
    bboxPageHeight?: number;
  }>;
};

export function hasBboxPageAnomaly(
  contentList: unknown,
  sourceMapping?: DiagnosticPageMapping,
): boolean {
  if (!Array.isArray(contentList)) return false;
  return contentList.some((item) => {
    if (!item || typeof item !== "object") return false;
    const row = item as Record<string, unknown>;
    const hasPage = Object.hasOwn(row, "page_idx");
    const hasBbox = Object.hasOwn(row, "bbox");
    if (!hasPage && !hasBbox) return false;
    if (!hasPage && hasBbox) return true;
    const pageIndex = row.page_idx;
    if (!Number.isSafeInteger(pageIndex) || (pageIndex as number) < 0)
      return true;
    const page = sourceMapping?.pages.find(
      (candidate) => candidate.page === (pageIndex as number) + 1,
    );
    if (sourceMapping && !page) return true;
    if (!hasBbox) return false;
    if (
      !Array.isArray(row.bbox) ||
      row.bbox.length !== 4 ||
      row.bbox.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) return true;
    const [left, top, right, bottom] = row.bbox as number[];
    const bboxPageWidth = page?.bboxPageWidth ?? page?.pageWidth;
    const bboxPageHeight = page?.bboxPageHeight ?? page?.pageHeight;
    return left < 0 || top < 0 || right <= left || bottom <= top ||
      Boolean(page && (right > bboxPageWidth! || bottom > bboxPageHeight!));
  });
}

export type DiagnosticPackageInput = {
  batchId: string;
  documentId: string;
  generatedAt: string;
  sourceFingerprint: string;
  issues: Array<{ category: DiagnosticCategory; message: string }>;
  versions: {
    parserVersion?: string;
    normalizerVersion?: string;
    converterVersion?: string;
  };
  status?: {
    parseState?: string;
    visualCopyState?: string;
  };
  raw: {
    fullMarkdown?: string;
    contentList?: unknown[];
    rawTableHtml?: string;
  };
};

export type DiagnosticPackage = {
  packageKind: "v21-diagnostic";
  contractVersion: "2.1";
  batchId: string;
  documentId: string;
  generatedAt: string;
  expiresAt: string;
  sourceFingerprint: string;
  issues: DiagnosticPackageInput["issues"];
  versions: DiagnosticPackageInput["versions"];
  status: NonNullable<DiagnosticPackageInput["status"]>;
  raw: DiagnosticPackageInput["raw"];
};

export function buildDiagnosticPackage(
  input: DiagnosticPackageInput,
): DiagnosticPackage {
  const generatedTime = Date.parse(input.generatedAt);
  if (
    !Number.isFinite(generatedTime) ||
    new Date(generatedTime).toISOString() !== input.generatedAt
  ) throw new Error("generatedAt must be an ISO timestamp");

  return {
    packageKind: "v21-diagnostic",
    contractVersion: "2.1",
    batchId: input.batchId,
    documentId: input.documentId,
    generatedAt: input.generatedAt,
    expiresAt: new Date(generatedTime + DIAGNOSTIC_TTL_MS).toISOString(),
    sourceFingerprint: input.sourceFingerprint,
    issues: input.issues.map((issue) => ({
      category: issue.category,
      message: sanitizeDiagnosticString(issue.message),
    })),
    versions: compact({
      parserVersion: input.versions.parserVersion,
      normalizerVersion: input.versions.normalizerVersion,
      converterVersion: input.versions.converterVersion,
    }),
    status: compact({
      parseState: input.status?.parseState,
      visualCopyState: input.status?.visualCopyState,
    }),
    raw: compact({
      fullMarkdown: input.raw.fullMarkdown
        ? sanitizeDiagnosticString(input.raw.fullMarkdown)
        : undefined,
      contentList: input.raw.contentList
        ? sanitizeDiagnosticValue(input.raw.contentList) as unknown[]
        : undefined,
      rawTableHtml: input.raw.rawTableHtml
        ? sanitizeDiagnosticString(input.raw.rawTableHtml)
        : undefined,
    }),
  };
}

function sanitizeDiagnosticValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeDiagnosticString(value);
  if (Array.isArray(value)) return value.map(sanitizeDiagnosticValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !dangerousKey(key))
      .map(([key, item]) => [key, sanitizeDiagnosticValue(item)]),
  );
}

function sanitizeDiagnosticString(value: string): string {
  return value
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, "[REDACTED_URL]")
    .replace(
      /\b(?:authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*(?:Bearer\s+|Basic\s+)?[^\s"'<>;,]+/gi,
      "[REDACTED_CREDENTIAL]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED_CREDENTIAL]");
}

function dangerousKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized.endsWith("authorization") ||
    normalized.endsWith("cookie") ||
    normalized.endsWith("header") ||
    normalized.endsWith("headers") ||
    normalized.endsWith("key") ||
    normalized === "requesturl" ||
    normalized.endsWith("url") ||
    normalized === "requestdetails" ||
    normalized.endsWith("credential") ||
    normalized.endsWith("credentials") ||
    normalized.endsWith("token") ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret")
  );
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}
