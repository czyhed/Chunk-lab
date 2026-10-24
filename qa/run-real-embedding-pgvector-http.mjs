import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

for (const name of [
  "MINIO_ENDPOINT",
  "MINIO_BUCKET",
  "MINIO_ACCESS_KEY",
  "MINIO_SECRET_KEY",
  "RAG_PG_USER",
  "RAG_PG_PASSWORD",
  "RAG_PG_DATABASE",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_API_KEY",
  "EMBEDDING_MODEL",
]) if (!process.env[name]?.trim()) throw new Error(`${name} is required`);

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

const port = await freePort();
const workspaceRoot = resolve(".workspace", `real-embedding-pg-${process.pid}`);
const baseUrl = `http://127.0.0.1:${port}`;
const appEnv = {
  ...process.env,
  NODE_ENV: "test",
  PORT: String(port),
  WORKSPACE_ROOT: workspaceRoot,
  MINERU_API_TOKEN: process.env.MINERU_API_TOKEN || "real-embedding-no-mineru-call",
  EMBEDDING_PROFILES_JSON: JSON.stringify([{
    id: "real-embedding-1024",
    name: "Configured real Embedding 1024",
    baseUrl: process.env.EMBEDDING_BASE_URL,
    apiKey: "${EMBEDDING_API_KEY}",
    model: process.env.EMBEDDING_MODEL,
    dimensions: 1024,
    maxTokens: 4096,
    timeoutMs: 30_000,
  }]),
  DATABASE_PROFILES_JSON: JSON.stringify([{
    id: "local-pgvector-v2-1024",
    name: "Local pgvector schema 2.0 (1024)",
    kind: "pgvector",
    schemaVersion: "2.0",
    host: "127.0.0.1",
    port: 54329,
    databaseEnv: "RAG_PG_DATABASE",
    userEnv: "RAG_PG_USER",
    passwordEnv: "RAG_PG_PASSWORD",
  }]),
};
let app;
let batchId;
let documentId;
try {
  app = spawn(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "src/server.ts"],
    { cwd: resolve("."), env: appEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  await waitFor(`${baseUrl}/api/health`, app);

  const form = new FormData();
  form.append("files", new Blob([
    "# Embedding 验收\n\n这是一个中文真实向量化小批次。",
  ], { type: "text/plain" }), "embedding-acceptance.txt");
  const uploaded = await json(await fetch(`${baseUrl}/api/batches`, {
    method: "POST",
    body: form,
  }));
  batchId = uploaded.id;
  documentId = uploaded.documents[0].id;
  const preview = await json(await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}/chunks`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy: "structure", chunkSize: 512, chunkOverlap: 0 }),
    },
  ));
  assert.equal(preview.chunks.length, 1);
  await json(await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}/review/confirm`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  ));

  const profiles = await json(await fetch(`${baseUrl}/api/embedding-profiles`));
  assert.deepEqual(profiles.profiles, [{
    id: "real-embedding-1024",
    name: "Configured real Embedding 1024",
    dimensions: 1024,
    maxTokens: 4096,
  }]);
  const embedding = await json(await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}/embedding-jobs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "real-embedding-1024" }),
    },
  ));
  assert.equal(embedding.job.summary.succeeded, 1);
  assert.equal(embedding.job.items[0].vectorRecord?.dimensions, 1024);
  assert.equal(/"vector"\s*:/.test(JSON.stringify(embedding)), false);

  const database = await json(await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}/database-jobs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId: "local-pgvector-v2-1024",
        embeddingJobId: embedding.job.id,
      }),
    },
  ));
  assert.equal(database.job.summary.written, 1);
  const records = await json(await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}/database-records?profileId=local-pgvector-v2-1024`,
  ));
  assert.equal(records.records.length, 1);
  assert.equal(/"vector"\s*:/.test(JSON.stringify(records)), false);
  assert.equal(records.records[0].schemaVersion, "2.0");
  assert.equal(records.records[0].vectorDimensions, 1024);

  await json(await fetch(`${baseUrl}/api/batches/${batchId}/export?contractVersion=2.1`));
  await stop(app);
  app = spawn(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "src/server.ts"],
    { cwd: resolve("."), env: appEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  await waitFor(`${baseUrl}/api/health`, app);
  const afterRestart = await json(await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}/database-records?profileId=local-pgvector-v2-1024`,
  ));
  assert.equal(afterRestart.records.length, 1);
  assert.equal(afterRestart.records[0].vectorDimensions, 1024);
  assert.equal(/"vector"\s*:/.test(JSON.stringify(afterRestart)), false);

  const evidence = {
    status: "succeeded",
    batchId,
    documentId,
    embeddingProfileId: "real-embedding-1024",
    embeddingModel: process.env.EMBEDDING_MODEL,
    observedDimensions: 1024,
    embeddingPaidCallsThisRun: 1,
    databaseSchemaVersion: "2.0",
    databaseRecordCount: 1,
    publicRecordsOmitVector: true,
    applicationRestartRecovered: true,
    mineruPaidCallsThisRun: 0,
    vlmPaidCallsThisRun: 0,
    contextPaidCallsThisRun: 0,
  };
  const directory = resolve("output/evidence/object-storage-real-suppliers-production-readiness");
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "real-embedding-pgvector-http.json"), JSON.stringify(evidence, null, 2), "utf8");
  console.log(JSON.stringify(evidence));
} finally {
  await stop(app);
}
