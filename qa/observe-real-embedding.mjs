import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const baseUrl = process.env.EMBEDDING_BASE_URL?.trim();
const apiKey = process.env.EMBEDDING_API_KEY?.trim();
const model = process.env.EMBEDDING_MODEL?.trim();
if (!baseUrl || !apiKey || !model) throw new Error("Embedding profile is incomplete");

const startedAt = new Date().toISOString();
const text = "产品技术白皮书中的中文检索测试文本。";
let response;
let payload;
try {
  response = await fetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(Number(process.env.EMBEDDING_TIMEOUT_MS) || 30_000),
    body: JSON.stringify({ model, input: [text] }),
  });
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
} catch (error) {
  const output = {
    status: "failed",
    failureClass: error?.name === "TimeoutError" || error?.name === "AbortError"
      ? "timeout"
      : "network",
    profile: "legacy-embedding-env",
    model,
    attemptCount: 1,
    paidCallCount: 1,
    retried: false,
    startedAt,
  };
  await save(output);
  console.log(JSON.stringify(output));
  process.exitCode = 1;
}

if (response) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const vector = data[0]?.embedding;
  if (!response.ok || !Array.isArray(vector) || !vector.length ||
      vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    const output = {
      status: "failed",
      failureClass: response.status === 429 ? "rate_limited" : "invalid_response",
      httpStatus: response.status,
      profile: "legacy-embedding-env",
      model,
      attemptCount: 1,
      paidCallCount: 1,
      retried: false,
      startedAt,
    };
    await save(output);
    console.log(JSON.stringify(output));
    process.exitCode = 1;
  } else {
    assert.equal(data.length, 1);
    const output = {
      status: "succeeded",
      profile: "legacy-embedding-env",
      model,
      inputLanguage: "zh",
      inputCount: 1,
      dimensions: vector.length,
      vectorFinite: true,
      vectorSha256: createHash("sha256").update(JSON.stringify(vector)).digest("hex"),
      attemptCount: 1,
      paidCallCount: 1,
      retried: false,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    await save(output);
    console.log(JSON.stringify(output));
  }
}

async function save(value) {
  const directory = resolve("output/evidence/object-storage-real-suppliers-production-readiness");
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "real-embedding-observation.json"), JSON.stringify(value, null, 2), "utf8");
}
