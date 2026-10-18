import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
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
      throw new Error(`Child exited with ${child.exitCode}`);
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

const port = await freePort();
const workspaceRoot = resolve(".workspace", `t03-integration-${process.pid}`);
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
      MINERU_API_TOKEN: "fixture-mineru-token",
      EMBEDDING_BASE_URL: "http://127.0.0.1:9/v1",
      EMBEDDING_API_KEY: "fixture-embedding-key",
      EMBEDDING_MODEL: "fixture-embedding-model",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

try {
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(`${baseUrl}/api/health`, app);
  const demoResponse = await fetch(`${baseUrl}/api/demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(demoResponse.status, 200);
  const normal = await demoResponse.json() as {
    id: string;
    documents: Array<{ id: string; diagnostic?: unknown }>;
  };
  assert.equal("diagnostic" in normal.documents[0], false);

  const createResponse = await fetch(
    `${baseUrl}/api/batches/${normal.id}/documents/${normal.documents[0].id}/diagnostic-package`,
    { method: "POST" },
  );
  assert.equal(createResponse.status, 409);
  assert.deepEqual(await createResponse.json(), {
    error: "当前文档没有可用的诊断包",
    code: "DIAGNOSTIC_NOT_AVAILABLE",
  });

  const failedDemoResponse = await fetch(`${baseUrl}/api/demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ diagnosticCategory: "parse_failed" }),
  });
  const failed = await failedDemoResponse.json() as {
    id: string;
    documents: Array<{
      id: string;
      diagnostic?: { categories: string[] };
    }>;
  };
  assert.deepEqual(failed.documents[0].diagnostic?.categories, ["parse_failed"]);
  const failedCreateResponse = await fetch(
    `${baseUrl}/api/batches/${failed.id}/documents/${failed.documents[0].id}/diagnostic-package`,
    { method: "POST" },
  );
  assert.equal(failedCreateResponse.status, 201);
  const created = await failedCreateResponse.json() as {
    packageId: string;
    downloadUrl: string;
    expiresAt: string;
  };
  const downloadResponse = await fetch(`${baseUrl}${created.downloadUrl}`);
  assert.equal(downloadResponse.status, 200);
  const diagnostic = await downloadResponse.json() as {
    batchId: string;
    documentId: string;
    issues: Array<{ category: string }>;
    raw: { contentList?: unknown[] };
  };
  assert.deepEqual(Object.keys(diagnostic).sort(), [
    "batchId",
    "contractVersion",
    "documentId",
    "expiresAt",
    "generatedAt",
    "issues",
    "packageKind",
    "raw",
    "sourceFingerprint",
    "status",
    "versions",
  ]);
  assert.equal(diagnostic.batchId, failed.id);
  assert.equal(diagnostic.documentId, failed.documents[0].id);
  assert.deepEqual(diagnostic.issues.map((issue) => issue.category), [
    "parse_failed",
  ]);
  const serializedDiagnostic = JSON.stringify(diagnostic);
  for (const forbidden of [
    "Authorization",
    "Cookie",
    "headers",
    "api_key",
    "demo-issue-secret",
    "demo-cookie",
    "demo-api-key",
    "signed.demo.invalid",
  ]) assert.equal(serializedDiagnostic.includes(forbidden), false, forbidden);
  assert.match(serializedDiagnostic, /safeParserField/);

  const isolatedResponse = await fetch(
    `${baseUrl}/api/batches/${normal.id}/documents/${normal.documents[0].id}/diagnostic-packages/${created.packageId}`,
  );
  assert.equal(isolatedResponse.status, 404);
  assert.equal(
    ((await isolatedResponse.json()) as { code: string }).code,
    "DIAGNOSTIC_PACKAGE_NOT_FOUND",
  );
  const wrongDocumentResponse = await fetch(
    `${baseUrl}/api/batches/${failed.id}/documents/${normal.documents[0].id}/diagnostic-packages/${created.packageId}`,
  );
  assert.equal(wrongDocumentResponse.status, 404);
  assert.equal(
    ((await wrongDocumentResponse.json()) as { code: string }).code,
    "DIAGNOSTIC_PACKAGE_NOT_FOUND",
  );

  assert.equal(
    Date.parse(created.expiresAt) - Date.now() > 23 * 60 * 60 * 1000,
    true,
    "the public package contract retains diagnostics for 24 hours",
  );

  const anomalyDemoResponse = await fetch(`${baseUrl}/api/demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ diagnosticCategory: "mineru_result_anomaly" }),
  });
  const anomaly = await anomalyDemoResponse.json() as {
    id: string;
    documents: Array<{ id: string; diagnostic?: { categories: string[] } }>;
  };
  assert.deepEqual(anomaly.documents[0].diagnostic?.categories, [
    "mineru_result_anomaly",
  ]);
  const anomalyCreated = await fetch(
    `${baseUrl}/api/batches/${anomaly.id}/documents/${anomaly.documents[0].id}/diagnostic-package`,
    { method: "POST" },
  );
  assert.equal(anomalyCreated.status, 201);

  const bboxDemoResponse = await fetch(`${baseUrl}/api/demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ diagnosticCategory: "bbox_page_anomaly" }),
  });
  const bbox = await bboxDemoResponse.json() as {
    id: string;
    documents: Array<{ id: string; diagnostic?: { categories: string[] } }>;
  };
  assert.deepEqual(bbox.documents[0].diagnostic?.categories, [
    "bbox_page_anomaly",
  ]);
  const bboxCreateResponse = await fetch(
    `${baseUrl}/api/batches/${bbox.id}/documents/${bbox.documents[0].id}/diagnostic-package`,
    { method: "POST" },
  );
  assert.equal(bboxCreateResponse.status, 201);
  const bboxCreated = await bboxCreateResponse.json() as { downloadUrl: string };
  const bboxDiagnostic = await (
    await fetch(`${baseUrl}${bboxCreated.downloadUrl}`)
  ).json() as { issues: Array<{ category: string }> };
  assert.deepEqual(bboxDiagnostic.issues.map((issue) => issue.category), [
    "bbox_page_anomaly",
  ]);

  const visualDemoResponse = await fetch(`${baseUrl}/api/demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ diagnosticCategory: "visual_conversion_failed" }),
  });
  const visual = await visualDemoResponse.json() as {
    id: string;
    documents: Array<{
      id: string;
      state: string;
      diagnostic?: { categories: string[] };
    }>;
  };
  assert.equal(visual.documents[0].state, "done");
  assert.deepEqual(visual.documents[0].diagnostic?.categories, [
    "visual_conversion_failed",
  ]);
  const visualCreateResponse = await fetch(
    `${baseUrl}/api/batches/${visual.id}/documents/${visual.documents[0].id}/diagnostic-package`,
    { method: "POST" },
  );
  assert.equal(visualCreateResponse.status, 201);
} finally {
  await stop(app);
}

console.log("T03 diagnostic integration tests passed");
