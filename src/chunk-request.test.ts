import assert from "node:assert/strict";
import { parseChunkRequest } from "./chunk-request.js";

assert.deepEqual(parseChunkRequest({}), {
  strategy: "structure",
  chunkSize: 512,
  chunkOverlap: 64,
  bufferSize: 1,
  breakpointPercentile: 90,
  semanticMaxChunkSize: 768,
  imagePolicy: "summary",
});

assert.throws(
  () => parseChunkRequest({ chunkSize: 64, chunkOverlap: 64 }),
  (error: unknown) =>
    error instanceof Error &&
    error.message === "Chunk overlap must be less than chunk size" &&
    "statusCode" in error &&
    error.statusCode === 400,
);

console.log("Chunk request tests passed");
