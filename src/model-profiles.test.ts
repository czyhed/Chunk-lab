import assert from "node:assert/strict";
import { parseModelProfiles, publicModelProfiles } from "./model-profiles.js";

const profiles = parseModelProfiles(
  JSON.stringify([{
    id: "dashscope-context",
    name: "DashScope Context",
    capabilities: ["context"],
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: "${EMBEDDING_API_KEY}",
    model: "qwen3.7-flash-2026-07-15",
  }]),
  { EMBEDDING_API_KEY: "test-secret" },
);
assert.equal(profiles[0]?.apiKey, "test-secret");
assert.deepEqual(publicModelProfiles(profiles), [{
  id: "dashscope-context",
  name: "DashScope Context",
  capabilities: ["context"],
}]);
assert.throws(
  () => parseModelProfiles(
    JSON.stringify([{
      id: "missing-secret",
      name: "Missing Secret",
      capabilities: ["context"],
      baseUrl: "https://example.com/v1",
      apiKey: "${NOT_CONFIGURED}",
      model: "test-model",
    }]),
    {},
  ),
  /profile apiKey env NOT_CONFIGURED/,
);

console.log("Model profile env-reference tests passed");
