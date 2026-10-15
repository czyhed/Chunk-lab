export type RetrievalRecord = { chunkId: string; vector: number[] };

export function evaluateRecallAtK(input: {
  queryVector: number[];
  records: RetrievalRecord[];
  relevantChunkIds: string[];
  k: number;
}) {
  if (!input.queryVector.length) throw new Error("查询向量不能为空");
  if (!Number.isSafeInteger(input.k) || input.k < 1) throw new Error("K 必须是正整数");
  const relevant = new Set(input.relevantChunkIds.filter(Boolean));
  if (!relevant.size) throw new Error("请至少标注一个相关 Chunk");
  const results = input.records
    .filter((record) => record.vector.length === input.queryVector.length)
    .map((record) => ({ chunkId: record.chunkId, score: cosine(input.queryVector, record.vector) }))
    .sort((left, right) => right.score - left.score || left.chunkId.localeCompare(right.chunkId))
    .slice(0, input.k);
  const hitChunkIds = results.filter((item) => relevant.has(item.chunkId)).map((item) => item.chunkId);
  return {
    k: input.k,
    relevantCount: relevant.size,
    hitCount: hitChunkIds.length,
    hitChunkIds,
    recallAtK: hitChunkIds.length / relevant.size,
    results,
  };
}

function cosine(left: number[], right: number[]): number {
  let dot = 0, leftNorm = 0, rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}
