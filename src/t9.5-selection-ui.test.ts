import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
assert.match(
  app,
  /overlay\.onclick=\(event\)=>\{if\(event\.target!==overlay\)return;clearAnnotationSelection\(\);/,
  "clicking source-page whitespace clears only when the overlay itself is the target",
);
assert.doesNotMatch(app, /if\(state\.strategy==="manual"\)\{toolbar\.classList\.add\("hidden"\);return\}/);
assert.match(app, /采用 Draft 后可生成/);
assert.doesNotMatch(app, /diagnosticCodes\.length\?`<details><summary>诊断详情/);
assert.match(app, /id="manualTranscription"/);
assert.match(app, /人工转录文字/);
assert.match(app, /const transcriptionAllowed=manualSelected&&selected\.type!=="image"/);
assert.match(app, /transcriptionSource="human"/);
assert.match(app, /原因：<\/strong>该人工框没有可用文字/);
assert.match(app, /下一步：<\/strong>填写人工转录文字，或将类型改为图片、表格等/);
assert.match(app, /manualOnly\?"人工框尚未生成 Chunk":"所选来源暂无对应 Chunk"/);
assert.match(app, /hasGenerated:Boolean\(review\?\.preview\|\|review\?\.draft\)/);
assert.match(app, /configGenerating=true/);
assert.doesNotMatch(app, /generationFailed\s*=\s*true;\s*state\.configDisclosureUserExpanded\s*=\s*true/);
assert.match(
  app,
  /function clearAnnotationSelection\(\) \{ state\.selectedBlockIds\.clear\(\); state\.lastSelectedBlockId=null; state\.lockedBlockId=null; state\.lockedChunkId=null; state\.lockedSourceKey=null; state\.linkSelection=null; state\.crossPageCollecting=false;/,
  "clearing source selection also clears locks and exits cross-page collection without deleting groups",
);
assert.match(app, /function clearSourceLock\(\)\{clearAnnotationSelection\(\);/);
assert.match(app, /const crossPage=new Set\(selectedBefore\.map\(\(item\)=>item\.page\)\)\.size>1/);
assert.match(app, /if\(regenerateMergedPage\)void generateManualPreview\("page"\);/);
assert.match(app, /async function updateReviewProgress\(action, payload = \{\}\)[\s\S]*?if \(!file\?\.editable \|\| !file\.reviewState\?\.draft\) return;[\s\S]*?setError\(""\);/);
assert.match(app, /file\.reviewProgress = result\.reviewProgress; file\.reviewRevision = result\.reviewRevision; setError\(""\); \$\("#saveState"\)\.textContent = action === "mark-to-here" \? "已标记到这里" : "已更新处理进度";/);
assert.match(app, /普通检索关联文字/);
assert.match(app, /data-table-retrieval-source-id/);
assert.match(app, /function saveTableRetrievalVersion\(chunk\)/);
assert.match(app, /sourceChunks=selectedIds\.map/);
assert.match(app, /const sourceSegments=\(chunk\.sourceSegments\?\?\[\]\)\.map/);
assert.match(app, /api\("\/api\/table-retrieval\/versions"/);

console.log("T9.5 selection UI contract tests passed");
