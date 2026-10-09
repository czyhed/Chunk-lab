import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
assert.match(app, /api\("\/api\/model-profiles"\)/);
for (const controlId of [
  "chunkImagePolicy",
  "vlmProfileSelect",
  "generateVlmSummary",
  "vlmGenerated",
]) assert.match(app, new RegExp(`id="${controlId}"`));
assert.match(app, /chunks\/\$\{encodeURIComponent\(chunk\.id\)\}\/vlm-summary/);
assert.match(app, /chunks\/\$\{encodeURIComponent\(chunk\.id\)\}\/image-summary/);
assert.match(
  app,
  /const pendingImageReview=\{imagePolicy:\$\("#chunkImagePolicy"\)/,
  "VLM generation captures unsaved image-review fields before replacing review state",
);
assert.match(
  app,
  /generatedChunk\.imageEditorDraft=pendingImageReview/,
  "VLM generation restores unsaved image-review fields after the server response",
);
assert.match(app, /data-related-chunk-id/);
assert.match(app, /imageRelatedSearch/);
assert.match(app, /imageLinkCandidates/);
assert.match(app, /IMAGE_REFERENCE_REQUIRED/);
assert.match(app, /try\{setError\(""\);\$\("#saveState"\)\.textContent="正在保存图片策略到当前 Draft"/);
assert.match(app, /id="imagePolicyFeedback"/);
assert.match(app, /id="tableRetrievalFeedback"/);
assert.match(app, /仅引用策略：只关联文字 Chunk，不需要人工摘要或 VLM/);
assert.match(app, /正在保存图片策略到当前 Draft/);
assert.match(app, /图片策略保存失败/);
assert.match(app, /function isImageReference/);
assert.match(app, /image-reference-detail/);
assert.match(app, /function documentLastPage/);
assert.match(app, /默认文档最后一页/);
assert.match(app, /scrollSourceIds\(sourceIds\)/);
assert.doesNotMatch(app, /if\(!summary\)return setError\(\{message:"请先填写最终审核摘要。"/);
assert.match(app, /id="contextProfileSelect"[\s\S]+id="generateOneContext"/);
assert.match(app, /profileId:state\.selectedContextProfileId/);
assert.doesNotMatch(app, /建议增强 · 待补充图片摘要/);
assert.match(app, /data-edit-image-summary/);
assert.match(app, /function qualityFlagLabel/);
assert.match(app, /chunkTypeFilter/);
assert.match(app, /state\.chunkTypeFilter/);
assert.match(app, /function chunkTypeLabel/);
assert.match(app, /title: "标题"/);
assert.match(html, /筛选 Chunk 类型/);
assert.match(app, /addTableRowBefore/);
assert.match(app, /addTableRowAfter/);
assert.match(app, /addTableColumnBefore/);
assert.match(app, /addTableColumnAfter/);
assert.match(app, /删除选中列/);
assert.match(app, /from "\/table-editor-operations\.js\?v=table-position1"/);
assert.match(app, /source_location_page_only: "来源仅定位到页面"/);
assert.match(app, /qualityFlagLabel\(flag\)/);
assert.match(app, /file\.embeddingJob\?\.profileId\?\?file\.embeddingModelId/);
assert.match(app, /file\.embeddingJob\?\.summary\.failed\?"重试失败项":file\.embeddingJob\?"完成":"开始向量化"/);
assert.match(app, /Embedding 成功，待入库/);
assert.match(app, /入库成功，处理完成/);
assert.match(html, /id="retrievalMeta"/);
assert.match(app, /Recall@\$\{result\.k\}/);
assert.match(app, /result\.embeddingModel/);
assert.match(app, /result\.databaseProfileId/);
assert.match(app, /result\.dataScope\.indexedRecordCount/);
assert.match(app, /new Date\(result\.testedAt\)/);
assert.match(html, /id="retrievalButton">检索验证<\/button>/);
assert.match(app, /api\("\/api\/agentic-retrieval-config"\)/);
assert.match(app, /window\.open\(state\.agenticRetrievalUiUrl,"_blank","noopener,noreferrer"\)/);
assert.doesNotMatch(app, /validationTaskId/);
assert.doesNotMatch(app, /state\.contextSummary=`待审核/);
assert.doesNotMatch(app, /state\.contextSummary=`失败 \$\{eligibleIds\.length\}/);
assert.match(app, /leftSource\.page[\s\S]+leftSource\.bbox\?\.\[1\][\s\S]+leftSource\.bbox\?\.\[0\]/);
assert.match(app, /api\("\/api\/database-profiles"\)/);
assert.match(app, /database-jobs/);
assert.match(app, /databaseJobMarkup/);
assert.match(html, /id="confirmSpuScope"/);
assert.match(html, /id="spuProductName"/);
assert.match(html, /id="spuCategorySelect"/);
assert.match(html, /id="spuSelectedList"/);
assert.doesNotMatch(html, /id="spuIdInput"/);
assert.match(app, /function currentSpuIds/);
assert.match(app, /\/api\/spus\/preview/);
assert.match(app, /spu-material-scope/);
assert.match(app, /chunks\/\$\{encodeURIComponent\(chunk\.id\)\}\/spu-scope/);
assert.match(app, /scopeStatus!=="confirmed"/);
assert.match(app, /const targetSpuIds=currentSpuIds\(file\)/);
assert.match(app, /function exportChildMarkup/);
assert.match(app, /spuStatusLabel\(child\.status\)/);
assert.match(app, /spu-material-export\/markdown\$\{query\}/);
assert.match(app, /id="chunkSpuScope"/);
assert.match(app, /id="saveChunkSpuScope"/);
assert.match(app, /scope==="common"\?ids/);
assert.match(app, /new URLSearchParams\(location\.search\)\.get\("batchId"\)/);
assert.match(app, /api\(`\/api\/batches\/\$\{encodeURIComponent\(batchId\)\}`\)/);
assert.match(app, /state\.files\.find\(\(file\) => file\.id === document\.id\)/);
assert.doesNotMatch(app, /state\.files\.find\(\(file\) => file\.name === document\.name\)/);
assert.doesNotMatch(html, /INTERFACE PLACEHOLDER/);
assert.match(html, /data-annotation-tool="marquee"[^>]*>批选</);
assert.match(html, /data-annotation-tool="watermark"[^>]*>清水印</);
assert.match(app, /event\.ctrlKey\|\|event\.metaKey/);
assert.match(app, /button\.disabled=!file\|\|file\.editable!==true/, "read-only sessions disable annotation tools");
assert.match(app, /const current=currentFile\(\);\s*if\(current\?\.editable!==true\)return;/, "read-only sessions cannot draw or clear watermark blocks");
assert.match(app, /tool==="watermark"[\s\S]{0,1800}generateManualPreview\("document"\)/, "watermark cleanup regenerates existing manual chunks so deleted Blocks do not leave orphan Chunks");
assert.match(app, /fullyContained:true,containmentTolerance:\.01/, "cross-page watermark cleanup tolerates small detection drift");

console.log("Image VLM and Context UI contract tests passed");
