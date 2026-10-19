import { createServer } from "node:http";

const port = Number(process.env.FAKE_CONTEXT_PORT) || 4290;
const calls = { total: 0, succeeded: 0, failed: 0 };
const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/calls") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(calls));
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (part) => (body += part));
  request.on("end", () => {
    calls.total += 1;
    const payload = JSON.parse(body);
    const input = JSON.parse(payload.messages?.[1]?.content ?? "{}");
    if (String(input.chunkText).includes("清洁")) {
      calls.failed += 1;
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "fake item failure" } }));
      return;
    }
    calls.succeeded += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                "该内容适用于星澜 A1 智能料理机的当前说明章节。它补充了原文中本产品所指的商品身份。",
            },
          },
        ],
      }),
    );
  });
});

server.listen(port, "127.0.0.1", () =>
  console.log(`fake context server listening on ${port}`),
);
