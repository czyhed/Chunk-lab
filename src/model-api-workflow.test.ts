import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
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
      throw new Error(`Model workflow server exited with ${child.exitCode}`);
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
const fakeRequests: Array<{ authorization?: string; body: Record<string, unknown> }> = [];
const fake = createHttpServer((request, response) => {
  let raw = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { raw += chunk; });
  request.on("end", () => {
    const body = JSON.parse(raw) as Record<string, unknown>;
    fakeRequests.push({
      authorization: request.headers.authorization,
      body,
    });
    const model = body.model;
    response.setHeader("Content-Type", "application/json");
    if (model === "empty-mm") return response.end(JSON.stringify({
      choices: [{ message: { content: "" } }],
    }));
    if (model === "failed-mm") {
      response.statusCode = 500;
      return response.end(JSON.stringify({
        error: { message: "private fake upstream failure" },
      }));
    }
    const isContext = JSON.stringify(body.messages).includes("Chunk 补充检索背景");
    const send = () => response.end(JSON.stringify({
      choices: [{ message: { content: isContext
        ? "该图片说明星澜 A1 智能料理机的杯体安装步骤。检索时应结合锁定方向和通电前检查理解。"
        : "杯体应沿箭头方向旋转并锁定到主机。" } }],
    }));
    if (model === "slow-mm") return setTimeout(send, 200);
    send();
  });
});
await new Promise<void>((resolveListen) => fake.listen(fakePort, "127.0.0.1", resolveListen));

const profiles = [
  { id: "success", name: "本地成功模型", capabilities: ["vlm", "context"], model: "success-mm", timeoutMs: 500 },
  { id: "empty", name: "本地空响应", capabilities: ["vlm"], model: "empty-mm", timeoutMs: 500 },
  { id: "slow", name: "本地超时模型", capabilities: ["vlm"], model: "slow-mm", timeoutMs: 50 },
  { id: "failed", name: "本地失败模型", capabilities: ["vlm"], model: "failed-mm", timeoutMs: 500 },
].map((profile) => ({
  ...profile,
  baseUrl: `http://127.0.0.1:${fakePort}/v1`,
  apiKey: `secret-${profile.id}`,
}));
const port = await freePort();
const workspaceRoot = resolve(".workspace", `model-api-${process.pid}`);
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
      MINERU_API_TOKEN: "model-api-test-token",
      EMBEDDING_BASE_URL: "http://127.0.0.1:1",
      EMBEDDING_API_KEY: "model-api-embedding-key",
      EMBEDDING_MODEL: "test-embedding",
      MODEL_PROFILES_JSON: JSON.stringify(profiles),
      CONTEXT_BASE_URL: "",
      CONTEXT_API_KEY: "",
      CONTEXT_MODEL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
app.stdout?.resume();
app.stderr?.resume();

try {
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(`${baseUrl}/api/health`, app);
  const publicProfiles = await (await fetch(`${baseUrl}/api/model-profiles`)).json();
  assert.deepEqual(publicProfiles, {
    profiles: profiles.map(({ id, name, capabilities }) => ({ id, name, capabilities })),
  });
  assert.doesNotMatch(
    JSON.stringify(publicProfiles),
    /baseUrl|apiKey|secret-|success-mm|127\.0\.0\.1/,
  );

  const demo = await (await fetch(`${baseUrl}/api/demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageScenario: "three" }),
  })).json() as { id: string; documents: Array<{ id: string }> };
  const batchId = demo.id;
  const documentId = demo.documents[0].id;
  const confirmed = await (await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}/review/confirm`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  )).json() as {
    reviewState: { draft: { chunks: Array<Record<string, unknown>> } };
  };
  const images = confirmed.reviewState.draft.chunks.filter(
    (candidate) => candidate.type === "image",
  );
  const relatedTextIds = confirmed.reviewState.draft.chunks
    .filter((candidate) => candidate.type === "text" && candidate.embeddingEligible === true)
    .slice(0, 2)
    .map((candidate) => String(candidate.id));
  assert.equal(relatedTextIds.length, 2);
  assert.equal(images.length, 3);
  const image = images[0]!;
  const imageId = String(image.id);
  const vlmUrl = `${baseUrl}/api/batches/${batchId}/documents/${documentId}/chunks/${encodeURIComponent(imageId)}/vlm-summary`;
  const saveUrl = `${baseUrl}/api/batches/${batchId}/documents/${documentId}/chunks/${encodeURIComponent(imageId)}/image-summary`;

  const successResponse = await fetch(vlmUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId: "success" }),
  });
  assert.equal(successResponse.status, 200);
  const generated = await successResponse.json() as {
    reviewState: { draft: { chunks: Array<Record<string, unknown>> } };
  };
  const generatedImage = generated.reviewState.draft.chunks.find(
    (candidate) => candidate.id === imageId,
  )!;
  assert.equal(generatedImage.vlmStatus, "awaiting_review");
  assert.equal(generatedImage.vlmProfileId, "success");
  assert.equal(generatedImage.vlmProfileName, "本地成功模型");
  assert.equal(generatedImage.vlmModel, "success-mm");
  assert.equal(generatedImage.vlmPromptVersion, "image-summary-v1");
  assert.equal(generatedImage.vlmSummaryGenerated, "杯体应沿箭头方向旋转并锁定到主机。");
  assert.equal(generatedImage.finalText, "", "VLM generation does not bypass human save");
  const imageObjects = await (await fetch(
    `${baseUrl}/api/batches/${batchId}/objects?documentId=${documentId}`,
  )).json() as { objects: Array<{ assetClass: string; checksumSha256: string }> };
  assert.equal(
    imageObjects.objects.some((object) => object.assetClass === "pdf_page_render"),
    true,
    "trusted PDF image input persists its controlled page render",
  );
  assert.equal(
    imageObjects.objects.some((object) => object.assetClass === "pdf_image_crop"),
    true,
    "trusted PDF image input persists its crop",
  );
  assert.equal(fakeRequests.length, 1);
  assert.equal(fakeRequests[0].authorization, "Bearer secret-success");
  const multimodal = JSON.stringify(fakeRequests[0].body);
  assert.match(multimodal, /data:image\/png;base64,/);
  assert.match(multimodal, /星澜 A1|杯体|锁定/);

  const cachedResponse = await fetch(vlmUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId: "success" }),
  });
  assert.equal(cachedResponse.status, 200);
  const cachedPayload = await cachedResponse.json() as { cacheHit?: boolean };
  assert.equal(cachedPayload.cacheHit, true);
  assert.equal(fakeRequests.length, 1, "identical VLM inputs reuse the cached result");

  const savedResponse = await fetch(saveUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      imagePolicy: "summary",
      humanSummary: "",
      humanSupplement: "人工确认适用于 A1 型号",
    }),
  });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json() as {
    reviewState: { draft: { chunks: Array<Record<string, unknown>> } };
  };
  const savedImage = saved.reviewState.draft.chunks.find(
    (candidate) => candidate.id === imageId,
  )!;
  assert.equal(savedImage.embeddingEligible, true);
  assert.deepEqual(savedImage.embeddingExclusionReasons, []);
  assert.equal(savedImage.contextReviewState, "not_generated");
  assert.equal(
    savedImage.finalText,
    "杯体应沿箭头方向旋转并锁定到主机。\n人工确认适用于 A1 型号",
  );
  assert.equal(fakeRequests.length, 1, "saving an image summary never calls Context or VLM again");

  for (const [candidate, imagePolicy] of [
    [images[1], "reference"],
    [images[2], "exclude"],
  ] as const) {
    const response = await fetch(
      `${baseUrl}/api/batches/${batchId}/documents/${documentId}/chunks/${encodeURIComponent(String(candidate.id))}/image-summary`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imagePolicy,
          humanSummary: "",
          humanSupplement: "",
          relatedChunkIds: imagePolicy === "reference" ? relatedTextIds : [],
        }),
      },
    );
    assert.equal(response.status, 200);
  }
  const threePolicyReview = await (await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}/review`,
  )).json() as { reviewState: { draft: { chunks: Array<Record<string, unknown>> } } };
  const reviewedImages = threePolicyReview.reviewState.draft.chunks.filter(
    (candidate) => candidate.type === "image",
  );
  assert.deepEqual(reviewedImages.map((candidate) => candidate.imagePolicy), [
    "summary",
    "reference",
    "exclude",
  ]);
  assert.deepEqual(reviewedImages.map((candidate) => candidate.embeddingEligible), [
    true,
    false,
    false,
  ]);
  assert.equal(reviewedImages[1].finalText, "");
  assert.deepEqual(reviewedImages[1].relatedChunkIds, relatedTextIds);
  assert.equal(reviewedImages.every((candidate) =>
    String((candidate.imageObjectReference as Record<string, unknown>).uri).startsWith("s3://")
  ), true);

  const beforeBlockedVlmRequests = fakeRequests.length;
  const blockedReferenceVlm = await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}/chunks/${encodeURIComponent(String(images[1].id))}/vlm-summary`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "failed" }),
    },
  );
  assert.equal(blockedReferenceVlm.status, 409);
  assert.equal(fakeRequests.length, beforeBlockedVlmRequests, "reference-only images never call VLM");

  const isolatedFailure = await fetch(vlmUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId: "failed" }),
  });
  assert.equal(isolatedFailure.status, 502);
  const afterIsolatedFailure = await (await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}/review`,
  )).json() as { reviewState: { draft: { chunks: Array<Record<string, unknown>> } } };
  const afterFailureImages = afterIsolatedFailure.reviewState.draft.chunks.filter(
    (candidate) => candidate.type === "image",
  );
  assert.equal(afterFailureImages[0].vlmSummaryGenerated, savedImage.vlmSummaryGenerated);
  assert.equal(afterFailureImages[0].vlmStatus, "failed");
  assert.equal(afterFailureImages[1].imagePolicy, "reference");
  assert.equal(afterFailureImages[2].imagePolicy, "exclude");

  const threePolicyExport = await (await fetch(
    `${baseUrl}/api/batches/${batchId}/export?contractVersion=2.1`,
  )).json() as { documents: Array<{ chunks: Array<Record<string, unknown>> }> };
  const exportedImages = threePolicyExport.documents[0].chunks.filter(
    (candidate) => candidate.contentType === "image",
  );
  assert.deepEqual(exportedImages.map((candidate) => candidate.imagePolicy), [
    "summary",
    "reference",
    "exclude",
  ]);
  assert.doesNotMatch(JSON.stringify(exportedImages), /data:image|base64,/);

  const recovered = await (await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}/review`,
  )).json() as { reviewState: { draft: { chunks: Array<Record<string, unknown>> } } };
  assert.equal(
    recovered.reviewState.draft.chunks.find((candidate) => candidate.id === imageId)?.finalText,
    savedImage.finalText,
  );

  for (const [profileId, status, code] of [
    ["empty", 502, "VLM_GENERATION_FAILED"],
    ["slow", 504, "VLM_TIMEOUT"],
    ["failed", 502, "VLM_GENERATION_FAILED"],
    ["missing", 503, "VLM_SERVICE_UNAVAILABLE"],
  ] as const) {
    const response = await fetch(vlmUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId }),
    });
    assert.equal(response.status, status, profileId);
    const payload = await response.json() as Record<string, unknown>;
    assert.equal(payload.code, code);
    assert.doesNotMatch(
      JSON.stringify(payload),
      /private fake|secret-|apiKey|baseUrl|127\.0\.0\.1/,
    );
  }

  const beforeContextRequests = fakeRequests.length;
  const beforeContextReview = await (await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}/review`,
  )).json() as { reviewState: { draft: { chunks: Array<Record<string, unknown>> } } };
  const vlmProfileBeforeContext = beforeContextReview.reviewState.draft.chunks.find(
    (candidate) => candidate.id === imageId,
  )?.vlmProfileId;
  const contextResponse = await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}/context/generate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chunkIds: [imageId], profileId: "success" }),
    },
  );
  assert.equal(contextResponse.status, 200);
  const contextPayload = await contextResponse.json() as {
    reviewState: { draft: { chunks: Array<Record<string, unknown>> } };
  };
  const contextImage = contextPayload.reviewState.draft.chunks.find(
    (candidate) => candidate.id === imageId,
  )!;
  assert.equal(contextImage.contextReviewState, "awaiting_review");
  assert.equal(contextImage.contextModel, "success-mm");
  assert.equal(contextImage.contextProfileId, "success");
  assert.equal(contextImage.contextProfileName, "本地成功模型");
  assert.equal(contextImage.vlmProfileId, vlmProfileBeforeContext);
  assert.equal(fakeRequests.length, beforeContextRequests + 1);
  assert.doesNotMatch(
    JSON.stringify(fakeRequests.at(-1)!.body),
    /data:image\//,
    "Context generation is a separate text-only model call",
  );

  const sourceImageDemo = await (await fetch(`${baseUrl}/api/demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceKind: "image" }),
  })).json() as { id: string; documents: Array<{ id: string }> };
  const sourceImageBatchId = sourceImageDemo.id;
  const sourceImageDocumentId = sourceImageDemo.documents[0].id;
  const sourceImageConfirmed = await (await fetch(
    `${baseUrl}/api/batches/${sourceImageBatchId}/documents/${sourceImageDocumentId}/review/confirm`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  )).json() as { reviewState: { draft: { chunks: Array<Record<string, unknown>> } } };
  const sourceImageChunk = sourceImageConfirmed.reviewState.draft.chunks.find(
    (candidate) => candidate.type === "image",
  )!;
  const sourceImageVlm = await fetch(
    `${baseUrl}/api/batches/${sourceImageBatchId}/documents/${sourceImageDocumentId}/chunks/${encodeURIComponent(String(sourceImageChunk.id))}/vlm-summary`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "success" }),
    },
  );
  assert.equal(sourceImageVlm.status, 200);
  const sourceImageObjects = await (await fetch(
    `${baseUrl}/api/batches/${sourceImageBatchId}/objects?documentId=${sourceImageDocumentId}`,
  )).json() as { objects: Array<{ assetClass: string }> };
  assert.equal(
    sourceImageObjects.objects.some((object) => object.assetClass === "extracted_image"),
    true,
    "a controlled direct-image VLM input persists as extracted_image",
  );
  assert.equal(
    sourceImageObjects.objects.some((object) => object.assetClass === "pdf_page_render"),
    false,
    "a direct image does not create a redundant PDF page render",
  );
} finally {
  await stop(app);
  await new Promise<void>((resolveClose) => fake.close(() => resolveClose()));
}

console.log("Model profile and VLM API workflow tests passed");
