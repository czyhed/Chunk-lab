import { createHash } from "node:crypto";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export type ImageObjectReference = {
  contractVersion: "1.0";
  assetClass: "extracted_image" | "pdf_image_crop";
  scheme: "s3";
  bucket: string;
  key: string;
  uri: string;
  contentType: string;
  checksumSha256: string;
  etag: string | null;
  versionId: string | null;
  source: "source_image" | "pdf_crop";
  batchId: string;
  documentId: string;
  sourceDocumentVersion: string;
  visibility: "private";
};

export type StoreImageInput = {
  bytes: Uint8Array;
  contentType: string;
  source: ImageObjectReference["source"];
  sourceDocumentVersion: string;
  batchId?: string;
  documentId?: string;
};

export type StoredImage = {
  reference: ImageObjectReference;
  cacheHit: boolean;
};

export interface ImageObjectStore {
  store(input: StoreImageInput): Promise<StoredImage>;
}

export class MemoryImageObjectStore implements ImageObjectStore {
  readonly bucket: string;
  readonly objects = new Map<string, Uint8Array>();
  writeCount = 0;

  constructor(bucket = "fake-image-assets") {
    this.bucket = bucket;
  }

  async store(input: StoreImageInput): Promise<StoredImage> {
    const reference = imageReference(this.bucket, input);
    const existing = this.objects.has(reference.key);
    if (!existing) {
      this.objects.set(reference.key, new Uint8Array(input.bytes));
      this.writeCount += 1;
    }
    return { reference, cacheHit: existing };
  }
}

export function createConfiguredImageObjectStore(
  environment: NodeJS.ProcessEnv,
): ImageObjectStore | null {
  const values = {
    endpoint: environment.MINIO_ENDPOINT?.trim(),
    bucket: environment.MINIO_BUCKET?.trim(),
    accessKey: environment.MINIO_ACCESS_KEY?.trim(),
    secretKey: environment.MINIO_SECRET_KEY?.trim(),
  };
  if (!Object.values(values).some(Boolean)) return null;
  if (!values.endpoint || !values.bucket || !values.accessKey || !values.secretKey)
    return null;
  return new S3ImageObjectStore({
    endpoint: values.endpoint,
    bucket: values.bucket,
    region: environment.MINIO_REGION?.trim() || "us-east-1",
    accessKey: values.accessKey,
    secretKey: values.secretKey,
  });
}

class S3ImageObjectStore implements ImageObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private bucketReady: Promise<void> | null = null;

  constructor(input: {
    endpoint: string;
    bucket: string;
    region: string;
    accessKey: string;
    secretKey: string;
  }) {
    this.bucket = input.bucket;
    this.client = new S3Client({
      endpoint: input.endpoint,
      region: input.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: input.accessKey,
        secretAccessKey: input.secretKey,
      },
    });
  }

  async store(input: StoreImageInput): Promise<StoredImage> {
    await this.ensureBucket();
    const reference = imageReference(this.bucket, input);
    try {
      const existing = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: reference.key,
      }));
      if (existing.Metadata?.sha256 === reference.checksumSha256)
        return {
          reference: {
            ...reference,
            etag: cleanEtag(existing.ETag),
            versionId: existing.VersionId ?? null,
          },
          cacheHit: true,
        };
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const saved = await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: reference.key,
      Body: input.bytes,
      ContentType: input.contentType,
      Metadata: {
        contractversion: reference.contractVersion,
        assetclass: reference.assetClass,
        sha256: reference.checksumSha256,
        checksumsha256: reference.checksumSha256,
        contenttype: reference.contentType,
        bytelength: String(input.bytes.byteLength),
        batchid: reference.batchId,
        documentid: reference.documentId,
        sourcedocumentversion: reference.sourceDocumentVersion,
        assetversion: "image-v1",
        createdat: new Date().toISOString(),
        visibility: reference.visibility,
      },
    }));
    return {
      reference: {
        ...reference,
        etag: cleanEtag(saved.ETag),
        versionId: saved.VersionId ?? null,
      },
      cacheHit: false,
    };
  }

  private async ensureBucket(): Promise<void> {
    this.bucketReady ??= (async () => {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      } catch (error) {
        if (!isMissing(error)) throw error;
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      }
    })();
    return this.bucketReady;
  }
}

function imageReference(
  bucket: string,
  input: StoreImageInput,
): ImageObjectReference {
  const checksumSha256 = createHash("sha256").update(input.bytes).digest("hex");
  const extension = input.contentType === "image/jpeg"
    ? "jpg"
    : input.contentType === "image/webp"
      ? "webp"
      : "png";
  const sourceVersion = input.sourceDocumentVersion
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 96);
  const batchId = safePart(input.batchId ?? "image-batch");
  const documentId = safePart(input.documentId ?? "image-document");
  const assetClass = input.source === "pdf_crop"
    ? "pdf_image_crop" as const
    : "extracted_image" as const;
  const prefix = assetClass === "pdf_image_crop"
    ? "v1/pdf-image-crop"
    : "v1/extracted-image";
  const key = `${prefix}/${batchId}/${documentId}/${sourceVersion}/image-v1/${checksumSha256}.${extension}`;
  return {
    contractVersion: "1.0",
    assetClass,
    scheme: "s3",
    bucket,
    key,
    uri: `s3://${bucket}/${key}`,
    contentType: input.contentType,
    checksumSha256,
    etag: null,
    versionId: null,
    source: input.source,
    batchId,
    documentId,
    sourceDocumentVersion: input.sourceDocumentVersion,
    visibility: "private",
  };
}

function safePart(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 128);
  if (!normalized) throw new Error("image object association is invalid");
  return normalized;
}

function cleanEtag(value: string | undefined): string | null {
  return value?.replace(/^"|"$/g, "") ?? null;
}

function isMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "NotFound" || candidate.name === "NoSuchBucket" ||
    candidate.name === "NoSuchKey" || candidate.$metadata?.httpStatusCode === 404;
}
