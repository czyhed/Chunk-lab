import { createHash } from "node:crypto";

export const ASSET_CONTRACT_VERSION = "1.0" as const;

export type AssetClass =
  | "source_original"
  | "mineru_raw_response"
  | "mineru_result_zip"
  | "mineru_trusted_result"
  | "parsed_document_snapshot"
  | "office_visual_copy"
  | "pdf_page_render"
  | "pdf_image_crop"
  | "extracted_image"
  | "model_input"
  | "export_package"
  | "spu_material_markdown"
  | "spu_material_manifest"
  | "spu_material_current"
  | "diagnostic_package";

export type AssetRetention =
  | { kind: "document_delete" }
  | { kind: "days"; days: number }
  | { kind: "hours"; hours: number };

export type AssetPolicy = {
  prefix: string;
  retention: AssetRetention;
  visibility: "private";
  publicProjection: "metadata_only";
  overwriteRule: "immutable_checksum_key" | "stable_pointer";
};

const POLICIES: Record<AssetClass, AssetPolicy> = {
  source_original: retained("source-original"),
  mineru_raw_response: days("mineru-raw-response", 30),
  mineru_result_zip: days("mineru-result-zip", 30),
  mineru_trusted_result: days("mineru-trusted-result", 30),
  parsed_document_snapshot: retained("parsed-document"),
  office_visual_copy: days("office-visual-copy", 30),
  pdf_page_render: days("pdf-page-render", 30),
  pdf_image_crop: retained("pdf-image-crop"),
  extracted_image: retained("extracted-image"),
  model_input: days("model-input", 30),
  export_package: days("export-package", 30),
  spu_material_markdown: retained("spu-material-markdown"),
  spu_material_manifest: retained("spu-material-manifest"),
  spu_material_current: {
    ...basePolicy("spu-material-current"),
    retention: { kind: "document_delete" },
    overwriteRule: "stable_pointer",
  },
  diagnostic_package: {
    ...basePolicy("diagnostic-package"),
    retention: { kind: "hours", hours: 24 },
  },
};

export type AssetDescriptor = {
  contractVersion: typeof ASSET_CONTRACT_VERSION;
  assetClass: AssetClass;
  bucket: string;
  key: string;
  uri: string;
  contentType: string;
  checksumSha256: string;
  byteLength: number;
  batchId: string;
  documentId: string | null;
  sourceDocumentVersion: string | null;
  assetVersion: string;
  createdAt: string;
  expiresAt: string | null;
  visibility: "private";
  publicProjection: "metadata_only";
  overwriteRule: "immutable_checksum_key" | "stable_pointer";
  etag: string | null;
  versionId: string | null;
  deletedAt: string | null;
  deleteAfter: string | null;
};

export type BuildAssetDescriptorInput = {
  assetClass: AssetClass;
  bytes: Uint8Array;
  contentType: string;
  batchId: string;
  documentId?: string | null;
  sourceDocumentVersion?: string | null;
  assetVersion: string;
  extension: string;
  /** A reviewed, deterministic object key for an immutable export or stable pointer. */
  objectKey?: string;
  bucket?: string;
  createdAt?: string;
};

export function assetPolicy(assetClass: AssetClass): AssetPolicy {
  return structuredClone(POLICIES[assetClass]);
}

export function buildAssetDescriptor(
  input: BuildAssetDescriptorInput,
): AssetDescriptor {
  const policy = assetPolicy(input.assetClass);
  const checksumSha256 = createHash("sha256").update(input.bytes).digest("hex");
  const batchId = safePart(input.batchId, "batchId");
  const documentId = input.documentId === undefined || input.documentId === null
    ? null
    : safePart(input.documentId, "documentId");
  const sourceDocumentVersion = input.sourceDocumentVersion
    ? safePart(input.sourceDocumentVersion, "sourceDocumentVersion")
    : null;
  const assetVersion = safePart(input.assetVersion, "assetVersion");
  const extension = input.extension.toLowerCase().replace(/^\./, "");
  if (!/^[a-z0-9]{1,12}$/.test(extension)) throw new Error("extension is invalid");
  if (!input.contentType.trim() || /[\r\n]/.test(input.contentType))
    throw new Error("contentType is invalid");
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (new Date(createdAt).toISOString() !== createdAt)
    throw new Error("createdAt must be an ISO timestamp");
  const identity = [
    policy.prefix,
    batchId,
    documentId ?? "batch",
    sourceDocumentVersion ?? "no-source-version",
    assetVersion,
  ];
  const key = input.objectKey
    ? safeObjectKey(input.objectKey)
    : `${identity.join("/")}/${checksumSha256}.${extension}`;
  const bucket = safePart(input.bucket ?? "rag-assets", "bucket");
  return {
    contractVersion: ASSET_CONTRACT_VERSION,
    assetClass: input.assetClass,
    bucket,
    key,
    uri: `s3://${bucket}/${key}`,
    contentType: input.contentType.trim().toLowerCase(),
    checksumSha256,
    byteLength: input.bytes.byteLength,
    batchId,
    documentId,
    sourceDocumentVersion,
    assetVersion,
    createdAt,
    expiresAt: expiry(createdAt, policy.retention),
    visibility: policy.visibility,
    publicProjection: policy.publicProjection,
    overwriteRule: input.objectKey && input.assetClass === "spu_material_current"
      ? "stable_pointer"
      : policy.overwriteRule,
    etag: null,
    versionId: null,
    deletedAt: null,
    deleteAfter: null,
  };
}

export function containsForbiddenPersistentPayload(value: unknown): boolean {
  return scanForbidden(value, new Set<object>());
}

function scanForbidden(value: unknown, seen: Set<object>): boolean {
  if (typeof value === "string")
    return /^data:/i.test(value) || /;base64,/i.test(value) ||
      /^https?:\/\/[^\s]+(?:x-amz-|signature=|token=)/i.test(value) ||
      /^Bearer\s+/i.test(value);
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return true;
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      normalized.includes("authorization") ||
      normalized.includes("presigned") ||
      normalized === "signedurl" ||
      normalized.endsWith("apikey") ||
      normalized.endsWith("password") ||
      normalized.endsWith("secret")
    ) return true;
    return scanForbidden(item, seen);
  });
}

function retained(name: string): AssetPolicy {
  return { ...basePolicy(name), retention: { kind: "document_delete" } };
}

function days(name: string, value: number): AssetPolicy {
  return { ...basePolicy(name), retention: { kind: "days", days: value } };
}

function basePolicy(name: string): Omit<AssetPolicy, "retention"> {
  return {
    prefix: `v1/${name}`,
    visibility: "private",
    publicProjection: "metadata_only",
    overwriteRule: "immutable_checksum_key",
  };
}

function expiry(createdAt: string, retention: AssetRetention): string | null {
  if (retention.kind === "document_delete") return null;
  const milliseconds = retention.kind === "days"
    ? retention.days * 24 * 60 * 60 * 1000
    : retention.hours * 60 * 60 * 1000;
  return new Date(Date.parse(createdAt) + milliseconds).toISOString();
}

function safePart(value: string, name: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 128);
  if (!normalized || normalized === "." || normalized === "..")
    throw new Error(`${name} is invalid`);
  return normalized;
}

function safeObjectKey(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const parts = normalized.split("/");
  if (!parts.length || parts.some((part) => !part || part === "." || part === ".." || !/^[A-Za-z0-9._-]{1,128}$/.test(part)))
    throw new Error("objectKey is invalid");
  return parts.join("/");
}
