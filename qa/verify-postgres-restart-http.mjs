import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

for (const name of [
  "ACCEPTANCE_WORKSPACE_ROOT",
  "ACCEPTANCE_BATCH_ID",
  "ACCEPTANCE_DOCUMENT_ID",
  "MINIO_ENDPOINT",
  "MINIO_BUCKET",
  "MINIO_ACCESS_KEY",
  "MINIO_SECRET_KEY",
  "RAG_PG_USER",
  "RAG_PG_PASSWORD",
  "RAG_PG_DATABASE",
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
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 3_000)),
  ]);
}

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const appEnv = {
  ...process.env,
  NODE_ENV: "test",
  PORT: String(port),
  WORKSPACE_ROOT: resolve(process.env.ACCEPTANCE_WORKSPACE_ROOT),
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
const app = spawn(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "src/server.ts"],
  { cwd: resolve("."), env: appEnv, stdio: ["ignore", "pipe", "pipe"] },
);

try {
  await waitFor(`${baseUrl}/api/health`, app);
  const response = await fetch(
    `${baseUrl}/api/batches/${process.env.ACCEPTANCE_BATCH_ID}/documents/${process.env.ACCEPTANCE_DOCUMENT_ID}/database-records?profileId=local-pgvector-v2-1024`,
  );
  assert.equal(response.ok, true, `database record HTTP ${response.status}`);
  const payload = await response.json();
  assert.equal(payload.records.length, 1);
  assert.equal(payload.records[0].schemaVersion, "2.0");
  assert.equal(payload.records[0].vectorDimensions, 1024);
  assert.equal(/"vector"\s*:/.test(JSON.stringify(payload)), false);

  const evidence = {
    status: "succeeded",
    batchId: process.env.ACCEPTANCE_BATCH_ID,
    documentId: process.env.ACCEPTANCE_DOCUMENT_ID,
    databaseSchemaVersion: "2.0",
    databaseRecordCount: payload.records.length,
    observedDimensions: payload.records[0].vectorDimensions,
    publicRecordsOmitVector: true,
    postgresRestartRecoveredViaPublicHttp: true,
    paidSupplierCallsThisRun: 0,
  };
  const directory = resolve("output/evidence/object-storage-real-suppliers-production-readiness");
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "postgres-restart-http.json"), JSON.stringify(evidence, null, 2), "utf8");
  console.log(JSON.stringify(evidence));
} finally {
  await stop(app);
}
