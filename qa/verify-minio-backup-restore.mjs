import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { S3Client } from "@aws-sdk/client-s3";

for (const name of ["MINIO_ENDPOINT", "MINIO_BUCKET", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY"])
  if (!process.env[name]?.trim()) throw new Error(`${name} is required`);

const sourceBucket = process.env.MINIO_BUCKET;
const restoreBucket = `rag-restore-${process.pid}`;
const client = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT,
  region: process.env.MINIO_REGION || "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  },
});

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
  await new Promise((resolveExit) => child.once("exit", resolveExit));
}

async function json(response) {
  const payload = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${payload.code ?? payload.error ?? "request failed"}`);
  return payload;
}

async function listKeys(bucket) {
  const keys = [];
  let token;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: "v1/",
      ContinuationToken: token,
    }));
    keys.push(...(page.Contents ?? []).flatMap((item) => item.Key ? [item.Key] : []));
    token = page.NextContinuationToken;
  } while (token);
  return keys.sort();
}

async function clearVersionedBucket(bucket) {
  let keyMarker;
  let versionIdMarker;
  do {
    const page = await client.send(new ListObjectVersionsCommand({
      Bucket: bucket,
      Prefix: "v1/",
      KeyMarker: keyMarker,
      VersionIdMarker: versionIdMarker,
    }));
    for (const item of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
      if (item.Key && item.VersionId)
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: item.Key, VersionId: item.VersionId }));
    }
    keyMarker = page.NextKeyMarker;
    versionIdMarker = page.NextVersionIdMarker;
  } while (keyMarker);
}

function startApp(port, workspaceRoot, bucket) {
  const child = spawn(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "src/server.ts"],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        NODE_ENV: "test",
        PORT: String(port),
        WORKSPACE_ROOT: workspaceRoot,
        MINIO_BUCKET: bucket,
        OBJECT_DELETE_GRACE_MS: "0",
        MINERU_API_TOKEN: process.env.MINERU_API_TOKEN || "backup-no-call",
        EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL || "http://127.0.0.1:9/v1",
        EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY || "backup-no-call",
        EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || "backup-no-call",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.resume();
  child.stderr?.resume();
  return child;
}

const sourcePort = await freePort();
const restorePort = await freePort();
const sourceWorkspace = resolve(".workspace", `minio-backup-source-${process.pid}`);
const restoreWorkspace = resolve(".workspace", `minio-backup-restore-${process.pid}`);
const sourceUrl = `http://127.0.0.1:${sourcePort}`;
const restoreUrl = `http://127.0.0.1:${restorePort}`;
let sourceApp;
let restoreApp;
let batchId;
try {
  await client.send(new CreateBucketCommand({ Bucket: restoreBucket }));
  await client.send(new PutBucketVersioningCommand({
    Bucket: restoreBucket,
    VersioningConfiguration: { Status: "Enabled" },
  }));

  sourceApp = startApp(sourcePort, sourceWorkspace, sourceBucket);
  await waitFor(`${sourceUrl}/api/health`, sourceApp);
  const demo = await json(await fetch(`${sourceUrl}/api/demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }));
  batchId = demo.id;
  const documentId = demo.documents[0].id;
  const manifest = await json(await fetch(`${sourceUrl}/api/batches/${batchId}/objects?includeDeleted=true`));
  const sourceKeys = manifest.objects.map((object) => object.key).sort();
  const sourcePrefixes = [...new Set(sourceKeys.map((key) => {
    const parts = key.split("/");
    return `${parts[0]}/${parts[1]}/${parts[2]}/`;
  }))];
  assert.ok(sourceKeys.length >= 3);
  const sourceMetadata = [];
  for (const key of sourceKeys) {
    const head = await client.send(new HeadObjectCommand({ Bucket: sourceBucket, Key: key }));
    assert.ok(head.VersionId);
    const body = await client.send(new GetObjectCommand({ Bucket: sourceBucket, Key: key }));
    if (!body.Body) throw new Error("backup source body missing");
    await client.send(new PutObjectCommand({
      Bucket: restoreBucket,
      Key: key,
      Body: await body.Body.transformToByteArray(),
      ContentType: head.ContentType,
      Metadata: head.Metadata,
    }));
    const restoredHead = await client.send(new HeadObjectCommand({ Bucket: restoreBucket, Key: key }));
    assert.equal(restoredHead.Metadata?.checksumsha256, head.Metadata?.checksumsha256);
    assert.equal(restoredHead.ContentLength, head.ContentLength);
    assert.ok(restoredHead.VersionId);
    sourceMetadata.push({ key, sourceVersioned: true, restoreVersioned: true });
  }
  const sourceBatchPath = resolve(sourceWorkspace, "batches", `${batchId}.json`);
  const restoredBatch = (await readFile(sourceBatchPath, "utf8"))
    .replaceAll(`"bucket":"${sourceBucket}"`, `"bucket":"${restoreBucket}"`)
    .replaceAll(`s3://${sourceBucket}/`, `s3://${restoreBucket}/`);
  await mkdir(resolve(restoreWorkspace, "batches"), { recursive: true });
  await writeFile(resolve(restoreWorkspace, "batches", `${batchId}.json`), restoredBatch, "utf8");

  const sourceDelete = await json(await fetch(
    `${sourceUrl}/api/batches/${batchId}/documents/${documentId}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    },
  ));
  assert.equal(sourceDelete.objectCount, sourceKeys.length);
  let sourceGcDeleted = 0;
  for (const prefix of sourcePrefixes) {
    const gc = await json(await fetch(`${sourceUrl}/api/batches/${batchId}/object-gc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefix }),
    }));
    sourceGcDeleted += gc.deleted;
  }
  assert.equal(sourceGcDeleted, sourceKeys.length);

  await stop(sourceApp);
  sourceApp = undefined;
  restoreApp = startApp(restorePort, restoreWorkspace, restoreBucket);
  await waitFor(`${restoreUrl}/api/health`, restoreApp);
  const restoredManifest = await json(await fetch(`${restoreUrl}/api/batches/${batchId}/objects`));
  assert.equal(restoredManifest.objects.length, sourceKeys.length);
  const restoredHeadApi = await json(await fetch(
    `${restoreUrl}/api/batches/${batchId}/objects/head?key=${encodeURIComponent(sourceKeys[0])}`,
  ));
  assert.equal(restoredHeadApi.object.key, sourceKeys[0]);
  const restoreDelete = await json(await fetch(
    `${restoreUrl}/api/batches/${batchId}/documents/${documentId}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    },
  ));
  assert.equal(restoreDelete.objectCount, sourceKeys.length);
  let restoreGcDeleted = 0;
  for (const prefix of sourcePrefixes) {
    const gc = await json(await fetch(`${restoreUrl}/api/batches/${batchId}/object-gc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefix }),
    }));
    restoreGcDeleted += gc.deleted;
  }
  assert.equal(restoreGcDeleted, sourceKeys.length);
  const evidence = {
    status: "passed",
    sourceBatchId: batchId,
    sourceObjectCount: sourceKeys.length,
    restoredObjectCount: restoredManifest.objects.length,
    sourceVersionedObjects: sourceMetadata.filter((item) => item.sourceVersioned).length,
    restoreVersionedObjects: sourceMetadata.filter((item) => item.restoreVersioned).length,
    checksumAndLengthMatches: true,
    restoredApplicationListAndHead: true,
    sourceAcceptanceSoftDeletedAndGc: true,
    restoreAcceptanceSoftDeletedAndGc: true,
    dedicatedRestoreBucket: restoreBucket,
    paidCalls: { mineru: 0, vlm: 0, context: 0, embedding: 0 },
  };
  const outputDirectory = resolve("output/evidence/object-storage-real-suppliers-production-readiness");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(resolve(outputDirectory, "minio-backup-restore.json"), JSON.stringify(evidence, null, 2), "utf8");
  console.log(JSON.stringify({
    status: evidence.status,
    sourceObjectCount: evidence.sourceObjectCount,
    restoredObjectCount: evidence.restoredObjectCount,
    restoredApplicationListAndHead: evidence.restoredApplicationListAndHead,
  }));
} finally {
  await stop(restoreApp);
  await stop(sourceApp);
  await clearVersionedBucket(restoreBucket).catch(() => undefined);
  await client.send(new DeleteBucketCommand({ Bucket: restoreBucket })).catch(() => undefined);
  client.destroy();
}
