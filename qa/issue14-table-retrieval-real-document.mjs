import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";

const root = resolve(".");
const pdfPath = resolve("materials/pdf/产品技术白皮书.pdf");
const snapshotPath = resolve(
  ".workspace/real-mineru-matrix-v1/batches/1da574f1-b67b-4e4c-ac62-ed5464e69016.json",
);
const evidencePath = resolve("output/issue14-table-retrieval/real-document-http.json");
const pdfBytes = await readFile(pdfPath);
const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
const document = snapshot.documents[0];
const tableChunk = document.reviewState.draft.chunks.find((chunk) => chunk.type === "table");
assert.ok(tableChunk?.reviewedModel, "real parsed snapshot must contain a reviewed table");
assert.equal(tableChunk.reviewedModel.columns.length, 11);
assert.equal(tableChunk.reviewedModel.rows.length, 35);

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
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const payload = await response.json();
  assert.ok(response.ok, `HTTP ${response.status}: ${payload.error ?? "request failed"}`);
  return payload;
}

const port = await freePort();
const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(port),
    WORKSPACE_ROOT: resolve(".workspace", `issue14-real-${process.pid}`),
    MINERU_API_TOKEN: "issue14-fake-token",
    EMBEDDING_BASE_URL: "http://127.0.0.1:9/v1",
    EMBEDDING_API_KEY: "issue14-fake-key",
    EMBEDDING_MODEL: "issue14-fake-model",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

const baseUrl = `http://127.0.0.1:${port}`;
try {
  await waitFor(`${baseUrl}/api/health`, child);
  const sourceChunks = document.reviewState.draft.chunks
    .filter((chunk) => chunk.type === "text" && chunk.finalText.trim())
    .slice(0, 2)
    .map((chunk, order) => ({
      sourceChunkId: chunk.id,
      sourceChunkVersion: "real-snapshot-v1",
      order,
      finalText: chunk.finalText,
    }));
  const body = {
    logicalTableId: "whitepaper-product-technology",
    reviewedModel: tableChunk.reviewedModel,
    sourceSegments: tableChunk.sourceSegments,
    sourceChunks,
    finalSummary: "2025 年四大消费电子品类产品技术参数对比表。",
    rawTableHtml: "diagnostic raw html must stay isolated",
    markdown: tableChunk.finalText,
    renderedHtml: "<table>derived-only</table>",
  };
  const created = await requestJson(`${baseUrl}/api/table-retrieval/versions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(created.bundle.vectorReady, true);
  assert.deepEqual(created.bundle.sourceChunkIds, sourceChunks.map((source) => source.sourceChunkId));

  const search = await requestJson(`${baseUrl}/api/table-retrieval/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "3nm 智能手机" }),
  });
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].tableVersionId, created.version.tableVersionId);
  assert.equal("vector" in search.results[0], false);
  assert.equal("embeddingInputText" in search.results[0], false);
  assert.equal(JSON.stringify(search).includes("diagnostic raw html"), false);
  assert.equal("rows" in search.results[0], false);

  const lazy = await requestJson(
    `${baseUrl}/api/table-retrieval/versions/${created.version.tableVersionId}`,
  );
  assert.equal(lazy.rows.length, 35);
  assert.equal(lazy.columns.length, 11);
  assert.equal(JSON.stringify(lazy).includes("diagnostic raw html"), false);
  const confirmed = await requestJson(
    `${baseUrl}/api/table-retrieval/versions/${created.version.tableVersionId}/query-ready`,
    { method: "POST" },
  );
  assert.equal(confirmed.version.queryReady, true);

  const replacement = await requestJson(`${baseUrl}/api/table-retrieval/versions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...body,
      reviewedModel: { ...body.reviewedModel, title: "产品技术参数对比（修订版）" },
      finalSummary: "修订后的 2025 年产品技术参数对比表。",
    }),
  });
  assert.notEqual(replacement.version.tableVersionId, created.version.tableVersionId);
  const current = await requestJson(`${baseUrl}/api/table-retrieval/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "产品参数" }),
  });
  assert.equal(current.results.length, 1);
  assert.equal(current.results[0].tableVersionId, replacement.version.tableVersionId);

  await mkdir(resolve(evidencePath, ".."), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify({
    contractVersion: "issue14-real-document-http-1.0",
    material: "materials/pdf/产品技术白皮书.pdf",
    materialSha256: createHash("sha256").update(pdfBytes).digest("hex"),
    materialBytes: pdfBytes.length,
    parsedTable: { columns: tableChunk.reviewedModel.columns.length, rows: tableChunk.reviewedModel.rows.length },
    initialTableVersionId: created.version.tableVersionId,
    replacementTableVersionId: replacement.version.tableVersionId,
    sourceChunkCount: sourceChunks.length,
    vectorReady: created.bundle.vectorReady,
    queryReady: confirmed.version.queryReady,
    ordinarySearchReturnedCurrentOnly: current.results.length === 1 && current.results[0].tableVersionId === replacement.version.tableVersionId,
    publicResponseOmittedVectorAndRawHtml: true,
  }, null, 2)}\n`, "utf8");
  console.log(`Issue 14 real document HTTP evidence written to ${evidencePath}`);
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => child.once("exit", resolveExit));
  }
}
