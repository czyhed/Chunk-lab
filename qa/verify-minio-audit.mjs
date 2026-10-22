import assert from "node:assert/strict";
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

for (const name of [
  "MINIO_ENDPOINT",
  "MINIO_BUCKET",
  "MINIO_ACCESS_KEY",
  "MINIO_SECRET_KEY",
  "AUDIT_BATCH_ID",
]) if (!process.env[name]?.trim()) throw new Error(`${name} is required`);

const client = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT,
  region: process.env.MINIO_REGION || "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  },
});
const prefix = `v1/_audit/${process.env.AUDIT_BATCH_ID}/`;

try {
  const keys = [];
  let continuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: process.env.MINIO_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    keys.push(...(page.Contents ?? []).flatMap((item) => item.Key ? [item.Key] : []));
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);
  assert.ok(keys.length > 0, "acceptance audit prefix is empty");

  const actionCounts = { put: 0, cache_hit: 0, soft_delete: 0, physical_delete: 0 };
  let versionedHeads = 0;
  for (const key of keys) {
    const head = await client.send(new HeadObjectCommand({
      Bucket: process.env.MINIO_BUCKET,
      Key: key,
    }));
    assert.equal(head.ContentType, "application/json");
    assert.ok((head.ContentLength ?? 0) > 0);
    if (head.VersionId) versionedHeads += 1;
    const object = await client.send(new GetObjectCommand({
      Bucket: process.env.MINIO_BUCKET,
      Key: key,
    }));
    assert.ok(object.Body);
    const record = JSON.parse(await object.Body.transformToString());
    assert.equal(record.batchId, process.env.AUDIT_BATCH_ID);
    assert.ok(Object.hasOwn(actionCounts, record.action));
    actionCounts[record.action] += 1;
  }
  assert.ok(actionCounts.put >= 4);
  assert.equal(actionCounts.soft_delete, 4);
  assert.equal(actionCounts.physical_delete, 4);
  assert.equal(versionedHeads, keys.length);

  console.log(JSON.stringify({
    status: "succeeded",
    batchId: process.env.AUDIT_BATCH_ID,
    prefix,
    auditObjectCount: keys.length,
    actionCounts,
    allHeadsPassed: true,
    allAuditObjectsVersioned: true,
    auditBodiesProjected: false,
    paidSupplierCalls: 0,
  }));
} finally {
  client.destroy();
}
