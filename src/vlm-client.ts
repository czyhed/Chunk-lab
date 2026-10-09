import type { ModelProfile } from "./model-profiles.js";

export const VLM_PROMPT_VERSION = "image-summary-v1";

export type VlmInput = {
  imageDataUrl: string;
  productIdentity: string | null;
  section: string | null;
  caption: string | null;
  nearbyText: string;
};

type VlmResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  message?: string;
  error?: { message?: string };
};

export function createVlmClient(
  profile: ModelProfile,
  fetchImpl: typeof fetch = fetch,
): (input: VlmInput) => Promise<string> {
  if (!profile.capabilities.includes("vlm"))
    throw new Error("模型 profile 不支持图片理解");
  return async (input) => {
    if (!/^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(input.imageDataUrl))
      throw new Error("VLM 请求缺少可信图片输入");
    const response = await fetchImpl(
      `${profile.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${profile.apiKey}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(profile.timeoutMs),
        body: JSON.stringify({
          model: profile.model,
          temperature: 0,
          messages: [
            {
              role: "system",
              content:
                "你负责理解电商文档中的一张真实图片。只输出简洁、可核验的中文事实摘要；优先说明商品、部件、动作、方向、状态和适用范围。不得臆测图片或附近文本没有提供的参数。",
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    productIdentity: input.productIdentity,
                    section: input.section,
                    caption: input.caption,
                    nearbyText: input.nearbyText,
                  }),
                },
                {
                  type: "image_url",
                  image_url: { url: input.imageDataUrl, detail: "high" },
                },
              ],
            },
          ],
        }),
      },
    );
    let payload: VlmResponse;
    try {
      payload = await response.json() as VlmResponse;
    } catch {
      throw new Error(`VLM 服务返回无效响应 (${response.status})`);
    }
    if (!response.ok)
      throw new Error(
        `VLM 服务失败 (${response.status}): ${payload.error?.message ?? payload.message ?? "未知错误"}`,
      );
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim())
      throw new Error("VLM 服务返回了空内容");
    return content.trim();
  };
}
