import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

const materials = [
  { relativePath: "materials/pdf/多图片PDF.pdf", contentType: "application/pdf", expectsVisualCopy: false },
  { relativePath: "materials/pdf/产品技术白皮书.pdf", contentType: "application/pdf", expectsVisualCopy: false },
  { relativePath: "materials/docx/多图片.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", expectsVisualCopy: true },
  { relativePath: "materials/pptx/产品发布会.pptx", contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", expectsVisualCopy: true },
  { relativePath: "materials/excel/产品价格对比表.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", expectsVisualCopy: true },
  { relativePath: "materials/pptx/images_launch/image-product_4x3.jpg", contentType: "image/jpeg", expectsVisualCopy: false },
  { relativePath: "materials/pptx/images_market/chart-sales-trend.png", contentType: "image/png", expectsVisualCopy: false },
];

for (const name of [
  "MINERU_API_TOKEN",
  "MINIO_ENDPOINT",
  "MINIO_BUCKET",
  "MINIO_ACCESS_KEY",
  "MINIO_SECRET_KEY",
]) if (!process.env[name]?.trim()) throw new Error(`${name} is required`);

const workspaceRoot = resolve(
  process.env.REAL_MINERU_WORKSPACE_ROOT ?? ".workspace/real-mineru-matrix-v1",
);
const ledgerPath = resolve(
  process.env.REAL_MINERU_LEDGER_PATH ?? ".workspace/real-mineru-matrix-ledger.json",
);
const evidencePath = resolve(
  process.env.REAL_MINERU_EVIDENCE_PATH ??
    "output/evidence/object-storage-real-suppliers-production-readiness/real-mineru-matrix.json",
);
const pollIntervalMs = Number(process.env.REAL_MINERU_POLL_INTERVAL_MS ?? 10_000);
const maxPollAttempts = Number(process.env.REAL_MINERU_MAX_POLL_ATTEMPTS ?? 720);
const terminalStates = new Set(["done", "failed"]);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function atomicJson(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

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

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!response.ok)
    throw new Error(`HTTP ${response.status}: ${payload.code ?? payload.error ?? "request failed"}`);
  return payload;
}

async function materialFacts(material) {
  const path = resolve(material.relativePath);
  const bytes = await readFile(path);
  const details = await stat(path);
  return {
    ...material,
    path,
    fileName: material.relativePath.split("/").at(-1),
    byteLength: details.size,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

const facts = await Promise.all(materials.map(materialFacts));
let ledger;
if (await exists(ledgerPath)) {
  ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.equal(ledger.contractVersion, "real-mineru-matrix-ledger-1.0");
  assert.equal(ledger.entries.length, facts.length);
  for (const fact of facts) {
    const entry = ledger.entries.find((candidate) => candidate.relativePath === fact.relativePath);
    assert.ok(entry, `ledger is missing ${fact.relativePath}`);
    assert.equal(entry.checksumSha256, fact.checksumSha256, `material changed: ${fact.relativePath}`);
    if (entry.status === "submission_started" && !entry.batchId)
      throw new Error(`Submission outcome requires manual inspection; refusing replay: ${fact.relativePath}`);
  }
} else {
  ledger = {
    contractVersion: "real-mineru-matrix-ledger-1.0",
    createdAt: new Date().toISOString(),
    policy: "one-independent-submission-per-material-no-automatic-replay",
    entries: facts.map((fact) => ({
      relativePath: fact.relativePath,
      fileName: fact.fileName,
      byteLength: fact.byteLength,
      checksumSha256: fact.checksumSha256,
      expectsVisualCopy: fact.expectsVisualCopy,
      submissionCount: 0,
      status: "not_started",
    })),
  };
  await atomicJson(ledgerPath, ledger);
}

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const appEnv = {
  ...process.env,
  NODE_ENV: "test",
  PORT: String(port),
  WORKSPACE_ROOT: workspaceRoot,
  MINERU_PARSE_TIMEOUT_MS: "7200000",
};
const spawnApp = () => spawn(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "src/server.ts"],
  { cwd: resolve("."), env: appEnv, stdio: ["ignore", "ignore", "ignore"] },
);
let app = spawnApp();

try {
  await waitFor(`${baseUrl}/api/health`, app);
  for (const fact of facts) {
    const entry = ledger.entries.find((candidate) => candidate.relativePath === fact.relativePath);
    if (entry.submissionCount === 0) {
      entry.submissionCount = 1;
      entry.status = "submission_started";
      entry.submissionStartedAt = new Date().toISOString();
      await atomicJson(ledgerPath, ledger);

      const form = new FormData();
      form.append("config", JSON.stringify({
        modelVersion: "vlm",
        language: "ch",
        enableFormula: true,
        enableTable: true,
        isOcr: false,
      }));
      form.append(
        "files",
        new Blob([await readFile(fact.path)], { type: fact.contentType }),
        fact.fileName,
      );
      const created = await requestJson(`${baseUrl}/api/batches`, {
        method: "POST",
        body: form,
      });
      assert.equal(created.documents.length, 1);
      entry.batchId = created.id;
      entry.documentId = created.documents[0].id;
      entry.status = terminalStates.has(created.documents[0].state)
        ? created.documents[0].state
        : "polling";
      entry.publicError = created.documents[0].error ?? null;
      entry.submissionReturnedAt = new Date().toISOString();
      await atomicJson(ledgerPath, ledger);
    }
  }

  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    let active = 0;
    for (const entry of ledger.entries) {
      if (terminalStates.has(entry.status)) continue;
      if (!entry.batchId) throw new Error(`Missing batch ID for ${entry.relativePath}`);
      active += 1;
      const batch = await requestJson(`${baseUrl}/api/batches/${entry.batchId}`);
      const document = batch.documents.find((candidate) => candidate.id === entry.documentId);
      assert.ok(document, `document disappeared for ${entry.relativePath}`);
      entry.status = document.state;
      entry.publicError = document.error ?? null;
      entry.lastPolledAt = new Date().toISOString();
      if (terminalStates.has(document.state)) entry.terminalAt = new Date().toISOString();
      await atomicJson(ledgerPath, ledger);
    }
    if (active === 0) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, pollIntervalMs));
  }
  assert.equal(
    ledger.entries.every((entry) => terminalStates.has(entry.status)),
    true,
    "MinerU matrix did not reach terminal state within two hours",
  );

  const s3 = new S3Client({
    endpoint: process.env.MINIO_ENDPOINT,
    region: process.env.MINIO_REGION || "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.MINIO_ACCESS_KEY,
      secretAccessKey: process.env.MINIO_SECRET_KEY,
    },
  });
  for (const entry of ledger.entries) {
    const listed = await requestJson(`${baseUrl}/api/batches/${entry.batchId}/objects`);
    assert.equal(listed.contractVersion, "1.0");
    const classCounts = {};
    for (const object of listed.objects) {
      classCounts[object.assetClass] = (classCounts[object.assetClass] ?? 0) + 1;
      const publicHead = await requestJson(
        `${baseUrl}/api/batches/${entry.batchId}/objects/head?key=${encodeURIComponent(object.key)}`,
      );
      assert.equal(publicHead.object.checksumSha256, object.checksumSha256);
      const s3Head = await s3.send(new HeadObjectCommand({
        Bucket: object.bucket,
        Key: object.key,
      }));
      assert.equal(
        s3Head.Metadata?.checksumsha256 ?? s3Head.Metadata?.sha256,
        object.checksumSha256,
      );
    }
    assert.equal(classCounts.source_original, 1);
    assert.ok(classCounts.mineru_raw_response >= 1);
    if (entry.status === "done") {
      assert.equal(classCounts.mineru_result_zip, 1);
      assert.ok(classCounts.mineru_trusted_result >= 1);
      assert.equal(classCounts.parsed_document_snapshot, 1);
    }
    if (entry.expectsVisualCopy) assert.equal(classCounts.office_visual_copy, 1);
    entry.objectCount = listed.objects.length;
    entry.objectClassCounts = classCounts;
    entry.publicHeadsVerified = listed.objects.length;
    entry.s3HeadsVerified = listed.objects.length;
  }
  s3.destroy();
  await atomicJson(ledgerPath, ledger);

  await stop(app);
  app = spawnApp();
  await waitFor(`${baseUrl}/api/health`, app);
  for (const entry of ledger.entries) {
    const recovered = await requestJson(`${baseUrl}/api/batches/${entry.batchId}`);
    const document = recovered.documents.find((candidate) => candidate.id === entry.documentId);
    assert.equal(document?.state, entry.status);
    entry.applicationRestartRecovered = true;
  }
  await atomicJson(ledgerPath, ledger);

  const evidence = {
    status: ledger.entries.every((entry) => entry.status === "done")
      ? "succeeded"
      : "completed_with_isolated_failures",
    materialCount: facts.length,
    markdownOrTextClaimed: false,
    deferredLargeScannedPdfCount: 3,
    mineruSubmissionCount: ledger.entries.reduce((sum, entry) => sum + entry.submissionCount, 0),
    mineruAutomaticRetryCount: 0,
    applicationRestartRecovered: ledger.entries.every((entry) => entry.applicationRestartRecovered),
    entries: ledger.entries.map((entry) => ({
      relativePath: entry.relativePath,
      fileName: entry.fileName,
      byteLength: entry.byteLength,
      checksumSha256: entry.checksumSha256,
      batchId: entry.batchId,
      documentId: entry.documentId,
      submissionCount: entry.submissionCount,
      terminalState: entry.status,
      publicError: entry.publicError,
      objectCount: entry.objectCount,
      objectClassCounts: entry.objectClassCounts,
      publicHeadsVerified: entry.publicHeadsVerified,
      s3HeadsVerified: entry.s3HeadsVerified,
      applicationRestartRecovered: entry.applicationRestartRecovered,
    })),
  };
  await atomicJson(evidencePath, evidence);
  console.log(JSON.stringify({
    status: evidence.status,
    materialCount: evidence.materialCount,
    mineruSubmissionCount: evidence.mineruSubmissionCount,
    terminalStates: evidence.entries.map((entry) => ({
      fileName: entry.fileName,
      terminalState: entry.terminalState,
    })),
  }));
} finally {
  await stop(app);
}
