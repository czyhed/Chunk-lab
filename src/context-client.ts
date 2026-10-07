import type { ContextGenerator } from "./contextual.js";

type ContextResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  message?: string;
  error?: { message?: string };
};

export const CONTEXT_PROMPT_VERSION = "context-v1";

export function createContextClient(
  config: {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
  },
  fetchImpl: typeof fetch = fetch,
): ContextGenerator {
  return async (input) => {
    const response = await fetchImpl(
      `${config.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(config.timeoutMs),
        body: JSON.stringify({
          model: config.model,
          temperature: 0,
          messages: [
            {
              role: "system",
              content:
                "你为电商文档 Chunk 补充检索背景。只输出 2-4 句事实性背景，指明商品、型号、章节或功能，并补足原文省略的指代。不得重复大段 Chunk，不得新增原文没有的参数、单位、适用范围或结论。无法确认时只输出“上下文不足”。",
            },
            {
              role: "user",
              content: JSON.stringify({
                productIdentity: input.contextPackage.productIdentity ?? null,
                parentSectionId: input.contextPackage.parentSectionId ?? null,
                actualScope: input.contextPackage.scope,
                sourceText: input.contextPackage.sourceText,
                referenceText: input.contextPackage.referenceText,
                chunkText: input.finalText,
              }),
            },
          ],
        }),
      },
    );
    const payload = (await response.json()) as ContextResponse;
    if (!response.ok)
      throw new Error(
        `Context 服务失败 (${response.status}): ${payload.error?.message ?? payload.message ?? "未知错误"}`,
      );
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim())
      throw new Error("Context 服务返回了空内容");
    return content.trim();
  };
}
