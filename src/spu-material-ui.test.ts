import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, script, styles] = await Promise.all([
  readFile("index.html", "utf8"),
  readFile("app.js", "utf8"),
  readFile("styles.css", "utf8"),
]);

for (const id of [
  "spuProductName",
  "spuCategorySearch",
  "spuCategorySelect",
  "spuBrand",
  "spuModelSeries",
  "spuCandidateState",
  "spuMatches",
  "spuSelectedList",
  "spuAssignmentMode",
  "selectExistingSpuMode",
  "createNewSpuMode",
  "spuOutputConfig",
]) assert.match(html, new RegExp(`id="${id}"`));

assert.doesNotMatch(html, /id="spuIdInput"/);
assert.match(html, /分配资料归属/);
assert.match(html, /选择已有 SPU/);
assert.match(html, /新建 SPU/);
assert.match(html, /仅生成 Markdown/);
assert.match(script, /\/api\/spus\/preview/);
assert.match(script, /\/api\/spu-categories\/preview/);
assert.match(script, /spu-material-selection/);
assert.match(script, /scopeStatus!=="confirmed"/);
assert.match(script, /资料归属确认后才能生成输出/);
assert.match(script, /普通 Chunk 将继承文档 SPU/);
assert.match(script, /未确认资料归属/);
assert.match(script, /data-use-spu/);
assert.match(script, /data-remove-spu/);
assert.match(script, /item\.documentType===type&&item\.status!=="stale"&&item\.fileName/);
assert.match(script, /documentType!==selectedDocumentType/);
assert.match(script, /function renderSpuScopeFields/);
assert.match(script, /integrationStatus"\)\.textContent="资料归属已确认/);
assert.match(script, /button\.textContent="Markdown 生成中/);
assert.match(script, /result\.reused\?"Markdown 已是最新版本"/);
assert.match(script, /async function renewDocumentLease/);
assert.match(script, /leaseRecoveryPending/);
assert.match(script, /requestId!==state\.spuPreviewRequestId/);
assert.match(script, /spuMatches"\)\.replaceChildren\(\)/);
assert.match(script, /escapeHtml\(documentType\).*previewFileName/);
assert.match(script, /_\$\{type\}_\$\{safeSourceBaseName\(file\?\.name\)\}_\$\{version\}\.md/);
assert.match(styles, /@media\(max-width:700px\).*\.spu-create-grid/s);

console.log("SPU material UI contract tests passed");
