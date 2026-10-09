import assert from "node:assert/strict";
import {
  parseModelProfiles,
  publicModelProfiles,
} from "./model-profiles.js";
import {
  createVlmClient,
  VLM_PROMPT_VERSION,
} from "./vlm-client.js";
import { resolve } from "node:path";
import { sourceVersionFromFile } from "./v21-input.js";
import { resolveTrustedImageInput } from "./trusted-image-input.js";

const profiles = parseModelProfiles(JSON.stringify([{
  id: "local-mm",
  name: "本地多模态模型",
  capabilities: ["vlm", "context"],
  baseUrl: "http://127.0.0.1:4567/v1",
  apiKey: "never-return-this-secret",
  model: "private-model-name",
  timeoutMs: 250,
}]));
assert.deepEqual(publicModelProfiles(profiles), [{
  id: "local-mm",
  name: "本地多模态模型",
  capabilities: ["vlm", "context"],
}]);
assert.doesNotMatch(
  JSON.stringify(publicModelProfiles(profiles)),
  /baseUrl|apiKey|private-model-name|never-return-this-secret/,
);

let capturedUrl = "";
let capturedInit: RequestInit | undefined;
const generate = createVlmClient(profiles[0], async (url, init) => {
  capturedUrl = String(url);
  capturedInit = init;
  return new Response(JSON.stringify({
    choices: [{ message: { content: "杯体应沿箭头方向锁定。" } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
});
const summary = await generate({
  imageDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
  productIdentity: "星澜 A1 智能料理机",
  section: "安装",
  caption: "杯体与主机的锁定方向",
  nearbyText: "确认杯体已锁定后再通电。",
});
assert.equal(summary, "杯体应沿箭头方向锁定。");
assert.equal(capturedUrl, "http://127.0.0.1:4567/v1/chat/completions");
assert.equal(
  (capturedInit!.headers as Record<string, string>).Authorization,
  "Bearer never-return-this-secret",
);
const request = JSON.parse(String(capturedInit!.body)) as {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
};
assert.equal(request.model, "private-model-name");
const userContent = request.messages.find((message) => message.role === "user")!
  .content as Array<Record<string, unknown>>;
assert.ok(userContent.some((part) => part.type === "text"));
assert.ok(userContent.some((part) => {
  const image = part.image_url as { url?: string } | undefined;
  return part.type === "image_url" && image?.url?.startsWith("data:image/png;base64,");
}));
assert.match(JSON.stringify(userContent), /星澜 A1|安装|锁定方向|确认杯体/);
assert.equal(VLM_PROMPT_VERSION, "image-summary-v1");

const empty = createVlmClient(profiles[0], async () =>
  new Response(JSON.stringify({ choices: [{ message: { content: "  " } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
await assert.rejects(() => empty({
  imageDataUrl: "data:image/png;base64,AA==",
  productIdentity: null,
  section: null,
  caption: null,
  nearbyText: "",
}), /空内容/);

const failed = createVlmClient(profiles[0], async () =>
  new Response(JSON.stringify({ error: { message: "private upstream detail" } }), {
    status: 504,
    headers: { "Content-Type": "application/json" },
  }));
await assert.rejects(() => failed({
  imageDataUrl: "data:image/png;base64,AA==",
  productIdentity: null,
  section: null,
  caption: null,
  nearbyText: "",
}), /VLM 服务失败/);

console.log("Secure model profile and multimodal VLM client tests passed");

const pdfPath = resolve("qa/v21-source-sample.pdf");
const sourceDocumentVersion = await sourceVersionFromFile(pdfPath);
const trusted = await resolveTrustedImageInput({
  sourceAsset: { path: pdfPath, mimeType: "application/pdf" },
  sourceDocumentVersion,
  sourceSegments: [{
    sourceDocumentVersion,
    sourceViewKind: "original_file",
    locationQuality: "exact",
    page: 1,
    bbox: [72, 60, 540, 92],
  }],
});
assert.equal(trusted.source, "pdf_crop");
assert.match(trusted.dataUrl, /^data:image\/png;base64,/);
assert.ok(trusted.dataUrl.length > 500, "the PDF crop contains rendered image pixels");
await assert.rejects(
  () => resolveTrustedImageInput({
    sourceAsset: { path: pdfPath, mimeType: "application/pdf" },
    sourceDocumentVersion,
    sourceSegments: [{
      sourceDocumentVersion: "sha256:mismatch",
      sourceViewKind: "original_file",
      locationQuality: "exact",
      page: 1,
      bbox: [72, 60, 540, 92],
    }],
  }),
  /版本不匹配/,
);
await assert.rejects(
  () => resolveTrustedImageInput({
    sourceAsset: { path: pdfPath, mimeType: "application/pdf" },
    sourceDocumentVersion,
    sourceSegments: [{
      sourceDocumentVersion,
      sourceViewKind: "parsed_document",
      locationQuality: "parsed_only",
      page: 1,
      bbox: null,
    }],
  }),
  /缺少可信图片资产或精确裁剪范围/,
);

console.log("Trusted PDF image crop tests passed");
