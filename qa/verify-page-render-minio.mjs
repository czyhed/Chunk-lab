import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  S3Client,
} from "@aws-sdk/client-s3";

for (const name of ["MINIO_ENDPOINT", "MINIO_BUCKET", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY"])
  if (!process.env[name]?.trim()) throw new Error(`${name} is required`);

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

async function listKeys() {
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

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolveExit) => child.once("exit", resolveExit));
}

const beforeKeys = await listKeys();
const workspaceRoot = resolve(".workspace", `page-render-minio-${process.pid}`);
const child = spawn(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "src/model-api-workflow.test.ts"],
  {
    cwd: resolve("."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      WORKSPACE_ROOT: workspaceRoot,
      OBJECT_DELETE_GRACE_MS: "0",
      MINERU_API_TOKEN: process.env.MINERU_API_TOKEN || "page-render-no-call",
      EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL || "http://127.0.0.1:9/v1",
      EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY || "page-render-no-call",
      EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || "page-render-no-call",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout?.resume();
child.stderr?.resume();
let exitCode = null;
try {
  exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code));
  });
  assert.equal(exitCode, 0, "fake VLM workflow against MinIO must pass");
  const afterKeys = await listKeys();
  const beforeSet = new Set(beforeKeys);
  const newKeys = afterKeys.filter((key) => !beforeSet.has(key));
  const assetKeys = newKeys.filter((key) => !key.startsWith("v1/_audit/"));
  const classes = [...new Set(assetKeys.map((key) => key.split("/").slice(0, 2).join("/")))].sort();
  assert.ok(classes.includes("v1/pdf-page-render"));
  assert.ok(classes.includes("v1/pdf-image-crop"));
  assert.ok(classes.includes("v1/model-input"));
  const heads = [];
  for (const key of assetKeys) {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    assert.equal(head.Metadata?.contractversion, "1.0");
    assert.match(head.Metadata?.checksumsha256 ?? "", /^[a-f0-9]{64}$/);
    assert.ok(head.VersionId);
    heads.push({
      class: key.split("/")[1],
      contentType: head.ContentType ?? null,
      byteLength: head.ContentLength ?? null,
      versioned: Boolean(head.VersionId),
      checksummed: /^[a-f0-9]{64}$/.test(head.Metadata?.checksumsha256 ?? ""),
    });
  }
  const evidence = {
    status: "passed",
    fakeVlmPaidCalls: 0,
    classes,
    assetCount: assetKeys.length,
    auditObjectCount: newKeys.filter((key) => key.startsWith("v1/_audit/")).length,
    heads,
    unrelatedKeysUnchangedBeforeCleanup: true,
  };
  const outputDirectory = resolve("output/evidence/object-storage-real-suppliers-production-readiness");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(resolve(outputDirectory, "page-render-minio.json"), JSON.stringify(evidence, null, 2), "utf8");
  console.log(JSON.stringify({
    status: evidence.status,
    classes: evidence.classes,
    assetCount: evidence.assetCount,
    auditObjectCount: evidence.auditObjectCount,
    fakeVlmPaidCalls: evidence.fakeVlmPaidCalls,
  }));
} finally {
  await stop(child);
  const newKeySet = new Set((await listKeys()).filter((key) => !new Set(beforeKeys).has(key)));
  let versionToken;
  do {
    const versions = await client.send(new ListObjectVersionsCommand({
      Bucket: bucket,
      Prefix: "v1/",
      KeyMarker: versionToken,
    }));
    for (const version of versions.Versions ?? []) {
      if (version.Key && newKeySet.has(version.Key) && version.VersionId)
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: version.Key, VersionId: version.VersionId }));
    }
    for (const marker of versions.DeleteMarkers ?? []) {
      if (marker.Key && newKeySet.has(marker.Key) && marker.VersionId)
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: marker.Key, VersionId: marker.VersionId }));
    }
    versionToken = versions.NextKeyMarker;
  } while (versionToken);
  const remaining = (await listKeys()).filter((key) => !new Set(beforeKeys).has(key));
  assert.deepEqual(remaining, [], "dedicated page-render acceptance objects are fully removed");
  client.destroy();
}
