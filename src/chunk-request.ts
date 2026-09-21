import type { ChunkRequest } from "./chunking.js";

export function parseChunkRequest(input: Partial<ChunkRequest>): ChunkRequest {
  const strategy = ["structure", "sentence", "token", "semantic", "parent-child"].includes(
    input.strategy ?? "",
  )
    ? input.strategy!
    : "structure";
  const chunkSize = Math.max(
    32,
    Math.min(4096, Number(input.chunkSize) || 512),
  );
  const chunkOverlap = Math.max(
    0,
    Math.min(4095, Number(input.chunkOverlap ?? 64)),
  );
  if (!Number.isFinite(chunkOverlap))
    throw Object.assign(new Error("重叠量必须是有效数字"), { statusCode: 400 });
  if (chunkOverlap >= chunkSize)
    throw Object.assign(
      new Error("Chunk overlap must be less than chunk size"),
      { statusCode: 400 },
    );
  const parentChunkSize = Number(input.parentChunkSize ?? 1536);
  if (strategy === "parent-child" && (!Number.isInteger(Number(input.chunkSize ?? 512)) || Number(input.chunkSize ?? 512) < 32 || Number(input.chunkSize ?? 512) > 4096 || !Number.isInteger(Number(input.chunkOverlap ?? 64)) || Number(input.chunkOverlap ?? 64) < 0))
    throw Object.assign(new Error("子块大小必须为 32–4096 的整数，重叠量必须为非负整数"), { statusCode: 400 });
  if (strategy === "parent-child" && (!Number.isInteger(parentChunkSize) || parentChunkSize <= chunkSize || parentChunkSize > 8192))
    throw Object.assign(new Error("父块大小必须大于子块大小，且不超过 8192 Token"), { statusCode: 400 });
  return {
    strategy,
    ...(strategy === "parent-child" ? { parentChunkSize } : {}),
    chunkSize,
    chunkOverlap,
    bufferSize: Math.max(1, Math.min(5, Number(input.bufferSize) || 1)),
    breakpointPercentile: Math.max(
      50,
      Math.min(99, Number(input.breakpointPercentile) || 90),
    ),
    semanticMaxChunkSize: Math.max(
      32,
      Math.min(4096, Number(input.semanticMaxChunkSize) || 768),
    ),
    imagePolicy: ["summary", "reference", "exclude"].includes(
      input.imagePolicy ?? "",
    )
      ? input.imagePolicy!
      : "summary",
  };
}
