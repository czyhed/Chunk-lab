import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

const phase = process.env.ISSUE10_MINIO_PHASE ?? "check";
const evidenceDirectory = resolve("output/issue10-image-reference-vlm");
const acceptance = JSON.parse(await readFile(
  resolve(evidenceDirectory, "http-acceptance.json"),
  "utf8",
));
const accessKey = process.env.MINIO_ACCESS_KEY;
const secretKey = process.env.MINIO_SECRET_KEY;
assert.ok(accessKey && secretKey, "MinIO credentials must be supplied through the environment");
const client = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT ?? "http://127.0.0.1:9000",
  region: process.env.MINIO_REGION ?? "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
});

const checks = [];
for (const policy of acceptance.policies) {
  const uri = new URL(policy.objectUri);
  const bucket = uri.hostname;
  const key = uri.pathname.replace(/^\//, "");
  const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  checks.push({
    policy: policy.policy,
    uri: policy.objectUri,
    exists: true,
    contentType: result.ContentType,
    checksumMetadataPresent: typeof result.Metadata?.sha256 === "string",
    binaryBodyRead: false,
  });
}
assert.equal(checks.length, 3);
assert.equal(checks.every((item) => item.exists && item.checksumMetadataPresent), true);
await writeFile(
  resolve(evidenceDirectory, `minio-persistence-${phase}.json`),
  `${JSON.stringify({ phase, checkedAt: new Date().toISOString(), checks }, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify({ phase, objectCount: checks.length, allPresent: true }));
