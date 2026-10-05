import assert from "node:assert/strict";
import {
  describeUnavailableReasons,
  formatUserFacingError,
} from "../user-facing-errors.js";

const unavailable = describeUnavailableReasons([
  "partial_content_unconfirmed",
  "missing_reliable_search_text",
  "image_only_without_reliable_text",
]);
assert.deepEqual(unavailable, {
  reason: "部分内容尚未人工确认；缺少可靠的检索文本；图片既无可靠文本也无可用资源",
  impact: "该 Chunk 暂时不能生成 Context，也不会进入 Embedding。",
  next: "请补充或修正文本后重新生成。",
  diagnosticCodes: [
    "partial_content_unconfirmed",
    "missing_reliable_search_text",
    "image_only_without_reliable_text",
  ],
});

const emptyTable = describeUnavailableReasons(["normalization_failed", "missing_reliable_search_text"], { contentType: "table" });
assert.equal(emptyTable.reason, "MinerU 未返回可用的表格结构；缺少可靠的检索文本");
assert.equal(emptyTable.next, "请重新解析；若表格仍为空，请在 Draft 中补充表格结构并保存。");

const visibleMergedTable = describeUnavailableReasons(
  ["normalization_failed", "missing_reliable_search_text"],
  { contentType: "table", hasReliableText: true, hasTableStructure: true },
);
assert.doesNotMatch(visibleMergedTable.reason, /MinerU 未返回可用的表格结构/);
assert.doesNotMatch(visibleMergedTable.next, /重新解析/);
assert.match(visibleMergedTable.next, /核对当前合并表格并保存/);

const saveFailure = formatUserFacingError({
  code: "INTERNAL_SERVER_ERROR",
  message: "ENOENT: open 'D:\\private\\batch.json.tmp'",
  recovery: "请稍后重试；若问题持续，请联系维护人员并提供发生时间。",
});
assert.deepEqual(saveFailure, {
  reason: "服务器未能完成本次请求。",
  impact: "本次操作未完成，页面中的未保存更改可能尚未落盘。",
  next: "请稍后重试；若问题持续，请联系维护人员并提供发生时间。",
  diagnosticCodes: ["INTERNAL_SERVER_ERROR"],
});
assert.doesNotMatch(JSON.stringify(saveFailure), /ENOENT|D:\\/);

const manualFailure = formatUserFacingError({
  code: "EMPTY_BBOX_INTERSECTION",
  message: "选区 internal-id 未命中可信 Source Block",
  details: {
    problemAnnotations: [{ id: "internal-id", page: 3, type: "table" }],
  },
});
assert.deepEqual(manualFailure, {
  reason: "P.3 的表格框未命中可信 Source Block。",
  impact: "无法生成对应 Chunk，当前 Preview 保持不变。",
  next: "请定位问题框，调整范围、排除或删除后重试。",
  diagnosticCodes: ["EMPTY_BBOX_INTERSECTION"],
});

for (const [code, reason] of [
  ["VLM_SERVICE_UNAVAILABLE", "图片理解服务尚未配置。"],
  ["TRUSTED_IMAGE_UNAVAILABLE", "当前图片缺少可信原始资产或精确裁剪范围。"],
  ["VLM_TIMEOUT", "图片理解模型响应超时。"],
  ["VLM_GENERATION_FAILED", "图片理解模型未返回可用摘要。"],
]) {
  const presentation = formatUserFacingError({ code, message: "private raw model error" });
  assert.equal(presentation.reason, reason);
  assert.equal(presentation.diagnosticCodes.length, 0);
  assert.match(presentation.impact, /摘要|操作/);
  assert.match(presentation.next, /重试|配置|原始/);
  assert.doesNotMatch(JSON.stringify(presentation), /private raw|VLM_|TRUSTED_IMAGE/);
}

console.log("User-facing Chinese error presentation tests passed");
