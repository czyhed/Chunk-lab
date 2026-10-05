const REASON_LABELS = Object.freeze({
  unsupported_content: "内容类型暂不支持",
  normalization_failed: "内容规范化失败",
  partial_content_unconfirmed: "部分内容尚未人工确认",
  manual_fix_unvalidated: "人工修正尚未通过校验",
  missing_reliable_search_text: "缺少可靠的检索文本",
  image_only_without_reliable_text: "图片既无可靠文本也无可用资源",
  excluded_from_draft: "该 Chunk 已从 Draft 排除",
  eligibility_missing: "缺少向量化资格结果",
  image_excluded: "图片已按当前策略排除",
  image_reference_without_text: "图片引用缺少可检索文本",
  reference_requires_related_text: "仅引用图片缺少有效文字关联",
  image_reference_uses_related_text: "仅引用图片通过关联文字 Chunk 工作",
  manual_review_required: "内容需要人工复核",
});

const ANNOTATION_LABELS = Object.freeze({
  text: "文本",
  heading: "标题",
  table: "表格",
  image: "图片",
  list: "列表",
  formula: "公式",
  code: "代码",
  warning: "警告",
  caption: "图注",
  page_number: "页码",
});

export function describeUnavailableReasons(codes = [], context = {}) {
  const diagnosticCodes = [...new Set(codes.filter((code) => typeof code === "string"))];
  const labels = [...new Set(diagnosticCodes.map((code) => {
    if (code === "normalization_failed" && context.contentType === "table" && !context.hasTableStructure && !context.hasReliableText)
      return "MinerU 未返回可用的表格结构";
    return REASON_LABELS[code] ?? (/[\u3400-\u9fff]/.test(code) ? code : "其他资格检查未通过");
  }))];
  const emptyTable = context.contentType === "table" && diagnosticCodes.includes("normalization_failed") && !context.hasTableStructure && !context.hasReliableText;
  return {
    reason: labels.join("；") || "当前内容不符合生成条件",
    impact: "该 Chunk 暂时不能生成 Context，也不会进入 Embedding。",
    next: emptyTable
      ? "请重新解析；若表格仍为空，请在 Draft 中补充表格结构并保存。"
      : context.contentType === "table" && diagnosticCodes.includes("normalization_failed")
        ? "请在 Draft 中核对当前合并表格并保存，系统将按已审核结构重新计算资格。"
      : "请补充或修正文本后重新生成。",
    diagnosticCodes,
  };
}

export function formatUserFacingError(value) {
  const error = typeof value === "string" ? { message: value } : value ?? {};
  const code = typeof error.code === "string" ? error.code : null;
  const diagnosticCodes = code ? [code] : [];
  if ([
    "EMPTY_BBOX_INTERSECTION",
    "BBOX_UNTRUSTED",
    "SOURCE_BLOCK_MISSING",
    "ANNOTATION_BBOX_INVALID",
  ].includes(code)) {
    const problem = error.details?.problemAnnotations?.[0];
    const location = problem && Number.isSafeInteger(problem.page)
      ? `P.${problem.page} 的${ANNOTATION_LABELS[problem.type] ?? "问题"}框`
      : "人工框";
    return {
      reason: `${location}${code === "BBOX_UNTRUSTED"
        ? "缺少可信定位信息"
        : code === "SOURCE_BLOCK_MISSING"
          ? "引用的 Source Block 已不存在"
          : code === "ANNOTATION_BBOX_INVALID"
            ? "坐标无效"
            : "未命中可信 Source Block"}。`,
      impact: "无法生成对应 Chunk，当前 Preview 保持不变。",
      next: "请定位问题框，调整范围、排除或删除后重试。",
      diagnosticCodes,
    };
  }
  if (code === "INTERNAL_SERVER_ERROR")
    return {
      reason: "服务器未能完成本次请求。",
      impact: "本次操作未完成，页面中的未保存更改可能尚未落盘。",
      next: error.recovery || "请稍后重试；若问题持续，请联系维护人员并提供发生时间。",
      diagnosticCodes,
    };
  if (code === "CONTEXT_SERVICE_UNAVAILABLE")
    return {
      reason: "Context 服务当前不可用。",
      impact: "暂时无法生成 Context；已保存的 Chunk 和审阅结果不受影响。",
      next: error.recovery || "请联系维护人员检查服务配置后重试。",
      diagnosticCodes: [],
    };
  if (code === "VLM_SERVICE_UNAVAILABLE")
    return {
      reason: "图片理解服务尚未配置。",
      impact: "暂时无法生成机器原始摘要；人工摘要和已保存内容不受影响。",
      next: error.recovery || "请选择可用模型或联系维护人员完成配置后重试。",
      diagnosticCodes: [],
    };
  if (code === "TRUSTED_IMAGE_UNAVAILABLE")
    return {
      reason: "当前图片缺少可信原始资产或精确裁剪范围。",
      impact: "图片不会发送给模型，现有摘要保持不变。",
      next: error.recovery || "请重新导入原始图片或补齐 PDF 精确来源后重试。",
      diagnosticCodes: [],
    };
  if (code === "VLM_TIMEOUT")
    return {
      reason: "图片理解模型响应超时。",
      impact: "本次摘要未生成，已保存内容没有被覆盖。",
      next: error.recovery || "请稍后重试或选择其他图片理解模型。",
      diagnosticCodes: [],
    };
  if (code === "VLM_GENERATION_FAILED")
    return {
      reason: "图片理解模型未返回可用摘要。",
      impact: "本次摘要未生成，已保存内容没有被覆盖。",
      next: error.recovery || "请稍后重试或选择其他图片理解模型。",
      diagnosticCodes: [],
    };
  if (code === "IMAGE_REFERENCE_REQUIRED")
    return {
      reason: "仅引用图片必须关联至少一个有效文字 Chunk。",
      impact: "图片策略未保存；图片不会进入文本检索、Context 或 Embedding。",
      next: error.recovery || "请搜索并选择同一文档内至少一个有效文字 Chunk 后重试。",
      diagnosticCodes,
    };
  const message = safeMessage(error.message ?? error.error);
  return {
    reason: message,
    impact: "当前操作未完成，现有已保存内容不受影响。",
    next: error.recovery || "请检查当前输入后重试；若问题持续，请联系维护人员。",
    diagnosticCodes,
  };
}

function safeMessage(value) {
  const message = typeof value === "string" && value.trim() ? value.trim() : "请求未能完成。";
  return /ENOENT|[a-zA-Z]:\\|node:internal|\n\s*at\s+/i.test(message) || !/[\u3400-\u9fff]/.test(message)
    ? "服务器未能完成本次请求。"
    : message;
}
