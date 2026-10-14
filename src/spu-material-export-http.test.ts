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
      if (!address || typeof address === "string") return reject(new Error("No test port"));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitFor(url: string, child: ChildProcess): Promise<void> {
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`server did not become ready${stderr ? `: ${stderr.slice(-2000)}` : ""}`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise<void>((resolveStop) => child.once("exit", () => resolveStop()));
}

const port = await freePort();
const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
  cwd: resolve("."),
  env: {
    ...process.env,
    NODE_ENV: "test",
    REDIS_DISABLED: "1",
    PORT: String(port),
    WORKSPACE_ROOT: resolve(".workspace", `spu-material-http-${process.pid}`),
    MINERU_API_TOKEN: "spu-material-fixture-token",
    EMBEDDING_BASE_URL: "http://127.0.0.1:9/v1",
    EMBEDDING_API_KEY: "spu-material-fixture-key",
    EMBEDDING_MODEL: "fixture-model",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/health`, child);
  const demo = await (await fetch(`${base}/api/demo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })).json() as { id: string; documents: Array<{ id: string }> };
  const documentId = demo.documents[0]!.id;
  const prefix = `${base}/api/batches/${demo.id}/documents/${documentId}`;
  const blocked = await fetch(`${prefix}/spu-material-export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spuId: "SPU-10001", documentType: "manual" }),
  });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json() as { code: string }).code, "LEGACY_WORKSPACE_READ_ONLY");

  const confirmed = await fetch(`${prefix}/review/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(confirmed.status, 200);
  const review = await (await fetch(`${prefix}/review`)).json() as {
    reviewRevision: number;
    reviewState: { draft: { chunks: Array<{ id: string; finalText: string }> } };
  };
  const chunks = review.reviewState.draft.chunks;
  assert.ok(chunks.length > 0);
  const progress = await fetch(`${prefix}/review/progress`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "mark-to-here",
      cursorChunkId: chunks.at(-1)!.id,
      expectedRevision: review.reviewRevision,
    }),
  });
  assert.equal(progress.status, 200);

  const pendingSelection = await fetch(`${prefix}/spu-material-selection`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetSpuIds: ["SPU-10001", "SPU-10002"] }),
  });
  assert.equal(pendingSelection.status, 200);
  const pendingBatch = await (await fetch(`${base}/api/batches/${demo.id}`)).json() as {
    documents: Array<{ id: string; pendingSpuIds?: string[] }>;
  };
  assert.deepEqual(pendingBatch.documents.find((document) => document.id === documentId)?.pendingSpuIds, ["SPU-10001", "SPU-10002"]);

  const scope = await fetch(`${prefix}/spu-material-scope`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetSpuIds: ["SPU-10001", "SPU-10002"], spuId: "SPU-10001", documentType: "manual" }),
  });
  assert.equal(scope.status, 200);
  const confirmedBatch = await (await fetch(`${base}/api/batches/${demo.id}`)).json() as {
    documents: Array<{ id: string; targetSpuIds?: string[]; spuDocumentType?: string }>;
  };
  const confirmedDocument = confirmedBatch.documents.find((document) => document.id === documentId)!;
  assert.deepEqual(confirmedDocument.targetSpuIds, ["SPU-10001", "SPU-10002"]);
  assert.equal(confirmedDocument.spuDocumentType, "manual");

  const inheritedCandidate = chunks[0]!;
  const singleScopeAgain = await fetch(`${prefix}/spu-material-scope`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetSpuIds: ["SPU-10001"], spuId: "SPU-10001", documentType: "manual" }),
  });
  assert.equal(singleScopeAgain.status, 200);
  const inheritedReview = await (await fetch(`${prefix}/review`)).json() as {
    reviewState: { draft: { chunks: Array<{ id: string; scope?: string; targetSpuIds?: string[] }> } };
  };
  const inheritedChunk = inheritedReview.reviewState.draft.chunks.find((chunk) => chunk.id === inheritedCandidate.id)!;
  assert.equal(inheritedChunk.scope, "assigned");
  assert.deepEqual(inheritedChunk.targetSpuIds, ["SPU-10001"]);

  const forged = await fetch(`${prefix}/spu-material-export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spuId: "SPU-10001", documentType: "manual", selectedChunkIds: [chunks[0]!.id] }),
  });
  assert.equal(forged.status, 400);
  assert.equal((await forged.json() as { code: string }).code, "SELECTED_CHUNKS_NOT_SUPPORTED");

  const exported = await fetch(`${prefix}/spu-material-export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spuId: "SPU-10001", documentType: "manual" }),
  });
  if (exported.status !== 200) throw new Error(`export failed ${exported.status}: ${await exported.text()}`);
  const payload = await exported.json() as {
    reused: boolean;
    status: string;
    exportVersion: string;
    markdownKey: string;
    manifestKey: string;
    currentKey: string;
  };
  assert.equal(payload.reused, false);
  assert.ok(["complete", "complete_with_exclusions"].includes(payload.status));
  assert.equal(payload.exportVersion, "v1");
  assert.match(payload.markdownKey, new RegExp(`^spu/SPU-10001/documents/${documentId}/`));
  assert.match(payload.markdownKey, /\/SPU-10001_manual_[A-Za-z0-9._-]+_v1\.md$/);
  assert.match(payload.manifestKey, new RegExp(`^spu/SPU-10001/documents/${documentId}/`));
  assert.match(payload.currentKey, new RegExp(`^spu/SPU-10001/documents/${documentId}/`));

  const repeated = await fetch(`${prefix}/spu-material-export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spuId: "SPU-10001", documentType: "manual" }),
  });
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json() as { reused: boolean }).reused, true);

  const markdown = await fetch(`${prefix}/spu-material-export/markdown`);
  assert.equal(markdown.status, 200);
  assert.match(markdown.headers.get("content-disposition") ?? "", /filename="SPU-10001_manual_[A-Za-z0-9._-]+_v1\.md"/);
  assert.match(await markdown.text(), /SPU: SPU-10001/);
  const manifest = await fetch(`${prefix}/spu-material-export/manifest`);
  assert.equal(manifest.status, 200);
  assert.equal((await manifest.json() as { targetSpuId: string }).targetSpuId, "SPU-10001");

  const state = await (await fetch(`${prefix}/spu-material-export`)).json() as {
    status: string;
    current: { exportVersion: string } | null;
  };
  assert.equal(state.status, payload.status);
  assert.equal(state.current?.exportVersion, "v1");

  const regenerated = await fetch(`${prefix}/spu-material-export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spuId: "SPU-10001", documentType: "manual", regenerate: true }),
  });
  assert.equal(regenerated.status, 200);
  const regeneratedPayload = await regenerated.json() as {
    reused: boolean;
    exportVersion: string;
    markdownKey: string;
    manifestKey: string;
    currentKey: string;
  };
  assert.equal(regeneratedPayload.reused, false);
  assert.equal(regeneratedPayload.exportVersion, "v2");
  assert.notEqual(regeneratedPayload.markdownKey, payload.markdownKey);
  assert.notEqual(regeneratedPayload.manifestKey, payload.manifestKey);
  assert.equal(regeneratedPayload.currentKey, payload.currentKey);

  const historicalMarkdown = await fetch(`${prefix}/spu-material-export/markdown?spuId=SPU-10001&exportVersion=v1`);
  assert.equal(historicalMarkdown.status, 200);
  assert.match(await historicalMarkdown.text(), /导出版本: v1/);
  const historicalManifest = await fetch(`${prefix}/spu-material-export/manifest?spuId=SPU-10001&exportVersion=v1`);
  assert.equal(historicalManifest.status, 200);
  assert.equal((await historicalManifest.json() as { exportVersion: string }).exportVersion, "v1");
  const currentMarkdown = await fetch(`${prefix}/spu-material-export/markdown?spuId=SPU-10001`);
  assert.equal(currentMarkdown.status, 200);
  assert.match(await currentMarkdown.text(), /导出版本: v2/);
  const regeneratedState = await (await fetch(`${prefix}/spu-material-export?spuId=SPU-10001`)).json() as {
    current: { exportVersion: string; currentKey: string } | null;
  };
  assert.equal(regeneratedState.current?.exportVersion, "v2");
  assert.equal(regeneratedState.current?.currentKey, payload.currentKey);
  const repeatedAfterRegenerate = await fetch(`${prefix}/spu-material-export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spuId: "SPU-10001", documentType: "manual" }),
  });
  assert.equal(repeatedAfterRegenerate.status, 200);
  const repeatedAfterRegeneratePayload = await repeatedAfterRegenerate.json() as { reused: boolean; exportVersion: string };
  assert.equal(repeatedAfterRegeneratePayload.reused, true);
  assert.equal(repeatedAfterRegeneratePayload.exportVersion, "v2");

  const confirmedScope = await fetch(`${prefix}/spu-material-scope`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spuId: "SPU-10001", targetSpuIds: ["SPU-10001", "SPU-10002"], documentType: "manual" }),
  });
  assert.equal(confirmedScope.status, 200);
  const routedChunks = chunks.filter((chunk) => chunk.finalText.trim());
  const firstChunk = routedChunks[0]!;
  const secondChunk = routedChunks[1]!;
  assert.ok(firstChunk && secondChunk);
  const firstScope = await fetch(`${prefix}/chunks/${firstChunk.id}/spu-scope`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "assigned", targetSpuIds: ["SPU-10001"] }),
  });
  assert.equal(firstScope.status, 200);
  const secondScope = await fetch(`${prefix}/chunks/${secondChunk.id}/spu-scope`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "conflicted", targetSpuIds: ["SPU-10002"] }),
  });
  assert.equal(secondScope.status, 200);
  const fanout = await fetch(`${prefix}/spu-material-export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spuId: "SPU-10001", targetSpuIds: ["SPU-10001", "SPU-10002", "SPU-10003"], documentType: "manual" }),
  });
  assert.equal(fanout.status, 409);
  assert.equal((await fanout.json() as { code: string }).code, "SPU_SCOPE_FORGED");

  const partialFanout = await fetch(`${prefix}/spu-material-export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spuId: "SPU-10001", targetSpuIds: ["SPU-10001", "SPU-10002"], documentType: "manual" }),
  });
  assert.equal(partialFanout.status, 200);
  const partialPayload = await partialFanout.json() as { status: string; children: Array<{ spuId: string; status: string; markdownKey?: string; manifestKey?: string; currentKey?: string; reason?: string }> };
  assert.equal(partialPayload.status, "blocked");
  assert.deepEqual(partialPayload.children.map((child) => child.spuId), ["SPU-10001", "SPU-10002"]);
  const partialSpu1 = partialPayload.children.find((child) => child.spuId === "SPU-10001")!;
  const partialSpu2 = partialPayload.children.find((child) => child.spuId === "SPU-10002")!;
  assert.ok(["complete", "complete_with_exclusions"].includes(partialSpu1.status));
  assert.ok(typeof partialSpu1.markdownKey === "string" && typeof partialSpu1.manifestKey === "string" && typeof partialSpu1.currentKey === "string");
  assert.equal(partialSpu2.status, "blocked");
  assert.match(partialSpu2.reason ?? "", /conflicted_chunk_scope/);

  const recoveredScope = await fetch(`${prefix}/chunks/${secondChunk.id}/spu-scope`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "assigned", targetSpuIds: ["SPU-10002"] }),
  });
  assert.equal(recoveredScope.status, 200);
  const fanoutExport = await fetch(`${prefix}/spu-material-export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spuId: "SPU-10001", targetSpuIds: ["SPU-10001", "SPU-10002"], documentType: "manual" }),
  });
  assert.equal(fanoutExport.status, 200);
  const fanoutPayload = await fanoutExport.json() as { status: string; children: Array<{ spuId: string; status: string; exportVersion: string; markdownKey?: string; manifestKey?: string; currentKey?: string }> };
  assert.equal(fanoutPayload.children.length, 2);
  assert.deepEqual(fanoutPayload.children.map((child) => child.spuId), ["SPU-10001", "SPU-10002"]);
  assert.equal(fanoutPayload.children.every((child) => child.status === "complete" || child.status === "complete_with_exclusions"), true);
  assert.ok(fanoutPayload.children.every((child) => typeof child.markdownKey === "string" && typeof child.manifestKey === "string" && typeof child.currentKey === "string"));
  const changedScope = await fetch(`${prefix}/chunks/${firstChunk.id}/spu-scope`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "common", targetSpuIds: [] }),
  });
  assert.equal(changedScope.status, 200);
  const changedFanout = await fetch(`${prefix}/spu-material-export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spuId: "SPU-10001", targetSpuIds: ["SPU-10001", "SPU-10002"], documentType: "manual" }),
  });
  assert.equal(changedFanout.status, 200);
  const changedFanoutPayload = await changedFanout.json() as { reused: boolean; children: Array<{ exportVersion: string }> };
  assert.equal(changedFanoutPayload.reused, false);
  assert.ok(changedFanoutPayload.children.every((child) => child.exportVersion !== fanoutPayload.children[0]!.exportVersion));
  const fanoutRegenerated = await fetch(`${prefix}/spu-material-export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spuId: "SPU-10001", targetSpuIds: ["SPU-10001", "SPU-10002"], documentType: "manual", regenerate: true }),
  });
  assert.equal(fanoutRegenerated.status, 200);
  const fanoutRegeneratedPayload = await fanoutRegenerated.json() as { children: Array<{ spuId: string; exportVersion: string }> };
  assert.equal(fanoutRegeneratedPayload.children.length, 2);
  assert.ok(fanoutRegeneratedPayload.children.every((child) => child.exportVersion !== fanoutPayload.children[0]!.exportVersion));
  const fanoutHistory = await fetch(`${prefix}/spu-material-export/markdown?spuId=SPU-10001&exportVersion=${fanoutPayload.children[0]!.exportVersion}`);
  assert.equal(fanoutHistory.status, 200);
  assert.match(await fanoutHistory.text(), new RegExp(`导出版本: ${fanoutPayload.children[0]!.exportVersion}`));
  const spu1Markdown = await fetch(`${prefix}/spu-material-export/markdown?spuId=SPU-10001`);
  assert.equal(spu1Markdown.status, 200);
  const spu1Text = await spu1Markdown.text();
  const firstMarker = firstChunk.finalText.trim().slice(0, 8);
  const secondMarker = secondChunk.finalText.trim().slice(0, 8);
  assert.ok(firstMarker && secondMarker && firstMarker !== secondMarker);
  assert.match(spu1Text, new RegExp(firstMarker));
  assert.doesNotMatch(spu1Text, new RegExp(secondMarker));
  const spu2Manifest = await fetch(`${prefix}/spu-material-export/manifest?spuId=SPU-10002`);
  assert.equal(spu2Manifest.status, 200);
  const spu2ManifestPayload = await spu2Manifest.json() as { targetSpuId: string; chunks: Array<{ scope?: string; targetSpuIds?: string[] }> };
  assert.equal(spu2ManifestPayload.targetSpuId, "SPU-10002");
  assert.ok(spu2ManifestPayload.chunks.every((entry) => entry.scope !== "assigned" || entry.targetSpuIds?.includes("SPU-10002")));

  const staleRevision = await fetch(`${prefix}/spu-material-export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spuId: "SPU-10001", documentType: "manual", expectedRevision: -1 }),
  });
  assert.equal(staleRevision.status, 409);
  assert.equal((await staleRevision.json() as { code: string }).code, "REVIEW_REVISION_CONFLICT");
} finally {
  await stop(child);
}

console.log("SPU material export HTTP tests passed");
