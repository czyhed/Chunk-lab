import assert from "node:assert/strict";
import { loadEnvFile } from "node:process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

try {
  loadEnvFile(resolve(".env"));
} catch {}

const evidenceDirectory = resolve(
  "output/evidence/object-storage-real-suppliers-production-readiness",
);
const textExtensions = new Set([
  ".css", ".html", ".js", ".json", ".md", ".mjs", ".ps1", ".ts", ".yaml", ".yml",
]);
const scanRoots = [resolve("src"), resolve("qa"), resolve("docs"), evidenceDirectory];
const evidenceTextRoots = [
  evidenceDirectory,
  resolve("docs/tickets/FOLLOWUP-object-storage-real-suppliers-production-readiness.md"),
];
const secretNames = [
  "MINERU_API_TOKEN",
  "EMBEDDING_API_KEY",
  "CONTEXT_API_KEY",
  "MINIO_ACCESS_KEY",
  "MINIO_SECRET_KEY",
  "RAG_PG_PASSWORD",
];
const configuredSecrets = [...new Set(secretNames.flatMap((name) => {
  const value = process.env[name]?.trim();
  return value && value.length >= 8 && !/(fixture|no-call|example|changeme)/i.test(value)
    ? [value]
    : [];
}))];

async function filesUnder(path) {
  const entry = await import("node:fs/promises").then(({ stat }) => stat(path));
  if (entry.isFile()) return [path];
  const files = [];
  for (const child of await readdir(path, { withFileTypes: true })) {
    const childPath = resolve(path, child.name);
    if (child.isDirectory()) files.push(...await filesUnder(childPath));
    else if (child.isFile()) files.push(childPath);
  }
  return files;
}

const textFiles = (await Promise.all(scanRoots.map(filesUnder)))
  .flat()
  .filter((path) => textExtensions.has(extname(path).toLowerCase()));
let actualSecretValueMatches = 0;
for (const path of textFiles) {
  const value = await readFile(path, "utf8");
  for (const secret of configuredSecrets) {
    if (value.includes(secret)) actualSecretValueMatches += 1;
  }
}

const evidenceFiles = (await Promise.all(evidenceTextRoots.map(filesUnder)))
  .flat()
  .filter((path) => textExtensions.has(extname(path).toLowerCase()));
const credentialAssignment = /"(?:authorization|apiKey|password|secretKey|token)"\s*:\s*"(?!\[REDACTED)[^"]+"/gi;
const forbiddenUrl = /(?:Bearer\s+[A-Za-z0-9._~+/-]{8,}|https?:\/\/[^\s"']+[?&](?:x-amz-|signature=|token=)|postgres(?:ql)?:\/\/[^\s"']+)/gi;
const binaryPayload = /data:[^\s"']+;base64,/gi;
let evidenceCredentialPatterns = 0;
let evidenceBinaryOrDataUrlPayloads = 0;
let evidenceJsonParseFailures = 0;
let evidenceVectorPayloads = 0;
for (const path of evidenceFiles) {
  const value = await readFile(path, "utf8");
  evidenceCredentialPatterns += (value.match(credentialAssignment) ?? []).length;
  evidenceCredentialPatterns += (value.match(forbiddenUrl) ?? []).length;
  evidenceBinaryOrDataUrlPayloads += (value.match(binaryPayload) ?? []).length;
  if (extname(path).toLowerCase() === ".json") {
    try {
      const parsed = JSON.parse(value);
      evidenceVectorPayloads += countVectorArrays(parsed);
    } catch {
      evidenceJsonParseFailures += 1;
    }
  }
}

const chain = JSON.parse(await readFile(resolve(evidenceDirectory, "real-context-embedding-full-chain.json"), "utf8"));
const baseUrl = process.env.ACCEPTANCE_BASE_URL || "http://127.0.0.1:43119";
const endpoints = [
  "/api/health",
  "/api/model-profiles",
  "/api/embedding-profiles",
  "/api/database-profiles",
  `/api/batches/${chain.batchId}`,
  `/api/batches/${chain.batchId}/objects`,
  `/api/batches/${chain.batchId}/documents/${chain.documentId}/review`,
  `/api/batches/${chain.batchId}/documents/${chain.documentId}/database-records?profileId=${encodeURIComponent(chain.database.profileId)}`,
];
let publicHttpForbiddenPatterns = 0;
let publicHttpVectorFields = 0;
for (const endpoint of endpoints) {
  const response = await fetch(`${baseUrl}${endpoint}`);
  assert.equal(response.status, 200, `public scan endpoint failed: ${endpoint}`);
  const text = await response.text();
  for (const secret of configuredSecrets) {
    if (text.includes(secret)) publicHttpForbiddenPatterns += 1;
  }
  publicHttpForbiddenPatterns += (text.match(credentialAssignment) ?? []).length;
  publicHttpForbiddenPatterns += (text.match(forbiddenUrl) ?? []).length;
  publicHttpVectorFields += countVectorArrays(JSON.parse(text));
}

const screenshotCount = (await readdir(evidenceDirectory))
  .filter((name) => /\.(?:png|jpe?g)$/i.test(name)).length;
const result = {
  status: "passed",
  scannedTextFiles: textFiles.length,
  configuredSecretValues: configuredSecrets.length,
  actualSecretValueMatches,
  evidenceCredentialPatterns,
  evidenceVectorPayloads,
  evidenceBinaryOrDataUrlPayloads,
  evidenceJsonParseFailures,
  screenshotCount,
  publicHttpCheckedEndpoints: endpoints.length,
  publicHttpForbiddenPatterns,
  publicHttpVectorFields,
};
for (const [name, count] of Object.entries(result)) {
  if (name !== "status" && name !== "scannedTextFiles" && name !== "configuredSecretValues" &&
      name !== "screenshotCount" && name !== "publicHttpCheckedEndpoints")
    assert.equal(count, 0, `${name} must be zero`);
}
await mkdir(evidenceDirectory, { recursive: true });
await writeFile(resolve(evidenceDirectory, "secret-scan.json"), JSON.stringify(result, null, 2), "utf8");
console.log(JSON.stringify(result));

function countVectorArrays(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return 0;
  seen.add(value);
  let count = 0;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "vector" || key === "embedding") && Array.isArray(child)) count += 1;
    count += countVectorArrays(child, seen);
  }
  return count;
}
