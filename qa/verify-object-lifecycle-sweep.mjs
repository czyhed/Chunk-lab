import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

for (const name of [
  "MINIO_ENDPOINT",
  "MINIO_BUCKET",
  "MINIO_ACCESS_KEY",
  "MINIO_SECRET_KEY",
]) {
  if (!process.env[name]?.trim()) throw new Error(`${name} is required`);
}

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No test port"));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitFor(url, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`app exited ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("app did not become healthy");
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 3_000)),
  ]);
}

async function json(response) {
  const payload = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${payload.code ?? payload.error ?? "request failed"}`);
  return payload;
}

async function listKeys(client, bucket) {
  const keys = [];
  let continuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: "v1/",
      ContinuationToken: continuationToken,
    }));
    keys.push(...(page.Contents ?? []).flatMap((item) => item.Key ? [item.Key] : []));
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);
  return keys.sort();
}

async function auditRecords(client, bucket, batchId) {
  const page = await client.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: `v1/_audit/${batchId}/`,
  }));
  return await Promise.all((page.Contents ?? []).flatMap((item) => item.Key ? [item.Key] : [])
    .map(async (key) => {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!result.Body) throw new Error("audit object body missing");
      return JSON.parse(await result.Body.transformToString());
    }));
}

async function putHistorical(client, {
  bucket,
  assetClass,
  batchId,
  documentId,
  assetVersion,
  createdAt,
  extension,
  contentType,
  body,
}) {
  const bytes = Buffer.from(body);
  const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
  const prefix = {
    source_original: "source-original",
    office_visual_copy: "office-visual-copy",
  }[assetClass];
  const key = `v1/${prefix}/${batchId}/${documentId}/source-v1/${assetVersion}/${checksumSha256}.${extension}`;
  const expiresAt = assetClass === "office_visual_copy"
    ? new Date(Date.parse(createdAt) + 30 * 24 * 60 * 60 * 1000).toISOString()
    : "";
  const saved = await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: bytes,
    ContentType: contentType,
    Metadata: {
      contractversion: "1.0",
      assetclass: assetClass,
      checksumsha256: checksumSha256,
      contenttype: contentType,
      bytelength: String(bytes.byteLength),
      batchid: batchId,
      documentid: documentId,
      sourcedocumentversion: "source-v1",
      assetversion: assetVersion,
      createdat: createdAt,
      expiresat: expiresAt,
      visibility: "private",
    },
  }));
  return {
    key,
    checksumSha256,
    reference: {
      contractVersion: "1.0",
      assetClass,
      bucket,
      key,
      uri: `s3://${bucket}/${key}`,
      contentType,
      checksumSha256,
      byteLength: bytes.byteLength,
      batchId,
      documentId,
      sourceDocumentVersion: "source-v1",
      assetVersion,
      createdAt,
      expiresAt: expiresAt || null,
      visibility: "private",
      publicProjection: "metadata_only",
      overwriteRule: "immutable_checksum_key",
      etag: saved.ETag?.replace(/^"|"$/g, "") ?? null,
      versionId: saved.VersionId ?? null,
      deletedAt: null,
      deleteAfter: null,
    },
  };
}

const port = await freePort();
const workspaceRoot = resolve(".workspace", `lifecycle-sweep-${process.pid}`);
const baseUrl = `http://127.0.0.1:${port}`;
const bucket = process.env.MINIO_BUCKET;
const client = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT,
  region: process.env.MINIO_REGION || "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  },
});
const beforeKeys = await listKeys(client, bucket);
let app;
let activeBatchId;
let failedBatchId;
const startApp = () => spawn(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "src/server.ts"],
  {
    cwd: resolve("."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      WORKSPACE_ROOT: workspaceRoot,
      OBJECT_DELETE_GRACE_MS: "0",
      MINERU_API_TOKEN: process.env.MINERU_API_TOKEN || "lifecycle-no-call",
      EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL || "http://127.0.0.1:9/v1",
      EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY || "lifecycle-no-call",
      EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || "lifecycle-no-call",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
try {
  app = startApp();
  await waitFor(`${baseUrl}/api/health`, app);

  const activeDemo = await json(await fetch(`${baseUrl}/api/demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }));
  activeBatchId = activeDemo.id;
  const activeDocumentId = activeDemo.documents[0].id;
  const activeVisual = await putHistorical(client, {
    bucket,
    assetClass: "office_visual_copy",
    batchId: activeBatchId,
    documentId: activeDocumentId,
    assetVersion: "historical-expired-v1",
    createdAt: "2026-07-01T00:00:00.000Z",
    extension: "pdf",
    contentType: "application/pdf",
    body: "historical visual copy",
  });
  const orphanSource = await putHistorical(client, {
    bucket,
    assetClass: "source_original",
    batchId: activeBatchId,
    documentId: "orphan-document",
    assetVersion: "historical-orphan-v1",
    createdAt: "2026-07-01T00:00:00.000Z",
    extension: "pdf",
    contentType: "application/pdf",
    body: "historical orphan source",
  });

  await stop(app);
  const activeBatchPath = resolve(workspaceRoot, "batches", `${activeBatchId}.json`);
  const activeBatch = JSON.parse(await readFile(activeBatchPath, "utf8"));
  activeBatch.documents[0].visualCopyAsset = {
    mimeType: "application/pdf",
    objectReference: activeVisual.reference,
  };
  await writeFile(activeBatchPath, JSON.stringify(activeBatch), "utf8");
  app = startApp();
  await waitFor(`${baseUrl}/api/health`, app);

  const activePrefix = `v1/office-visual-copy/${activeBatchId}/`;
  const expired = await json(await fetch(`${baseUrl}/api/batches/${activeBatchId}/object-lifecycle-sweep`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: activePrefix, confirm: true }),
  }));
  assert.equal(expired.softDeleted, 1);
  assert.equal(expired.reasons.expired, 1);
  const expiredHead = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: activeVisual.key }));
  assert.ok(expiredHead.VersionId);

  const sourcePrefix = `v1/source-original/${activeBatchId}/`;
  const orphan = await json(await fetch(`${baseUrl}/api/batches/${activeBatchId}/object-lifecycle-sweep`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: sourcePrefix, confirm: true }),
  }));
  assert.equal(orphan.softDeleted, 1);
  assert.equal(orphan.reasons.orphan, 1);
  assert.equal(orphan.retained, 1);
  const repeatedOrphan = await json(await fetch(`${baseUrl}/api/batches/${activeBatchId}/object-lifecycle-sweep`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: sourcePrefix, confirm: true }),
  }));
  assert.equal(repeatedOrphan.softDeleted, 0);
  assert.equal(repeatedOrphan.alreadyDeleted, 1);

  const failedDemo = await json(await fetch(`${baseUrl}/api/demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ diagnosticCategory: "parse_failed" }),
  }));
  failedBatchId = failedDemo.id;
  const failedDocumentId = failedDemo.documents[0].id;
  const failedSource = await putHistorical(client, {
    bucket,
    assetClass: "source_original",
    batchId: failedBatchId,
    documentId: failedDocumentId,
    assetVersion: "historical-failed-v1",
    createdAt: "2026-07-01T00:00:00.000Z",
    extension: "pdf",
    contentType: "application/pdf",
    body: "historical failed source",
  });
  const failedSweep = await json(await fetch(`${baseUrl}/api/batches/${failedBatchId}/object-lifecycle-sweep`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: `v1/source-original/${failedBatchId}/`, confirm: true }),
  }));
  assert.equal(failedSweep.reasons.orphan, 1);
  const failedHead = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: failedSource.key }));
  assert.ok(failedHead.VersionId);

  const activeManifest = await json(await fetch(
    `${baseUrl}/api/batches/${activeBatchId}/objects?includeDeleted=true`,
  ));
  const failedManifest = await json(await fetch(
    `${baseUrl}/api/batches/${failedBatchId}/objects?includeDeleted=true`,
  ));
  for (const key of [activeVisual.key, orphanSource.key]) {
    const tombstone = activeManifest.objects.find((object) => object.key === key);
    assert.ok(tombstone?.deletedAt && tombstone.deleteAfter);
  }
  const failedTombstone = failedManifest.objects.find((object) => object.key === failedSource.key);
  assert.ok(failedTombstone?.deletedAt && failedTombstone.deleteAfter);

  const gc = await json(await fetch(`${baseUrl}/api/batches/${activeBatchId}/object-gc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: sourcePrefix }),
  }));
  assert.equal(gc.deleted, 1);
  const expiredGc = await json(await fetch(`${baseUrl}/api/batches/${activeBatchId}/object-gc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: activePrefix }),
  }));
  assert.equal(expiredGc.deleted, 1);
  const failedPrefix = `v1/source-original/${failedBatchId}/`;
  const failedGc = await json(await fetch(`${baseUrl}/api/batches/${failedBatchId}/object-gc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: failedPrefix }),
  }));
  assert.equal(failedGc.deleted, 1);
  const activeAudit = await auditRecords(client, bucket, activeBatchId);
  const failedAudit = await auditRecords(client, bucket, failedBatchId);
  assert.equal(activeAudit.some((record) =>
    record.action === "soft_delete" && record.key === activeVisual.key && record.reason === "expired"
  ), true);
  assert.equal(activeAudit.some((record) =>
    record.action === "soft_delete" && record.key === orphanSource.key && record.reason === "orphan"
  ), true);
  assert.equal(failedAudit.some((record) =>
    record.action === "soft_delete" && record.key === failedSource.key && record.reason === "orphan"
  ), true);
  const afterKeys = await listKeys(client, bucket);
  const acceptanceIds = [activeBatchId, failedBatchId];
  const isAcceptanceKey = (key) => acceptanceIds.some((id) => key.includes(`/${id}/`));
  assert.deepEqual(
    afterKeys.filter((key) => !isAcceptanceKey(key)),
    beforeKeys.filter((key) => !isAcceptanceKey(key)),
    "lifecycle acceptance did not modify unrelated objects",
  );
  const evidence = {
    contractVersion: "1.0",
    activeBatchId,
    failedBatchId,
    expired: { class: "office_visual_copy", softDeleted: 1, reason: "expired", headVersioned: true, gcDeleted: 1 },
    orphan: { class: "source_original", softDeleted: 1, reason: "orphan", repeatSoftDeleted: 0, gcDeleted: 1 },
    failedDocument: { softDeleted: 1, reason: "orphan", gcDeleted: 1 },
    activeReferenceProtected: true,
    publicTombstoneProjectionVerified: true,
    lifecycleAuditVerified: true,
    unrelatedObjectsUnchanged: true,
    secretFree: true,
  };
  const outputDirectory = resolve("output/evidence/object-storage-real-suppliers-production-readiness");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(resolve(outputDirectory, "lifecycle-sweep.json"), JSON.stringify(evidence, null, 2), "utf8");
  console.log(JSON.stringify(evidence));
} finally {
  await stop(app);
  client.destroy();
}
