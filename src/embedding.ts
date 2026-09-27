export type EmbedTexts = (texts: string[]) => Promise<number[][]>;

/** Stable local vectors keep Semantic Boundary previews reproducible in the workbench. */
export function createDeterministicEmbeddingClient(dimensions = 16): EmbedTexts {
  if (!Number.isInteger(dimensions) || dimensions < 2)
    throw new Error("Deterministic embedding dimensions must be at least 2");
  return async (texts) => texts.map((text) => {
    const vector = Array.from({ length: dimensions }, () => 0);
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      const bucket = (code * 31 + index * 17) % dimensions;
      vector[bucket] += (code % 2 ? 1 : -1) * (1 + (code % 7) / 10);
    }
    const norm = Math.hypot(...vector) || 1;
    return vector.map((value) => Number((value / norm).toFixed(8)));
  });
}

type EmbeddingResponse = {
  data?: Array<{ embedding?: number[]; index?: number }>;
  code?: string;
  message?: string;
};

export function createEmbeddingClient(config: {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}): EmbedTexts {
  return async (texts) => {
    const response = await fetch(
      `${config.baseUrl.replace(/\/$/, "")}/embeddings`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(config.timeoutMs ?? 30_000),
        body: JSON.stringify({ model: config.model, input: texts }),
      },
    );
    const payload = (await response.json()) as EmbeddingResponse;
    if (!response.ok)
      throw new Error(
        `Embedding 服务失败 (${response.status}): ${payload.message ?? payload.code ?? "未知错误"}`,
      );
    const embeddings = payload.data;
    if (!embeddings?.length || embeddings.length !== texts.length)
      throw new Error("Embedding 服务返回的向量数量不正确");
    return [...embeddings]
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((item) => {
        if (!item.embedding?.length)
          throw new Error("Embedding 服务返回了空向量");
        return item.embedding;
      });
  };
}
