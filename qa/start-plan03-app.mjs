process.env.PORT = "4182";
process.env.WORKSPACE_ROOT = ".workspace/v21-plan03-g3";
process.env.CONTEXT_BASE_URL = "http://127.0.0.1:4290/v1";
process.env.CONTEXT_API_KEY = "local-qa-placeholder";
process.env.CONTEXT_MODEL = "fake-context-v1";
process.env.CONTEXT_TIMEOUT_MS = "3000";
process.env.MODEL_PROFILES_JSON = JSON.stringify([{
  id: "fake-context",
  name: "本地 Context QA",
  capabilities: ["context"],
  baseUrl: process.env.CONTEXT_BASE_URL,
  apiKey: process.env.CONTEXT_API_KEY,
  model: process.env.CONTEXT_MODEL,
  timeoutMs: Number(process.env.CONTEXT_TIMEOUT_MS),
}]);

await import("../dist/server.js");
