import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { parseEmbeddingProfiles } from "../src/embedding-job.js";
import { createConfiguredTableRetrievalTarget } from "../src/table-retrieval-persistence.js";
import {
  TableRetrievalService,
  tableArtifactFromReviewedModel,
  type ReviewedTableModel,
} from "../src/table-retrieval.js";

loadEnvFile(resolve(".env"));

const pdfPath = resolve("materials/pdf/产品技术白皮书.pdf");
const pdfBytes = await readFile(pdfPath);
const pdfHash = createHash("sha256").update(pdfBytes).digest("hex");
const remoteRunId = new Date().toISOString().replace(/[-:.TZ]/g, "");
const evidencePath = resolve("output/issue14-table-retrieval/remote-acceptance.json");
const workspaceRoot = resolve(".workspace", `issue14-remote-${remoteRunId}`);

const databaseConfigs = JSON.parse(required(process.env.DATABASE_PROFILES_JSON, "DATABASE_PROFILES_JSON"));
assert.ok(Array.isArray(databaseConfigs) && databaseConfigs.length === 1);
const databaseConfig = databaseConfigs[0] as Record<string, unknown>;
const databaseHost = required(databaseConfig.host, "database host");
assert.equal(isLocalHost(databaseHost), false, "remote acceptance refuses a local PostgreSQL host");
const mineruBase = process.env.MINERU_BASE_URL?.trim() || "https://mineru.net/api/v4";
assert.equal(isLocalHost(new URL(mineruBase).hostname), false, "remote acceptance refuses a local MinerU host");

const embeddingProfiles = parseEmbeddingProfiles(process.env);
assert.equal(embeddingProfiles.length, 1);
const embeddingProfile = embeddingProfiles[0];
assert.equal(isLocalHost(new URL(required(process.env.EMBEDDING_BASE_URL, "EMBEDDING_BASE_URL")).hostname), false, "remote acceptance refuses a local Embedding host");

const configuredTableTarget = createConfiguredTableRetrievalTarget(process.env, embeddingProfile.dimensions);
assert.ok(configuredTableTarget, "remote PostgreSQL profile is required");
const pgRepository = configuredTableTarget.repository;

let embeddingCalls = 0;
const tableService = new TableRetrievalService({
  repository: pgRepository,
  embedTexts: async (texts) => {
    embeddingCalls += 1;
    return embeddingProfile.embed(texts);
  },
  profile: {
    id: embeddingProfile.id,
    model: embeddingProfile.model,
    dimensions: embeddingProfile.dimensions,
  },
});

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const app = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
  cwd: resolve("."),
  env: {
    ...process.env,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(port),
    WORKSPACE_ROOT: workspaceRoot,
    MINERU_PARSE_TIMEOUT_MS: "7200000",
  },
  stdio: ["ignore", "ignore", "ignore"],
});

let batchId = "";
let documentId = "";
try {
  await waitFor(`${baseUrl}/api/health`, app);
  const form = new FormData();
  form.append("config", JSON.stringify({
    modelVersion: "vlm",
    language: "ch",
    enableFormula: true,
    enableTable: true,
    isOcr: false,
  }));
  form.append("files", new Blob([pdfBytes], { type: "application/pdf" }), "产品技术白皮书.pdf");
  const created = await requestJson(`${baseUrl}/api/batches`, { method: "POST", body: form });
  batchId = required(created.id, "batch id");
  assert.equal(created.documents.length, 1);
  documentId = required(created.documents[0].id, "document id");

  let terminalDocument = created.documents[0];
  for (let attempt = 0; attempt < 720 && !["done", "failed"].includes(terminalDocument.state); attempt += 1) {
    await delay(10_000);
    const batch = await requestJson(`${baseUrl}/api/batches/${batchId}`);
    terminalDocument = batch.documents.find((candidate: { id: string }) => candidate.id === documentId);
    assert.ok(terminalDocument);
  }
  assert.equal(terminalDocument.state, "done", terminalDocument.error ?? "remote MinerU did not complete");

  const preview = await requestJson(`${baseUrl}/api/batches/${batchId}/documents/${documentId}/chunks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      strategy: "structure",
      chunkSize: 512,
      chunkOverlap: 64,
      bufferSize: 2,
      breakpointPercentile: 95,
      semanticMaxChunkSize: 768,
      imagePolicy: "summary",
    }),
  });
  assert.ok(Array.isArray(preview.chunks));
  await requestJson(`${baseUrl}/api/batches/${batchId}/documents/${documentId}/review/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmReplacement: true }),
  });
  const review = await requestJson(`${baseUrl}/api/batches/${batchId}/documents/${documentId}/review`);
  const chunks = review.reviewState.draft.chunks as Array<Record<string, unknown>>;
  const tableIndex = chunks.findIndex((chunk) => chunk.type === "table" || chunk.finalType === "table");
  assert.ok(tableIndex >= 0, "remote MinerU review contains no Table Chunk");
  const tableChunk = chunks[tableIndex];
  const reviewedModel = tableChunk.reviewedModel as ReviewedTableModel;
  assert.equal(reviewedModel.type, "table");
  assert.ok(reviewedModel.columns.length > 0 && reviewedModel.rows.length > 0);

  const linkedText = chunks
    .slice(0, tableIndex)
    .filter((chunk) => chunk.type === "text" && typeof chunk.finalText === "string" && chunk.finalText.trim())
    .slice(-2)
    .map((chunk, order) => ({
      sourceChunkId: String(chunk.id),
      sourceChunkVersion: `remote-mineru-${batchId}`,
      order,
      finalText: String(chunk.finalText),
    }));
  const artifact = tableArtifactFromReviewedModel({
    reviewedModel,
    sourceSegments: Array.isArray(tableChunk.sourceSegments)
      ? (tableChunk.sourceSegments as Array<Record<string, unknown>>).map((segment) => ({
          id: String(segment.contentBlockId ?? segment.blockId),
          page: typeof segment.page === "number" ? segment.page : null,
          bbox: Array.isArray(segment.bbox) ? segment.bbox.map(Number) : null,
        }))
      : [],
  });
  const versionResult = await tableService.createVersion({
    logicalTableId: `whitepaper-${pdfHash.slice(0, 24)}`,
    artifact,
    finalSummary: "2025 年智能手机、笔记本、耳机和平板产品的屏幕、处理器、制程、存储、电池、连接和价格参数对比表。",
    sourceChunks: linkedText,
    at: new Date().toISOString(),
  });
  assert.equal(versionResult.bundle?.vectorReady, true);
  const queryReady = await tableService.confirmQueryReady(versionResult.version.tableVersionId);
  assert.equal(queryReady.queryReady, true);
  const searchResults = await tableService.search("哪些智能手机采用 3nm 制程");
  const hit = searchResults.find((result) => result.tableVersionId === versionResult.version.tableVersionId);
  assert.ok(hit, "remote pgvector search did not return the new Table Version");
  const persisted = await pgRepository.getVersion(versionResult.version.tableVersionId);
  assert.equal(persisted?.artifact.rows.length, reviewedModel.rows.length);
  assert.equal(embeddingCalls, 2, "one Bundle embedding and one query embedding are expected");

  await mkdir(resolve(evidencePath, ".."), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify({
    contractVersion: "issue14-remote-acceptance-1.0",
    material: "materials/pdf/产品技术白皮书.pdf",
    materialSha256: pdfHash,
    mineru: {
      remote: true,
      submissionCount: 1,
      terminalState: terminalDocument.state,
      batchId,
      documentId,
    },
    table: {
      columns: reviewedModel.columns.length,
      rows: reviewedModel.rows.length,
      linkedTextCount: linkedText.length,
      logicalTableId: versionResult.version.logicalTableId,
      tableVersionId: versionResult.version.tableVersionId,
    },
    embedding: {
      remote: true,
      profileId: embeddingProfile.id,
      dimensions: embeddingProfile.dimensions,
      callCount: embeddingCalls,
      vectorValuesRecorded: false,
    },
    postgres: {
      remote: true,
      profileId: configuredTableTarget.profileId,
      schemaMigration: "2.1-table-retrieval-v1",
      vectorReady: versionResult.bundle?.vectorReady,
      queryReady: persisted?.queryReady,
      ordinarySearchReturnedVersion: Boolean(hit),
    },
  }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    status: "succeeded",
    mineruState: terminalDocument.state,
    columns: reviewedModel.columns.length,
    rows: reviewedModel.rows.length,
    embeddingCalls,
    vectorReady: versionResult.bundle?.vectorReady,
    queryReady: persisted?.queryReady,
    ordinarySearchReturnedVersion: Boolean(hit),
    evidence: "output/issue14-table-retrieval/remote-acceptance.json",
  }));
} finally {
  await stop(app);
  await pgRepository.close();
}

async function requestJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${payload.code ?? payload.error ?? "request failed"}`);
  return payload;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No test port"));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitFor(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await delay(250);
  }
  throw new Error("server did not become healthy");
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    delay(3_000),
  ]);
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function isLocalHost(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "0.0.0.0"].includes(host.trim().toLowerCase());
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
