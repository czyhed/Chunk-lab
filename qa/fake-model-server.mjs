import { createServer } from "node:http";

const requests = [];
const port = Number(process.env.MODEL_FAKE_PORT) || 4555;

const server = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  if (request.method === "GET" && request.url === "/requests")
    return response.end(JSON.stringify({ requests }));
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.statusCode = 404;
    return response.end(JSON.stringify({ error: "not found" }));
  }
  let raw = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { raw += chunk; });
  request.on("end", () => {
    const body = JSON.parse(raw);
    const serializedMessages = JSON.stringify(body.messages ?? []);
    const imagePart = body.messages
      ?.flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .find((part) => part?.type === "image_url");
    const context = serializedMessages.includes("Chunk 补充检索背景");
    requests.push({
      sequence: requests.length + 1,
      role: context ? "context" : "vlm",
      modelConfigured: typeof body.model === "string" && body.model.length > 0,
      authorizationPresent: typeof request.headers.authorization === "string",
      imagePresent: typeof imagePart?.image_url?.url === "string" && imagePart.image_url.url.startsWith("data:image/png;base64,"),
      messageCharacters: serializedMessages.length,
      response: context
        ? "该图片说明星澜 A1 智能料理机的杯体安装步骤。检索时应结合锁定方向和通电前检查理解。"
        : "杯体应沿箭头方向旋转并锁定到主机。",
    });
    return response.end(JSON.stringify({
      choices: [{ message: { content: requests.at(-1).response } }],
    }));
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake model ready on ${port}`);
});
