import assert from "node:assert/strict";
import { createContextClient } from "./context-client.js";

let request: { url: string; init?: RequestInit } | undefined;
const client = createContextClient(
  {
    baseUrl: "https://context.example/v1/",
    apiKey: "secret-not-for-output",
    model: "fake-chat",
    timeoutMs: 500,
  },
  async (url, init) => {
    request = { url: String(url), init };
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "该内容属于星澜 A1 的安装章节。它要求使用前锁定杯体。" } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  },
);
const output = await client({
  chunkId: "chunk-1",
  finalText: "本产品杯体需要锁定。",
  contextPackage: {
    chunkId: "chunk-1",
    productIdentity: "星澜 A1",
    sourceText: "本产品杯体需要锁定。",
    referenceText: "星澜 A1 安装方法。",
    scope: ["当前来源 b1", "父标题 title"],
    skippedNeighborReasons: [],
  },
});
assert.equal(output.includes("星澜 A1"), true);
assert.equal(request?.url, "https://context.example/v1/chat/completions");
const body = JSON.parse(String(request?.init?.body));
assert.equal(body.model, "fake-chat");
assert.equal(body.messages[0].content.includes("2-4 句"), true);
assert.equal(body.messages[0].content.includes("上下文不足"), true);
assert.equal(body.messages[1].content.includes("星澜 A1"), true);

const failing = createContextClient(
  {
    baseUrl: "https://context.example/v1",
    apiKey: "secret-not-for-output",
    model: "fake-chat",
    timeoutMs: 500,
  },
  async () =>
    new Response(JSON.stringify({ message: "quota unavailable" }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    }),
);
await assert.rejects(
  () =>
    failing({
      chunkId: "chunk-1",
      finalText: "正文",
      contextPackage: {
        chunkId: "chunk-1",
        sourceText: "正文",
        referenceText: "参考",
        scope: [],
        skippedNeighborReasons: [],
      },
    }),
  /429.*quota unavailable/,
);

console.log("Context client tests passed");
