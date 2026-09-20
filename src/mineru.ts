import { readFile } from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import type { ParsedBlock } from "./chunking.js";

const DEFAULT_BASE_URL = "https://mineru.net/api/v4";
type MineruEnvelope<T> = { code: number; msg: string; data: T };
export type MineruResponseObserver = (
  kind: "submission" | "poll",
  sanitizedResponse: unknown,
) => void | Promise<void>;
export type ParseConfig = {
  modelVersion: "pipeline" | "vlm";
  language: string;
  enableFormula: boolean;
  enableTable: boolean;
  isOcr: boolean;
};
type UploadFile = { id: string; name: string; path: string };
export type MineruSubmission = {
  batchId: string;
  uploadedDocumentIds: string[];
  failures: Array<{ documentId: string; name: string; error: string }>;
};

async function request<T>(
  token: string,
  path: string,
  init?: RequestInit,
  observation?: {
    kind: "submission" | "poll";
    observer: MineruResponseObserver;
  },
): Promise<T> {
  const baseUrl = (process.env.MINERU_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = (await response.json()) as MineruEnvelope<T>;
  if (observation) {
    try {
      await observation.observer(
        observation.kind,
        sanitizeMineruResponse(payload),
      );
    } catch {
      // Evidence persistence must never replay a supplier request.
    }
  }
  if (!response.ok || payload.code !== 0)
    throw new Error(payload.msg || `MinerU HTTP ${response.status}`);
  return payload.data;
}

export async function submitMineruBatch(
  token: string,
  files: UploadFile[],
  config: ParseConfig,
  observer?: MineruResponseObserver,
): Promise<MineruSubmission> {
  const data = await request<{ batch_id: string; file_urls: string[] }>(
    token,
    "/file-urls/batch",
    {
      method: "POST",
      body: JSON.stringify({
        files: files.map((file) => ({
          name: file.name,
          data_id: file.id,
          is_ocr: config.isOcr,
        })),
        model_version: config.modelVersion,
        language: config.language,
        enable_formula: config.enableFormula,
        enable_table: config.enableTable,
      }),
    },
    observer ? { kind: "submission", observer } : undefined,
  );
  const uploads = await Promise.allSettled(
    data.file_urls.map(async (url, index) => {
      const response = await fetch(url, {
        method: "PUT",
        body: new Uint8Array(await readFile(files[index].path)),
      });
      if (!response.ok)
        throw new Error(`MinerU upload failed: HTTP ${response.status}`);
    }),
  );
  return {
    batchId: data.batch_id,
    uploadedDocumentIds: files
      .filter((_, index) => uploads[index]?.status === "fulfilled")
      .map((file) => file.id),
    failures: files.flatMap((file, index) => {
      const upload = uploads[index];
      if (!upload || upload.status === "fulfilled") return [];
      return [{
        documentId: file.id,
        name: file.name,
        error: upload.reason instanceof Error
          ? upload.reason.message
          : "MinerU upload failed",
      }];
    }),
  };
}

export type MineruResult = {
  file_name: string;
  data_id?: string;
  state:
    | "waiting-file"
    | "pending"
    | "running"
    | "converting"
    | "done"
    | "failed";
  full_zip_url?: string;
  err_msg?: string;
  extract_progress?: { extracted_pages: number; total_pages: number };
};

export async function getMineruBatch(
  token: string,
  batchId: string,
  observer?: MineruResponseObserver,
): Promise<MineruResult[]> {
  const data = await request<{ extract_result: MineruResult[] }>(
    token,
    `/extract-results/batch/${batchId}`,
    undefined,
    observer ? { kind: "poll", observer } : undefined,
  );
  return data.extract_result;
}

const BLOCK_ROLES = new Set<NonNullable<ParsedBlock["role"]>>([
  "heading",
  "paragraph",
  "list",
  "caption",
  "warning",
  "table",
  "image",
]);

function optionalString(
  row: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    if (typeof row[key] === "string" && row[key].trim()) return row[key].trim();
  }
  return undefined;
}

function normalizeRole(
  row: Record<string, unknown>,
  rawType: string,
  type: ParsedBlock["type"],
): NonNullable<ParsedBlock["role"]> {
  const explicitRole = optionalString(row, "role", "content_role")?.toLowerCase();
  if (explicitRole && BLOCK_ROLES.has(explicitRole as NonNullable<ParsedBlock["role"]>))
    return explicitRole as NonNullable<ParsedBlock["role"]>;
  if (type === "table") return "table";
  if (type === "image") return "image";
  const sourceType = rawType.toLowerCase();
  if (/title|heading/.test(sourceType)) return "heading";
  if (/list/.test(sourceType)) return "list";
  if (/caption/.test(sourceType)) return "caption";
  if (/warning|caution|notice/.test(sourceType)) return "warning";
  return "paragraph";
}

function optionalNumber(
  row: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function normalizeMineruContentList(value: unknown): ParsedBlock[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const rawType = String(row.type ?? "text");
    const type: ParsedBlock["type"] = rawType.includes("table")
      ? "table"
      : rawType.includes("image")
        ? "image"
        : "text";
    const captions = Array.isArray(row.image_caption)
      ? row.image_caption.join(" ")
      : String(row.image_caption ?? "");
    const text =
      type === "table"
        ? String(row.table_body ?? row.text ?? "")
        : type === "image"
          ? captions || String(row.text ?? "")
          : String(row.text ?? row.content ?? "");
    if (!text && type === "text") return [];
    const readingOrder =
      optionalNumber(row, "readingOrder", "reading_order", "order") ?? index;
    const parentId = optionalString(row, "parentId", "parent_id");
    const groupId = optionalString(row, "groupId", "group_id");
    const productIdentity = optionalString(
      row,
      "productIdentity",
      "product_identity",
    );
    const sourceBackend =
      optionalString(row, "sourceBackend", "source_backend", "parser_backend") ??
      "mineru";
    const sourceVersion = optionalString(
      row,
      "sourceVersion",
      "source_version",
      "parserVersion",
      "parser_version",
    );
    return [
      {
        id: `b-${index + 1}`,
        type,
        text,
        page: typeof row.page_idx === "number" ? row.page_idx + 1 : null,
        bbox: Array.isArray(row.bbox) ? row.bbox.map(Number) : null,
        readingOrder,
        role: normalizeRole(row, rawType, type),
        ...(parentId ? { parentId } : {}),
        ...(groupId ? { groupId } : {}),
        ...(productIdentity ? { productIdentity } : {}),
        sourceBackend,
        ...(sourceVersion ? { sourceVersion } : {}),
        ...(typeof row.img_path === "string" ? { imagePath: row.img_path } : {}),
      },
    ];
  });
}

export async function downloadMineruResult(
  url: string,
  hooks?: {
    onZip?: (bytes: Uint8Array) => void | Promise<void>;
    onTrustedResult?: (value: {
      markdown: string;
      blocks: ParsedBlock[];
      rawContentList?: unknown[];
    }) => void | Promise<void>;
  },
): Promise<{ markdown: string; blocks: ParsedBlock[]; rawContentList?: unknown[] }> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`MinerU result download failed: HTTP ${response.status}`);
  const zipBytes = new Uint8Array(await response.arrayBuffer());
  await hooks?.onZip?.(zipBytes);
  const files = unzipSync(zipBytes);
  const markdownName = Object.keys(files).find((name) =>
    /(^|\/)full\.md$/i.test(name),
  );
  const contentName = Object.keys(files).find((name) =>
    /content_list\.json$/i.test(name),
  );
  if (!markdownName) throw new Error("MinerU result does not contain full.md");
  const markdown = strFromU8(files[markdownName]);
  const rawContentList = contentName
    ? (JSON.parse(strFromU8(files[contentName])) as unknown)
    : undefined;
  const blocks = rawContentList
    ? normalizeMineruContentList(rawContentList)
    : [];
  const trusted: {
    markdown: string;
    blocks: ParsedBlock[];
    rawContentList?: unknown[];
  } = {
    markdown,
    ...(Array.isArray(rawContentList) ? { rawContentList } : {}),
    blocks: blocks.length
      ? blocks
      : markdown
          .split(/\n{2,}/)
          .filter(Boolean)
          .map((text, index) => ({
            id: `b-${index + 1}`,
            type: "text",
            text,
            page: null,
            bbox: null,
          })),
  };
  await hooks?.onTrustedResult?.(trusted);
  return trusted;
}

export function sanitizeMineruResponse(value: unknown): unknown {
  if (typeof value === "string")
    return /^https?:\/\//i.test(value)
      ? "[REDACTED_SIGNED_URL]"
      : /^Bearer\s+/i.test(value)
        ? "[REDACTED_CREDENTIAL]"
        : value;
  if (Array.isArray(value)) return value.map(sanitizeMineruResponse);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/(authorization|cookie|password|secret|api[_-]?key)/i.test(key))
      .map(([key, item]) => [key, sanitizeMineruResponse(item)]),
  );
}
