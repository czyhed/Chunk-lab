import { randomUUID } from "node:crypto";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketVersioningCommand,
  PutObjectCommand,
  PutObjectTaggingCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  ASSET_CONTRACT_VERSION,
  buildAssetDescriptor,
  type AssetDescriptor,
  type BuildAssetDescriptorInput,
} from "./asset-contract.js";

export type PutAssetInput = Omit<BuildAssetDescriptorInput, "bucket">;

export type StoredAsset = {
  reference: AssetDescriptor;
  cacheHit: boolean;
};

export type AssetListFilter = {
  batchId?: string;
  documentId?: string;
  includeDeleted?: boolean;
  prefix?: string;
};

export type SoftDeleteInput = {
  at: string;
  deleteAfter: string;
  activeReferenceCount: number;
  reason: "document_delete" | "expired" | "orphan" | "operator_request";
};

export type ObjectAuditRecord = {
  id: string;
  at: string;
  action: "put" | "cache_hit" | "soft_delete" | "physical_delete";
  bucket: string;
  key: string;
  batchId: string;
  documentId: string | null;
  reason?: string;
};

export interface AssetObjectStore {
  put(input: PutAssetInput): Promise<StoredAsset>;
  get(key: string): Promise<Uint8Array>;
  getRange?(key: string, start: number, end: number): Promise<Uint8Array>;
  head(key: string): Promise<AssetDescriptor | null>;
  list(filter?: AssetListFilter): Promise<AssetDescriptor[]>;
  softDelete(key: string, input: SoftDeleteInput): Promise<AssetDescriptor>;
  collectGarbage(input: {
    now: string;
    allowedPrefix: string;
  }): Promise<{ examined: number; deleted: number; retained: number }>;
}

type MemoryEntry = { reference: AssetDescriptor; bytes: Uint8Array };

export class MemoryAssetObjectStore implements AssetObjectStore {
  readonly bucket: string;
  readonly objects = new Map<string, MemoryEntry>();
  readonly auditRecords: ObjectAuditRecord[] = [];
  writeCount = 0;
  private failObjectKeyIncludesOnce?: string;

  constructor(bucket = "memory-assets", options: { failObjectKeyIncludesOnce?: string } = {}) {
    this.bucket = bucket;
    this.failObjectKeyIncludesOnce = options.failObjectKeyIncludesOnce;
  }

  async put(input: PutAssetInput): Promise<StoredAsset> {
    const reference = buildAssetDescriptor({ ...input, bucket: this.bucket });
    if (this.failObjectKeyIncludesOnce && reference.key.includes(this.failObjectKeyIncludesOnce)) {
      this.failObjectKeyIncludesOnce = undefined;
      throw new Error("deterministic object-store failure");
    }
    const existing = this.objects.get(reference.key);
    if (existing && existing.reference.checksumSha256 === reference.checksumSha256) {
      this.audit("cache_hit", existing.reference);
      return { reference: structuredClone(existing.reference), cacheHit: true };
    }
    this.objects.set(reference.key, {
      reference: structuredClone(reference),
      bytes: new Uint8Array(input.bytes),
    });
    this.writeCount += 1;
    this.audit("put", reference);
    return { reference: structuredClone(reference), cacheHit: false };
  }

  async get(key: string): Promise<Uint8Array> {
    const entry = this.objects.get(key);
    if (!entry || entry.reference.deletedAt) throw missing(key);
    return new Uint8Array(entry.bytes);
  }

  async getRange(key: string, start: number, end: number): Promise<Uint8Array> {
    const entry = this.objects.get(key);
    if (!entry || entry.reference.deletedAt) throw missing(key);
    return new Uint8Array(entry.bytes.slice(start, end + 1));
  }

  async head(key: string): Promise<AssetDescriptor | null> {
    const entry = this.objects.get(key);
    return entry ? structuredClone(entry.reference) : null;
  }

  async list(filter: AssetListFilter = {}): Promise<AssetDescriptor[]> {
    return [...this.objects.values()]
      .map((entry) => entry.reference)
      .filter((reference) => !filter.prefix || reference.key.startsWith(filter.prefix))
      .filter((reference) => !filter.batchId || reference.batchId === filter.batchId)
      .filter((reference) => !filter.documentId || reference.documentId === filter.documentId)
      .filter((reference) => filter.includeDeleted || !reference.deletedAt)
      .map((reference) => structuredClone(reference))
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  async softDelete(key: string, input: SoftDeleteInput): Promise<AssetDescriptor> {
    validateSoftDelete(input);
    if (input.activeReferenceCount > 0)
      throw new Error("asset has active references");
    const entry = this.objects.get(key);
    if (!entry) throw missing(key);
    if (!entry.reference.deletedAt) {
      entry.reference.deletedAt = input.at;
      entry.reference.deleteAfter = input.deleteAfter;
      this.audit("soft_delete", entry.reference, input.reason);
    }
    return structuredClone(entry.reference);
  }

  async collectGarbage(input: {
    now: string;
    allowedPrefix: string;
  }): Promise<{ examined: number; deleted: number; retained: number }> {
    validateGarbageScope(input.allowedPrefix);
    const now = timestamp(input.now, "now");
    const candidates = [...this.objects.values()].filter((entry) =>
      entry.reference.key.startsWith(input.allowedPrefix)
    );
    let deleted = 0;
    for (const entry of candidates) {
      if (
        entry.reference.deletedAt &&
        entry.reference.deleteAfter &&
        Date.parse(entry.reference.deleteAfter) <= now
      ) {
        this.objects.delete(entry.reference.key);
        this.audit("physical_delete", entry.reference);
        deleted += 1;
      }
    }
    return { examined: candidates.length, deleted, retained: candidates.length - deleted };
  }

  private audit(
    action: ObjectAuditRecord["action"],
    reference: AssetDescriptor,
    reason?: string,
  ): void {
    this.auditRecords.push({
      id: randomUUID(),
      at: action === "soft_delete" && reference.deletedAt
        ? reference.deletedAt
        : new Date().toISOString(),
      action,
      bucket: reference.bucket,
      key: reference.key,
      batchId: reference.batchId,
      documentId: reference.documentId,
      ...(reason ? { reason } : {}),
    });
  }
}

export function createConfiguredAssetObjectStore(
  environment: NodeJS.ProcessEnv,
): AssetObjectStore | null {
  const endpoint = environment.MINIO_ENDPOINT?.trim();
  const bucket = environment.MINIO_BUCKET?.trim();
  const accessKey = environment.MINIO_ACCESS_KEY?.trim();
  const secretKey = environment.MINIO_SECRET_KEY?.trim();
  if (![endpoint, bucket, accessKey, secretKey].some(Boolean)) return null;
  if (!endpoint || !bucket || !accessKey || !secretKey) return null;
  return new S3AssetObjectStore({
    endpoint,
    bucket,
    accessKey,
    secretKey,
    region: environment.MINIO_REGION?.trim() || "us-east-1",
  });
}

class S3AssetObjectStore implements AssetObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private ready: Promise<void> | null = null;

  constructor(input: {
    endpoint: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
    region: string;
  }) {
    this.bucket = input.bucket;
    this.client = new S3Client({
      endpoint: input.endpoint,
      region: input.region,
      forcePathStyle: true,
      credentials: { accessKeyId: input.accessKey, secretAccessKey: input.secretKey },
    });
  }

  async put(input: PutAssetInput): Promise<StoredAsset> {
    await this.ensureReady();
    const reference = buildAssetDescriptor({ ...input, bucket: this.bucket });
    const existing = await this.head(reference.key);
    if (existing?.checksumSha256 === reference.checksumSha256)
      return { reference: existing, cacheHit: true };
    const result = await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: reference.key,
      Body: input.bytes,
      ContentType: reference.contentType,
      Metadata: metadataFor(reference),
    }));
    const saved = {
      ...reference,
      etag: cleanEtag(result.ETag),
      versionId: result.VersionId ?? null,
    };
    await this.appendAudit("put", saved);
    return { reference: saved, cacheHit: false };
  }

  async get(key: string): Promise<Uint8Array> {
    await this.ensureReady();
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw missing(key);
    return new Uint8Array(await result.Body.transformToByteArray());
  }

  async getRange(key: string, start: number, end: number): Promise<Uint8Array> {
    await this.ensureReady();
    const result = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Range: `bytes=${start}-${end}`,
    }));
    if (!result.Body) throw missing(key);
    return new Uint8Array(await result.Body.transformToByteArray());
  }

  async head(key: string): Promise<AssetDescriptor | null> {
    await this.ensureReady();
    try {
      const [head, tagging] = await Promise.all([
        this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })),
        this.client.send(new GetObjectTaggingCommand({ Bucket: this.bucket, Key: key })),
      ]);
      const tags = Object.fromEntries((tagging.TagSet ?? []).map((tag) => [tag.Key!, tag.Value!]));
      return descriptorFromMetadata(this.bucket, key, head.Metadata ?? {}, {
        etag: cleanEtag(head.ETag),
        versionId: head.VersionId ?? null,
        deletedAt: tags.deletedAt || null,
        deleteAfter: tags.deleteAfter || null,
      });
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async list(filter: AssetListFilter = {}): Promise<AssetDescriptor[]> {
    await this.ensureReady();
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: filter.prefix ?? "v1/",
        ContinuationToken: token,
      }));
      keys.push(...(page.Contents ?? []).flatMap((item) => item.Key ? [item.Key] : []));
      token = page.NextContinuationToken;
    } while (token);
    const descriptors = (await Promise.all(
      keys.filter((key) => !key.startsWith("v1/_audit/")).map((key) => this.head(key)),
    )).filter((value): value is AssetDescriptor => Boolean(value));
    return descriptors
      .filter((reference) => !filter.batchId || reference.batchId === filter.batchId)
      .filter((reference) => !filter.documentId || reference.documentId === filter.documentId)
      .filter((reference) => filter.includeDeleted || !reference.deletedAt)
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  async softDelete(key: string, input: SoftDeleteInput): Promise<AssetDescriptor> {
    validateSoftDelete(input);
    if (input.activeReferenceCount > 0) throw new Error("asset has active references");
    const reference = await this.head(key);
    if (!reference) throw missing(key);
    if (reference.deletedAt) return reference;
    await this.client.send(new PutObjectTaggingCommand({
      Bucket: this.bucket,
      Key: key,
      VersionId: reference.versionId ?? undefined,
      Tagging: { TagSet: [
        { Key: "deletedAt", Value: input.at },
        { Key: "deleteAfter", Value: input.deleteAfter },
        { Key: "deleteReason", Value: input.reason },
      ] },
    }));
    const deleted = { ...reference, deletedAt: input.at, deleteAfter: input.deleteAfter };
    await this.appendAudit("soft_delete", deleted, input.reason);
    return deleted;
  }

  async collectGarbage(input: {
    now: string;
    allowedPrefix: string;
  }): Promise<{ examined: number; deleted: number; retained: number }> {
    validateGarbageScope(input.allowedPrefix);
    const now = timestamp(input.now, "now");
    const candidates = await this.list({ prefix: input.allowedPrefix, includeDeleted: true });
    let deleted = 0;
    for (const reference of candidates) {
      if (!reference.deletedAt || !reference.deleteAfter || Date.parse(reference.deleteAfter) > now)
        continue;
      await this.client.send(new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: reference.key,
        VersionId: reference.versionId ?? undefined,
      }));
      await this.appendAudit("physical_delete", reference);
      deleted += 1;
    }
    return { examined: candidates.length, deleted, retained: candidates.length - deleted };
  }

  private async ensureReady(): Promise<void> {
    this.ready ??= (async () => {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      } catch (error) {
        if (!isMissing(error)) throw error;
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      }
      await this.client.send(new PutBucketVersioningCommand({
        Bucket: this.bucket,
        VersioningConfiguration: { Status: "Enabled" },
      }));
    })();
    await this.ready;
  }

  private async appendAudit(
    action: ObjectAuditRecord["action"],
    reference: AssetDescriptor,
    reason?: string,
  ): Promise<void> {
    const record: ObjectAuditRecord = {
      id: randomUUID(),
      at: action === "soft_delete" && reference.deletedAt
        ? reference.deletedAt
        : new Date().toISOString(),
      action,
      bucket: reference.bucket,
      key: reference.key,
      batchId: reference.batchId,
      documentId: reference.documentId,
      ...(reason ? { reason } : {}),
    };
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: `v1/_audit/${reference.batchId}/${record.at.replace(/[:.]/g, "-")}-${record.id}.json`,
      Body: JSON.stringify(record),
      ContentType: "application/json",
    }));
  }
}

function metadataFor(reference: AssetDescriptor): Record<string, string> {
  return {
    contractversion: reference.contractVersion,
    assetclass: reference.assetClass,
    checksumsha256: reference.checksumSha256,
    contenttype: reference.contentType,
    bytelength: String(reference.byteLength),
    batchid: reference.batchId,
    documentid: reference.documentId ?? "",
    sourcedocumentversion: reference.sourceDocumentVersion ?? "",
    assetversion: reference.assetVersion,
    createdat: reference.createdAt,
    expiresat: reference.expiresAt ?? "",
    visibility: reference.visibility,
    overwriterule: reference.overwriteRule,
  };
}

function descriptorFromMetadata(
  bucket: string,
  key: string,
  metadata: Record<string, string>,
  state: Pick<AssetDescriptor, "etag" | "versionId" | "deletedAt" | "deleteAfter">,
): AssetDescriptor {
  if (metadata.contractversion !== ASSET_CONTRACT_VERSION)
    throw new Error(`unsupported object contract for ${key}`);
  return {
    contractVersion: ASSET_CONTRACT_VERSION,
    assetClass: metadata.assetclass as AssetDescriptor["assetClass"],
    bucket,
    key,
    uri: `s3://${bucket}/${key}`,
    contentType: metadata.contenttype ?? contentTypeFromKey(key),
    checksumSha256: metadata.checksumsha256,
    byteLength: Number(metadata.bytelength),
    batchId: metadata.batchid,
    documentId: metadata.documentid || null,
    sourceDocumentVersion: metadata.sourcedocumentversion || null,
    assetVersion: metadata.assetversion,
    createdAt: metadata.createdat,
    expiresAt: metadata.expiresat || null,
    visibility: "private",
    publicProjection: "metadata_only",
    overwriteRule: metadata.overwriterule === "stable_pointer"
      ? "stable_pointer"
      : "immutable_checksum_key",
    ...state,
  };
}

function contentTypeFromKey(key: string): string {
  if (/\.json$/i.test(key)) return "application/json";
  if (/\.pdf$/i.test(key)) return "application/pdf";
  if (/\.zip$/i.test(key)) return "application/zip";
  if (/\.png$/i.test(key)) return "image/png";
  if (/\.jpe?g$/i.test(key)) return "image/jpeg";
  return "application/octet-stream";
}

function validateSoftDelete(input: SoftDeleteInput): void {
  const at = timestamp(input.at, "at");
  const deleteAfter = timestamp(input.deleteAfter, "deleteAfter");
  if (deleteAfter < at) throw new Error("deleteAfter must not precede deletedAt");
  if (!Number.isSafeInteger(input.activeReferenceCount) || input.activeReferenceCount < 0)
    throw new Error("activeReferenceCount is invalid");
}

function validateGarbageScope(prefix: string): void {
  const parts = prefix.split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "v1" || prefix === "v1/")
    throw new Error("GC requires a dedicated prefix containing asset class and batch");
}

function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
    throw new Error(`${label} must be an ISO timestamp`);
  return parsed;
}

function cleanEtag(value: string | undefined): string | null {
  return value?.replace(/^"|"$/g, "") ?? null;
}

function missing(key: string): Error {
  return Object.assign(new Error(`object not found: ${key}`), { code: "OBJECT_NOT_FOUND" });
}

function isMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "NotFound" || candidate.name === "NoSuchBucket" ||
    candidate.name === "NoSuchKey" || candidate.$metadata?.httpStatusCode === 404;
}
