import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import {
  HeadObjectCommand,
  ListObjectsV2Command,
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

const port = await freePort();
const workspaceRoot = resolve(".workspace", `object-production-like-${process.pid}`);
const baseUrl = `http://127.0.0.1:${port}`;
const client = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT,
  region: process.env.MINIO_REGION || "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  },
});
const bucket = process.env.MINIO_BUCKET;
const beforeKeys = await listKeys(client, bucket);
let app;
const start = () => spawn(
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
      MINERU_API_TOKEN: process.env.MINERU_API_TOKEN || "storage-acceptance-no-call",
      EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL || "http://127.0.0.1:9/v1",
      EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY || "storage-acceptance-no-call",
      EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || "storage-acceptance-no-call",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let batchId;
let documentId;
let faultBatchId;
let faultDocumentId;
let faultObjects;
let objectsBeforeDelete;
try {
  app = start();
  await waitFor(`${baseUrl}/api/health`, app);
  const demo = await json(await fetch(`${baseUrl}/api/demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageScenario: "three" }),
  }));
  batchId = demo.id;
  documentId = demo.documents[0].id;

  const confirmed = await json(await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}/review/confirm`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  ));
  const imageChunk = confirmed.reviewState.draft.chunks.find((chunk) => chunk.type === "image");
  assert.ok(imageChunk);
  await json(await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}/chunks/${encodeURIComponent(imageChunk.id)}/image-summary`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imagePolicy: "reference", humanSummary: "", humanSupplement: "" }),
    },
  ));
  await json(await fetch(`${baseUrl}/api/batches/${batchId}/export?contractVersion=2.1`));

  const fault = await json(await fetch(`${baseUrl}/api/demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ diagnosticCategory: "parse_failed" }),
  }));
  faultBatchId = fault.id;
  faultDocumentId = fault.documents[0].id;
  await json(await fetch(
    `${baseUrl}/api/batches/${fault.id}/documents/${fault.documents[0].id}/diagnostic-package`,
    { method: "POST" },
  ));
  const faultManifest = await json(await fetch(
    `${baseUrl}/api/batches/${faultBatchId}/objects?documentId=${faultDocumentId}`,
  ));
  faultObjects = faultManifest.objects;
  const diagnosticObject = faultObjects.find((object) => object.assetClass === "diagnostic_package");
  assert.ok(diagnosticObject, "fault batch must persist diagnostic_package");
  const diagnosticHead = await client.send(new HeadObjectCommand({
    Bucket: bucket,
    Key: diagnosticObject.key,
  }));
  assert.equal(diagnosticHead.Metadata?.checksumsha256, diagnosticObject.checksumSha256);
  assert.ok(diagnosticHead.VersionId);

  const manifest = await json(await fetch(
    `${baseUrl}/api/batches/${batchId}/objects?documentId=${documentId}`,
  ));
  objectsBeforeDelete = manifest.objects;
  const classes = new Set(objectsBeforeDelete.map((object) => object.assetClass));
  for (const required of [
    "source_original",
    "mineru_trusted_result",
    "parsed_document_snapshot",
    "pdf_image_crop",
  ]) assert.equal(classes.has(required), true, `missing ${required}`);

  for (const object of objectsBeforeDelete) {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: object.key }));
    assert.equal(head.ContentLength, object.byteLength);
    assert.equal(
      head.Metadata?.checksumsha256 ?? head.Metadata?.sha256,
      object.checksumSha256,
    );
    assert.ok(head.VersionId, `versioning missing for ${object.assetClass}`);
  }

  await stop(app);
  app = start();
  await waitFor(`${baseUrl}/api/health`, app);
  const restored = await json(await fetch(`${baseUrl}/api/batches/${batchId}`));
  assert.equal(restored.documents[0].sourceAvailable, true);
  const review = await json(await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}/review`,
  ));
  assert.ok(review.reviewState.draft);

  if (process.env.RESTART_MINIO === "1") {
    const restart = spawnSync("docker", ["restart", "rag-minio"], {
      cwd: resolve("."),
      encoding: "utf8",
      windowsHide: true,
    });
    if (restart.status !== 0) throw new Error("MinIO restart failed");
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectsBeforeDelete[0].key }));
        break;
      } catch {
        if (attempt === 79) throw new Error("MinIO did not recover");
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
    }
    const afterRestart = await json(await fetch(
      `${baseUrl}/api/batches/${batchId}/objects?documentId=${documentId}`,
    ));
    assert.equal(afterRestart.objects.length, objectsBeforeDelete.length);
  }

  const deleted = await json(await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    },
  ));
  assert.equal(deleted.objectCount, objectsBeforeDelete.length);
  const tombstones = await json(await fetch(
    `${baseUrl}/api/batches/${batchId}/objects?documentId=${documentId}&includeDeleted=true`,
  ));
  assert.equal(tombstones.objects.every((object) => object.deletedAt && object.deleteAfter), true);

  const prefixes = [...new Set(objectsBeforeDelete.map((object) => {
    const [contract, classification] = object.key.split("/");
    return `${contract}/${classification}/${batchId}/`;
  }))];
  let physicallyDeleted = 0;
  for (const prefix of prefixes) {
    const result = await json(await fetch(`${baseUrl}/api/batches/${batchId}/object-gc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefix }),
    }));
    physicallyDeleted += result.deleted;
    const repeated = await json(await fetch(`${baseUrl}/api/batches/${batchId}/object-gc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefix }),
    }));
    assert.deepEqual(repeated, { examined: 0, deleted: 0, retained: 0 });
  }
  assert.equal(physicallyDeleted, objectsBeforeDelete.length);

  const faultDeleted = await json(await fetch(
    `${baseUrl}/api/batches/${faultBatchId}/documents/${faultDocumentId}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    },
  ));
  assert.equal(faultDeleted.objectCount, faultObjects.length);
  const faultPrefixes = [...new Set(faultObjects.map((object) => {
    const [contract, classification] = object.key.split("/");
    return `${contract}/${classification}/${faultBatchId}/`;
  }))];
  let faultPhysicallyDeleted = 0;
  for (const prefix of faultPrefixes) {
    const result = await json(await fetch(`${baseUrl}/api/batches/${faultBatchId}/object-gc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefix }),
    }));
    faultPhysicallyDeleted += result.deleted;
  }
  assert.equal(faultPhysicallyDeleted, faultObjects.length);

  const afterKeys = await listKeys(client, bucket);
  const acceptanceIds = [batchId, faultBatchId];
  const isAcceptanceKey = (key) => acceptanceIds.some((id) => key.includes(`/${id}/`));
  const unrelatedBefore = beforeKeys.filter((key) => !isAcceptanceKey(key));
  const unrelatedAfter = afterKeys.filter((key) => !isAcceptanceKey(key));
  assert.deepEqual(unrelatedAfter, unrelatedBefore, "unrelated MinIO objects remain unchanged");

  const evidence = {
    contractVersion: "1.0",
    acceptanceBatchId: batchId,
    documentId,
    objectClasses: [...new Set(objectsBeforeDelete.map((object) => object.assetClass))].sort(),
    faultObjectClasses: [...new Set(faultObjects.map((object) => object.assetClass))].sort(),
    objectCount: objectsBeforeDelete.length,
    allHeadChecksPassed: true,
    versioningObserved: true,
    applicationRestartRecovered: true,
    minioRestartRecovered: process.env.RESTART_MINIO === "1",
    softDeleted: objectsBeforeDelete.length,
    physicallyDeleted,
    repeatedGcDeleted: 0,
    diagnosticPackageHeadPassed: true,
    faultPhysicallyDeleted,
    unrelatedObjectsUnchanged: true,
    paidCalls: { mineru: 0, vlm: 0, context: 0, embedding: 0 },
  };
  const outputDirectory = resolve(
    "output/evidence/object-storage-real-suppliers-production-readiness",
  );
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    resolve(outputDirectory, "minio-production-like.json"),
    JSON.stringify(evidence, null, 2),
    "utf8",
  );
  console.log(JSON.stringify(evidence));
} finally {
  await stop(app);
  client.destroy();
}
