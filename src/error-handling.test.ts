import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(new Error("No test port"));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitFor(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Error-handling test server exited with ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
  ]);
}

const batchId = "unexpected-error-batch";
const documentId = "missing-source-document";
const workspaceRoot = resolve(".workspace", `error-handling-${process.pid}`);
await mkdir(resolve(workspaceRoot, "batches"), { recursive: true });
await writeFile(resolve(workspaceRoot, "batches", `${batchId}.json`), JSON.stringify({
  id: batchId,
  documents: [{
    id: documentId,
    name: "missing.pdf",
    state: "done",
    reviewState: { preview: null, draft: null, undoStack: [], redoStack: [] },
    sourceAsset: {
      path: "D:\\private\\customer-secrets\\missing-source.pdf",
      mimeType: "application/pdf",
    },
  }],
}), "utf8");

const port = await freePort();
let serverLog = "";
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
      MINERU_API_TOKEN: "test-token-must-not-be-logged",
      EMBEDDING_BASE_URL: "http://127.0.0.1:1",
      EMBEDDING_API_KEY: "test-key-must-not-be-logged",
      EMBEDDING_MODEL: "test-model",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
for (const stream of [app.stdout, app.stderr])
  stream?.on("data", (chunk) => {
    serverLog += chunk.toString();
  });

try {
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(`${baseUrl}/api/health`, app);
  const response = await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}/source`,
  );
  assert.equal(response.status, 502);
  const payload = await response.json() as Record<string, unknown>;
  assert.deepEqual(payload, {
    error: "服务器处理请求时发生意外错误，当前操作未完成。",
    code: "INTERNAL_SERVER_ERROR",
    recovery: "请稍后重试；若问题持续，请联系维护人员并提供发生时间。",
  });
  const publicResponse = JSON.stringify(payload);
  assert.doesNotMatch(publicResponse, /ENOENT|D:\\|customer-secrets|node:internal|at\s+/i);
  assert.match(serverLog, /ENOENT/);
  assert.doesNotMatch(
    serverLog,
    /D:\\|customer-secrets|test-token-must-not-be-logged|test-key-must-not-be-logged/i,
  );

  const demoResponse = await fetch(`${baseUrl}/api/demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const demo = await demoResponse.json() as {
    id: string;
    documents: Array<{ id: string }>;
  };
  const reviewResponse = await fetch(
    `${baseUrl}/api/batches/${demo.id}/documents/${demo.documents[0].id}/review`,
  );
  const review = await reviewResponse.json() as {
    parsedDocument: { sourceDocumentVersion: string; parsedDocumentVersion: string };
    sourceBlocks: Array<{ contentBlockId: string }>;
  };
  const manualResponse = await fetch(
    `${baseUrl}/api/batches/${demo.id}/documents/${demo.documents[0].id}/manual-chunks`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "document",
        effectiveAnnotations: [{
          id: "problem-box",
          sourceBlockIds: [review.sourceBlocks[0].contentBlockId],
          page: 1,
          bbox: [0.01, 0.95, 0.02, 0.96],
          type: "table",
          readingOrder: 0,
          layer: "manual",
        }],
        suppressedSourceBlockIds: [],
        imagePolicy: "reference",
        sourceDocumentVersion: review.parsedDocument.sourceDocumentVersion,
        parsedDocumentVersion: review.parsedDocument.parsedDocumentVersion,
      }),
    },
  );
  assert.equal(manualResponse.status, 422);
  assert.deepEqual(await manualResponse.json(), {
    error: "人工框未命中可信 Source Block",
    code: "EMPTY_BBOX_INTERSECTION",
    details: {
      problemAnnotations: [{
        id: "problem-box",
        page: 1,
        type: "table",
        bbox: [0.01, 0.95, 0.02, 0.96],
      }],
    },
  });
} finally {
  await stop(app);
}

console.log("Safe server error response tests passed");
