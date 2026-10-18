import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";

const root = resolve(".");

async function freePort(): Promise<number> {
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

async function waitFor(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Child exited with ${child.exitCode}`);
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

const fakePort = await freePort();
const appPort = await freePort();
const workspaceRoot = resolve(".workspace", `t02-mapping-integration-${process.pid}`);
const fake = spawn(process.execPath, ["qa/fake-mineru-server.mjs"], {
  cwd: root,
  env: {
    ...process.env,
    FAKE_MINERU_PORT: String(fakePort),
    FAKE_MINERU_LOG: `output/t02-source-view/fake-calls-mapping-test-${process.pid}.jsonl`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let appLog = "";
function spawnApp(): ChildProcess {
  const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(appPort),
      WORKSPACE_ROOT: workspaceRoot,
      MINERU_API_TOKEN: "fake-token-not-a-secret",
      MINERU_BASE_URL: `http://127.0.0.1:${fakePort}/api/v4`,
      EMBEDDING_BASE_URL: "http://127.0.0.1:9/v1",
      EMBEDDING_API_KEY: "fake-embedding-key",
      EMBEDDING_MODEL: "fake-embedding-model",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8").on("data", (chunk) => { appLog += chunk; });
  child.stderr?.setEncoding("utf8").on("data", (chunk) => { appLog += chunk; });
  return child;
}
let app = spawnApp();

try {
  await Promise.all([
    waitFor(`http://127.0.0.1:${fakePort}/health`, fake),
    waitFor(`http://127.0.0.1:${appPort}/api/health`, app),
  ]);
  const bytes = new Uint8Array(await readFile(resolve("qa/fixtures/t02-source.pdf")));
  const form = new FormData();
  form.append("config", "{}");
  form.append("files", new Blob([bytes], { type: "application/pdf" }), "多图片PDF.pdf");
  const createdResponse = await fetch(`http://127.0.0.1:${appPort}/api/batches`, {
    method: "POST",
    body: form,
  });
  assert.equal(createdResponse.status, 202);
  const batch = await createdResponse.json() as {
    id: string;
    documents: Array<{ id: string; name: string }>;
  };
  const document = batch.documents.find((candidate) => candidate.name === "多图片PDF.pdf");
  assert.ok(document);
  const reviewResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/batches/${batch.id}/documents/${document.id}/review`,
  );
  assert.equal(reviewResponse.status, 200);
  const review = await reviewResponse.json() as {
    sourceMapping: { pages: Array<{ page: number; pageWidth: number; pageHeight: number }> } | null;
  };
  assert.equal(review.sourceMapping?.pages.length, 23);
  assert.deepEqual(review.sourceMapping?.pages[0], {
    page: 1,
    pageWidth: 612,
    pageHeight: 792,
    bboxPageWidth: 1000,
    bboxPageHeight: 1000,
    coordinateUnit: "mineru_normalized_1000",
    coordinateOrigin: "top-left",
    orientation: 0,
    transform: [0.612, 0, 0, 0.792, 0, 0],
    mediaBox: [0, 0, 612, 792],
    cropBox: [0, 0, 612, 792],
  });
  for (let index = 0; index < 3; index += 1) {
    const pollResponse = await fetch(`http://127.0.0.1:${appPort}/api/batches/${batch.id}`);
    assert.equal(pollResponse.status, 200);
  }
  const parsedReview = await (
    await fetch(
      `http://127.0.0.1:${appPort}/api/batches/${batch.id}/documents/${document.id}/review`,
    )
  ).json() as {
    sourceBlocks: Array<{ sourceLocation: { bbox: number[] | null; locationQuality: string } }>;
  };
  assert.equal(parsedReview.sourceBlocks.length, 257);
  assert.equal(
    parsedReview.sourceBlocks.filter(
      (block) => block.sourceLocation.locationQuality === "exact" && block.sourceLocation.bbox,
    ).length,
    257,
    "trusted MinerU bbox values survive normalization",
  );

  const invalidForm = new FormData();
  invalidForm.append("config", "{}");
  invalidForm.append(
    "files",
    new Blob(["%PDF deterministic invalid mapping fixture"], { type: "application/pdf" }),
    "invalid-mapping.pdf",
  );
  const invalidResponse = await fetch(`http://127.0.0.1:${appPort}/api/batches`, {
    method: "POST",
    body: invalidForm,
  });
  assert.equal(invalidResponse.status, 202, "mapping failure does not block parsing");
  const invalidBatch = await invalidResponse.json() as typeof batch;
  const invalidDocument = invalidBatch.documents[0];
  const invalidReview = await (
    await fetch(
      `http://127.0.0.1:${appPort}/api/batches/${invalidBatch.id}/documents/${invalidDocument.id}/review`,
    )
  ).json() as { sourceMapping: unknown };
  assert.equal(invalidReview.sourceMapping, null, "untrusted PDF geometry stays unavailable");
  assert.match(appLog, /"documentName":"invalid-mapping\.pdf"/);
  assert.match(appLog, /"error":"Invalid PDF structure\."/);
  assert.match(appLog, /"msg":"PDF source mapping failed"/);

  await stop(app);
  const batchPath = resolve(workspaceRoot, "batches", `${batch.id}.json`);
  const persisted = JSON.parse(await readFile(batchPath, "utf8")) as {
    documents: Array<{
      sourceMapping?: unknown;
      parsedDocumentV21: { blocks: Array<{ sourceLocation: { bbox: unknown; locationQuality: string; bboxEvidence?: unknown } }> };
    }>;
  };
  delete persisted.documents[0].sourceMapping;
  for (const block of persisted.documents[0].parsedDocumentV21.blocks) {
    block.sourceLocation.bbox = null;
    block.sourceLocation.locationQuality = "page_only";
    delete block.sourceLocation.bboxEvidence;
  }
  await writeFile(batchPath, JSON.stringify(persisted), "utf8");
  app = spawnApp();
  await waitFor(`http://127.0.0.1:${appPort}/api/health`, app);
  const recoveredReview = await (
    await fetch(
      `http://127.0.0.1:${appPort}/api/batches/${batch.id}/documents/${document.id}/review`,
    )
  ).json() as typeof parsedReview & { sourceMapping: { pages: unknown[] } | null };
  assert.equal(recoveredReview.sourceMapping?.pages.length, 23);
  assert.equal(
    recoveredReview.sourceBlocks.filter((block) => block.sourceLocation.locationQuality === "exact").length,
    257,
    "an unreviewed persisted batch recovers trusted bbox without another MinerU call",
  );
} finally {
  await Promise.all([stop(app), stop(fake)]);
}

console.log("T02 PDF mapping integration tests passed");
