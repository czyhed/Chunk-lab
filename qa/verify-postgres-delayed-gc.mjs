import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { Pool } from "pg";

for (const name of [
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

async function json(response) {
  const payload = await response.json();
  if (!response.ok)
    throw new Error(`HTTP ${response.status}: ${payload.code ?? payload.error ?? "request failed"}`);
  return payload;
}

const profileId = "local-pgvector-v2-1024";
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const workspaceRoot = resolve(".workspace", `postgres-delayed-gc-${process.pid}`);
const databaseProfiles = JSON.stringify([{
  id: profileId,
  name: "Local pgvector schema 2.0 (1024)",
  kind: "pgvector",
  schemaVersion: "2.0",
  host: "127.0.0.1",
  port: 54329,
  databaseEnv: "RAG_PG_DATABASE",
  userEnv: "RAG_PG_USER",
  passwordEnv: "RAG_PG_PASSWORD",
}]);
const app = spawn(
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
      DATABASE_PROFILES_JSON: databaseProfiles,
      MODEL_PROFILES_JSON: "[]",
      MINERU_API_TOKEN: process.env.MINERU_API_TOKEN || "postgres-gc-no-call",
    },
    stdio: ["ignore", "ignore", "ignore"],
  },
);
const pool = new Pool({
  host: "127.0.0.1",
  port: 54329,
  database: process.env.RAG_PG_DATABASE,
  user: process.env.RAG_PG_USER,
  password: process.env.RAG_PG_PASSWORD,
  max: 1,
});

let batchId;
let documentId;
try {
  await waitFor(`${baseUrl}/api/health`, app);
  const demo = await json(await fetch(`${baseUrl}/api/demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }));
  batchId = demo.id;
  documentId = demo.documents[0].id;
  const chunkId = `gc-acceptance-${process.pid}`;

  await json(await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}/database-records?profileId=${profileId}`,
  ));
  const before = await pool.query(
    "SELECT count(*)::int AS count FROM rag.vector_records_v2_d1024 WHERE target_id=$1",
    [profileId],
  );
  await pool.query(
    `INSERT INTO rag.documents(target_id, document_id)
     VALUES ($1,$2) ON CONFLICT (target_id, document_id) DO NOTHING`,
    [profileId, documentId],
  );
  const seeded = await pool.query(
    `INSERT INTO rag.vector_records_v2_d1024 (
       target_id, document_id, chunk_id, schema_version, chunk_type,
       content_payload, final_text, embedding_text_hash, embedding_profile_id,
       embedding_model, vector_dimensions, embedding, source_segments,
       image_object_uri, image_object_reference, image_policy, strategy_version,
       context_version, content_hash, updated_at, deleted_at, delete_after
     )
     SELECT $1,$2,$3,schema_version,chunk_type,content_payload,final_text,
       embedding_text_hash,embedding_profile_id,embedding_model,vector_dimensions,
       embedding,source_segments,NULL,NULL,NULL,strategy_version,context_version,
       $3,now(),NULL,NULL
     FROM rag.vector_records_v2_d1024
     WHERE target_id=$1 AND deleted_at IS NULL AND chunk_type='text'
     ORDER BY chunk_id LIMIT 1`,
    [profileId, documentId, chunkId],
  );
  assert.equal(seeded.rowCount, 1, "a live text vector record is required for the GC rehearsal");

  const publicBefore = await json(await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}/database-records?profileId=${profileId}`,
  ));
  assert.equal(publicBefore.records.length, 1);
  assert.equal(/"vector"\s*:/.test(JSON.stringify(publicBefore)), false);

  const unconfirmed = await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}/database-gc`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId }),
    },
  );
  assert.equal(unconfirmed.status, 409);

  const deleted = await json(await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    },
  ));
  assert.equal(deleted.databaseSoftDeleted.find((item) => item.profileId === profileId)?.count, 1);
  const publicAfterSoftDelete = await json(await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}/database-records?profileId=${profileId}`,
  ));
  assert.equal(publicAfterSoftDelete.records.length, 0);

  const gc = await json(await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}/database-gc`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId, confirm: true }),
    },
  ));
  assert.equal(gc.deleted, 1);
  const repeatedGc = await json(await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}/database-gc`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId, confirm: true }),
    },
  ));
  assert.equal(repeatedGc.deleted, 0);
  assert.equal(repeatedGc.reused, true);

  const audit = await pool.query(
    `SELECT action, count(*)::int AS count FROM rag.deletion_audit
     WHERE target_id=$1 AND document_id=$2 GROUP BY action ORDER BY action`,
    [profileId, documentId],
  );
  assert.deepEqual(audit.rows, [
    { action: "physical_delete", count: 1 },
    { action: "soft_delete", count: 1 },
  ]);
  const after = await pool.query(
    "SELECT count(*)::int AS count FROM rag.vector_records_v2_d1024 WHERE target_id=$1",
    [profileId],
  );
  assert.equal(after.rows[0].count, before.rows[0].count);

  const objectList = await json(await fetch(
    `${baseUrl}/api/batches/${batchId}/objects?documentId=${documentId}&includeDeleted=true`,
  ));
  const prefixes = [...new Set(objectList.objects.map((object) => {
    const [contract, classification] = object.key.split("/");
    return `${contract}/${classification}/${batchId}/`;
  }))];
  let objectGcDeleted = 0;
  for (const prefix of prefixes) {
    const result = await json(await fetch(`${baseUrl}/api/batches/${batchId}/object-gc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefix }),
    }));
    objectGcDeleted += result.deleted;
  }

  const migration = await pool.query(
    "SELECT count(*)::int AS count FROM rag.schema_migrations WHERE version='2.0-gc-audit-v1'",
  );
  assert.equal(migration.rows[0].count, 1);
  const evidence = {
    status: "succeeded",
    batchId,
    documentId,
    profileId,
    schemaVersion: "2.0",
    migrationVersion: "2.0-gc-audit-v1",
    publicConfirmationRequired: true,
    publicRecordHiddenAfterSoftDelete: true,
    softDeleted: 1,
    physicalDeleted: 1,
    repeatedGcDeleted: 0,
    softDeleteAuditRecords: 1,
    physicalDeleteAuditRecords: 1,
    unrelatedVectorRecordCountUnchanged: true,
    dedicatedObjectGcDeleted: objectGcDeleted,
    paidSupplierCalls: { mineru: 0, vlm: 0, context: 0, embedding: 0 },
  };
  const directory = resolve("output/evidence/storage-production-like-closure-v2");
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "postgres-delayed-gc.json"), JSON.stringify(evidence, null, 2), "utf8");
  console.log(JSON.stringify(evidence));
} finally {
  await pool.end();
  await stop(app);
  await rm(workspaceRoot, { recursive: true, force: true });
}
