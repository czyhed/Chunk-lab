import assert from "node:assert/strict";
import { loadEnvFile } from "node:process";
import { extname, resolve } from "node:path";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";

try {
  loadEnvFile(resolve(".env"));
} catch {}

const closureDirectory = resolve("output/evidence/storage-production-like-closure-v2");
const evidenceRoots = [
  closureDirectory,
  resolve("output/evidence/dashscope-vlm-real-acceptance"),
  resolve("docs/tickets/FOLLOWUP-storage-production-like-closure-v2.md"),
  resolve("docs/tickets/FOLLOWUP-dashscope-vlm-real-acceptance.md"),
];
const scanRoots = [
  resolve("src"),
  resolve("qa"),
  resolve("docs"),
  resolve("output/evidence/storage-production-like-closure-v2"),
  resolve("output/evidence/dashscope-vlm-real-acceptance"),
  ...[
    "app.js", "bbox-mapping.js", "chunk-review-links.js", "compose.minio.yml",
    "compose.postgres.yml", "index.html", "manual-annotations.js", "pdf-render-coordinator.js",
    "pdf-surface.js", "review-layout.js", "styles.css", "user-facing-errors.js", ".env.example",
  ].map((path) => resolve(path)),
];
const logFiles = [
  resolve(".workspace/real-mineru-matrix-v1/server-4180.stdout.log"),
  resolve(".workspace/real-mineru-matrix-v1/server-4180.stderr.log"),
];
const textExtensions = new Set([".css", ".html", ".js", ".json", ".md", ".mjs", ".ps1", ".ts", ".yaml", ".yml"]);
const secretNames = [
  "MINERU_API_TOKEN", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY",
  "EMBEDDING_API_KEY", "CONTEXT_API_KEY", "DASHSCOPE_VLM_API_KEY",
  "RAG_PG_DATABASE", "RAG_PG_USER", "RAG_PG_PASSWORD",
];
const configuredSecrets = [...new Set(secretNames.flatMap((name) => {
  const value = process.env[name]?.trim();
  return value && value.length >= 8 && !/(fixture|no-call|example|changeme)/i.test(value)
    ? [value]
    : [];
}))];
const patterns = [
  ["authorization", /authorization\s*[:=]\s*(?:bearer|basic)\s+[a-z0-9._~+/=-]+/i],
  ["connection-string", /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"']+/i],
  ["presigned-url", /[?&](?:X-Amz-(?:Credential|Signature|Security-Token)|Signature)=/i],
  ["data-url", /data:(?:image|application)\/[a-z0-9.+-]+;base64,/i],
];

async function filesUnder(path) {
  const entry = await stat(path);
  if (entry.isFile()) return [path];
  const files = [];
  for (const child of await readdir(path, { withFileTypes: true })) {
    const childPath = resolve(path, child.name);
    if (child.isDirectory()) files.push(...await filesUnder(childPath));
    else if (child.isFile()) files.push(childPath);
  }
  return files;
}

const scannedFiles = [...new Set((await Promise.all(scanRoots.map(filesUnder))).flat())];
let exactSecretMatches = 0;
for (const path of scannedFiles) {
  const value = await readFile(path);
  const latin = value.toString("latin1");
  for (const secret of configuredSecrets) if (latin.includes(secret)) exactSecretMatches += 1;
}

const evidenceFiles = [...new Set((await Promise.all(evidenceRoots.map(filesUnder))).flat())];
let evidenceCredentialPatterns = 0;
let evidenceVectorPayloads = 0;
let evidenceJsonParseFailures = 0;
for (const path of [...evidenceFiles, ...logFiles]) {
  const value = await readFile(path);
  const latin = value.toString("latin1");
  for (const [, pattern] of patterns) if (pattern.test(latin)) evidenceCredentialPatterns += 1;
  if (extname(path).toLowerCase() === ".json") {
    try {
      evidenceVectorPayloads += countVectorArrays(JSON.parse(value.toString("utf8")));
    } catch {
      evidenceJsonParseFailures += 1;
    }
  }
}

const baseUrl = process.env.ACCEPTANCE_BASE_URL || "http://127.0.0.1:4180";
const batchId = "db117e22-bb56-41bd-a334-57a2ca75d18b";
const documentId = "911e5f28-2ba9-4e12-b1fe-5e00df40b62f";
const endpoints = [
  "/api/health",
  "/api/model-profiles",
  "/api/embedding-profiles",
  "/api/database-profiles",
  `/api/batches/${batchId}`,
  `/api/batches/${batchId}/objects?documentId=${documentId}`,
  `/api/batches/${batchId}/documents/${documentId}/review`,
  `/api/batches/${batchId}/documents/${documentId}/database-records?profileId=local-pgvector-v2-1024`,
  `/api/batches/${batchId}/export?contractVersion=2.1`,
];
let publicResponseFindings = 0;
let publicVectorPayloads = 0;
for (const endpoint of endpoints) {
  const response = await fetch(`${baseUrl}${endpoint}`);
  assert.equal(response.status, 200, `public scan endpoint failed: ${endpoint.split("?")[0]}`);
  const text = await response.text();
  for (const secret of configuredSecrets) if (text.includes(secret)) publicResponseFindings += 1;
  for (const [, pattern] of patterns) if (pattern.test(text)) publicResponseFindings += 1;
  publicVectorPayloads += countVectorArrays(JSON.parse(text));
}

const result = {
  status: "passed",
  scannedFiles: scannedFiles.length,
  evidenceAndLogFiles: evidenceFiles.length + logFiles.length,
  screenshotFiles: evidenceFiles.filter((path) => /\.(?:png|jpe?g)$/i.test(path)).length,
  configuredSecretValues: configuredSecrets.length,
  exactSecretMatches,
  evidenceCredentialPatterns,
  evidenceVectorPayloads,
  evidenceJsonParseFailures,
  publicHttpCheckedEndpoints: endpoints.length,
  publicResponseFindings,
  publicVectorPayloads,
};
for (const key of [
  "exactSecretMatches", "evidenceCredentialPatterns", "evidenceVectorPayloads",
  "evidenceJsonParseFailures", "publicResponseFindings", "publicVectorPayloads",
]) assert.equal(result[key], 0, `${key} must be zero`);
await mkdir(closureDirectory, { recursive: true });
await writeFile(resolve(closureDirectory, "secret-scan.json"), JSON.stringify(result, null, 2), "utf8");
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
