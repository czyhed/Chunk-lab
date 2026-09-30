import { parentContextFor } from "./parent-context.js";
import { normalizeTrustedBbox } from "/bbox-mapping.js?v=t02";
import { linkedTargetsForChunk, scrollReviewTargetIntoView, updateReviewLinkSelection } from "/chunk-review-links.js?v=t08";
import { configurationDigest, configurationUserExpandedAfterModeChange, resolveConfigurationDisclosure, resolveMetricsDisclosure } from "/review-layout.js?v=layout2";
import { describeUnavailableReasons, formatUserFacingError } from "/user-facing-errors.js?v=bugfix1";
import { mergeContextGenerationResult } from "/context-generation-state.js?v=related1";
import { relatedChunkCandidates } from "/related-chunk-candidates.js?v=related1";
import { shouldLoadSelectedFile } from "/batch-refresh.js?v=refresh1";
import { insertTableColumn, insertTableRow, removeSelectedTableColumn, tablePlacements } from "/table-editor-operations.js?v=table-position1";
import {
  addAnnotation,
  annotationIdsInBox,
  applyAnnotationExclusionPolicy,
  ANNOTATION_LABELS,
  annotationLabelForSize,
  changeAnnotationType,
  createAnnotationState,
  deleteAnnotations,
  effectiveAnnotations,
  mergeAnnotations,
  normalizeBox,
  redoAnnotationChange,
  reviseDetectionType,
  splitAnnotations,
  toggleAnnotationExclusion,
  updateAnnotationSelection,
  undoAnnotationChange,
  browserUuid,
} from "/manual-annotations.js?v=t05a-restore1";

let pdfSurfacePromise = null;
function loadPdfSurface() {
  return pdfSurfacePromise ??= import("/pdf-surface.js?v=lazy2");
}
function cancelPdfRenders(root) {
  if (!pdfSurfacePromise) return;
  void pdfSurfacePromise.then(({ cancelPdfRenders: cancel }) => cancel(root));
}
async function getPdfPageCount(url) {
  const { getPdfPageCount: getCount } = await loadPdfSurface();
  return getCount(url);
}
async function renderPdfCanvases(root, url, scale) {
  const { renderPdfCanvases: render } = await loadPdfSurface();
  return render(root, url, scale);
}

const state = {
  files: [], batchId: null, selectedFileId: null, mode: "preview",
  selectedChunkId: null, lockedChunkId: null, lockedBlockId: null, lockedSourceKey: null,
  selectedBlockIds: new Set(), lastSelectedBlockId: null, requestId: 0,
  selectedContextIds: new Set(), contextGeneratingIds: new Set(), contextSummary: "", currentPage: 1, contextRequestId: 0,
  modelProfiles: [], embeddingProfiles: [], databaseProfiles: [], selectedVlmProfileId: "", selectedContextProfileId: "", vlmGeneratingIds: new Set(),
  sourceViewKind: null, zoomMode: "fit", zoom: 1, renderGeneration: 0,
  exportSnapshot: null, agenticRetrievalUiUrl: "",
  demoMode: false, annotationTool: "select", crossPageCollecting: false, chunkTypeFilter: "all",
  sessionId: browserUuid(), userId: "control-center-user",
  watermarkRange: null,
  batchHistory: [], historyPage: 1,
  annotationSaveTimer: null, integrationKind: null,
  spuCategories: [], spuPreview: null, spuPreviewTimer: null, spuPreviewRequestId: 0, spuCreationRequestId: null,
  configDirty: false, configGenerating: false,
  configDisclosureUserExpanded: false, metricsDisclosureUserExpanded: false, generationFailed: false,
  linkSelection: null,
  strategy: "structure", imagePolicy: "summary",
  params: {
    "parent-child": { parent: 1536, size: 384, overlap: 64 },
    structure: { size: 512, overlap: 64 },
    sentence: { size: 512, overlap: 64 },
    token: { size: 512, overlap: 64 },
    semantic: { buffer: 1, threshold: 90, max: 768 },
  },
};
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const fileInput = $("#fileInput");

$("#toggleRail").onclick = () => {
  const collapsed = $(".app-shell").classList.toggle("rail-collapsed");
  $("#toggleRail").setAttribute("aria-expanded", String(!collapsed));
  $("#fileRail").inert = collapsed;
};
const workspaceResizer = $("#workspaceResizer");
function setSourcePaneWidth(clientX) {
  const workspace=$(".workspace"),workspaceRect=workspace.getBoundingClientRect(),railWidth=$("#fileRail").getBoundingClientRect().width,minSource=400,minChunks=440;
  const width=Math.max(minSource,Math.min(clientX-workspaceRect.left-railWidth,workspaceRect.width-railWidth-workspaceResizer.offsetWidth-minChunks));
  workspace.style.setProperty("--source-pane",`${Math.round(width)}px`);workspaceResizer.setAttribute("aria-valuenow",String(Math.round(width)));
}
workspaceResizer.onpointerdown=(event)=>{if(matchMedia("(max-width: 1100px)").matches)return;event.preventDefault();workspaceResizer.setPointerCapture(event.pointerId);$(".workspace").classList.add("is-resizing");workspaceResizer.onpointermove=(move)=>setSourcePaneWidth(move.clientX);workspaceResizer.onpointerup=()=>{workspaceResizer.onpointermove=null;workspaceResizer.onpointerup=null;$(".workspace").classList.remove("is-resizing")}};
workspaceResizer.ondblclick=()=>{$(".workspace").style.removeProperty("--source-pane");workspaceResizer.removeAttribute("aria-valuenow")};
workspaceResizer.onkeydown=(event)=>{if(!["ArrowLeft","ArrowRight"].includes(event.key))return;event.preventDefault();const current=$(".document-stage").getBoundingClientRect();setSourcePaneWidth(current.right+(event.key==="ArrowRight"?24:-24))};
$("#pickFiles").onclick = () => fileInput.click();
fileInput.onchange = (event) => addFiles(event.target.files);
["dragenter", "dragover"].forEach((name) => $("#dropZone").addEventListener(name, (event) => event.preventDefault()));
$("#dropZone").ondrop = (event) => { event.preventDefault(); addFiles(event.dataTransfer.files); };

function addFiles(files) {
  [...files].forEach((file) => {
    state.files.push({ id: browserUuid(), name: file.name, size: file.size, file, status: "queued" });
  });
  fileInput.value = "";
  renderFiles();
}

function loadBatchHistory() {
  try {
    const value = JSON.parse(localStorage.getItem("chunkLabBatchHistory") ?? "[]");
    state.batchHistory = Array.isArray(value) ? value.filter((item) => item && typeof item.batchId === "string" && typeof item.documentId === "string") : [];
  } catch { state.batchHistory = []; }
}

function rememberBatch(batch) {
  const documents = Array.isArray(batch?.documents) ? batch.documents : [];
  const entries = documents.map((document) => ({ id: `${batch.id}:${document.id}`, batchId: batch.id, documentId: document.id, name: document.name, updatedAt: new Date().toISOString() }));
  state.batchHistory = [...entries, ...state.batchHistory.filter((item) => !entries.some((entry) => entry.id === item.id))].slice(0, 50);
  localStorage.setItem("chunkLabBatchHistory", JSON.stringify(state.batchHistory));
}

function renderBatchHistory() {
  const list = $("#historyList"), pager = $("#historyPager");
  if (!list || !pager) return;
  const entries = state.batchHistory.filter((item) => item.batchId !== state.batchId);
  const pageCount = Math.max(1, Math.ceil(entries.length / 5));
  state.historyPage = Math.min(state.historyPage, pageCount);
  const pageEntries = entries.slice((state.historyPage - 1) * 5, state.historyPage * 5);
  list.innerHTML = pageEntries.length ? pageEntries.map((item) => `<button class="history-item" data-history-batch-id="${escapeHtml(item.batchId)}" data-history-document-id="${escapeHtml(item.documentId)}"><span>${escapeHtml(item.name)}</span><small>历史文件</small></button>`).join("") : '<div class="empty">暂无历史处理文件</div>';
  pager.innerHTML = entries.length > 5 ? `<button class="icon-button" id="historyPrev" aria-label="上一页" ${state.historyPage <= 1 ? "disabled" : ""}>←</button><span>${state.historyPage} / ${pageCount}</span><button class="icon-button" id="historyNext" aria-label="下一页" ${state.historyPage >= pageCount ? "disabled" : ""}>→</button>` : "";
  $$('[data-history-batch-id]').forEach((button) => button.onclick = async () => {
    try { applyBatch(await api(`/api/batches/${encodeURIComponent(button.dataset.historyBatchId)}`)); await selectFile(button.dataset.historyDocumentId); }
    catch { state.batchHistory = state.batchHistory.filter((item) => item.batchId !== button.dataset.historyBatchId); localStorage.setItem("chunkLabBatchHistory", JSON.stringify(state.batchHistory)); renderBatchHistory(); }
  });
  $("#historyPrev")?.addEventListener("click", () => { state.historyPage--; renderBatchHistory(); });
  $("#historyNext")?.addEventListener("click", () => { state.historyPage++; renderBatchHistory(); });
}

function diagnosticIssue(file) {
  const categories=file?.diagnostic?.categories??[];
  if(categories.includes("parse_failed"))return file.error||"文档解析失败";
  if(categories.includes("mineru_result_anomaly"))return file.error||"MinerU 结果异常";
  if(categories.includes("bbox_page_anomaly"))return "bbox 或页码定位异常";
  if(categories.includes("visual_conversion_failed"))return "Visual Copy 转换失败";
  return "";
}

function renderFiles() {
  $("#batchCount").textContent = state.files.length;
  $("#parseButton").disabled = !state.files.some((file) => file.file);
  $("#exportButton").disabled = !state.files.some((file) => file.reviewState?.draft);
  $("#manifestButton").disabled = $("#exportButton").disabled;
  $("#fileList").innerHTML = state.files.length ? state.files.map((file) => `
    <div class="file-row ${file.id === state.selectedFileId ? "active" : ""}">
      <button class="file-item" data-file-id="${escapeHtml(file.id)}">
        <span class="file-name">${escapeHtml(file.name)}</span><span class="file-state">${labelFor(file)}</span>
        <span class="file-stats">${file.sourceBlocks?.length ?? file.blockCount ?? 0} BLOCKS · ${file.reviewState?.draft?.chunks.length ?? file.reviewState?.preview?.chunks.length ?? file.chunkCount ?? 0} CHUNKS · ${file.reviewState?.draft?.chunks.reduce((count, chunk) => count + chunk.qualityFlags.length, 0) ?? file.qualityFlagCount ?? 0} FLAGS</span>
        ${diagnosticIssue(file) ? `<span class="file-error">${escapeHtml(diagnosticIssue(file))}</span>` : ""}
      </button>
      <div class="file-actions">
        ${["done","failed"].includes(file.status) && file.sourceAvailable ? `<button class="file-reparse" data-reparse-id="${escapeHtml(file.id)}">${file.status === "failed" ? "重试" : "重新解析"}</button>` : ""}
        ${diagnosticIssue(file) ? `<button class="file-diagnostic" data-diagnostic-id="${escapeHtml(file.id)}">下载诊断包</button><span class="diagnostic-status" aria-live="polite"></span>` : ""}
      </div>
    </div>`).join("") : '<div class="empty">暂无文件</div>';
  $$("[data-file-id]").forEach((button) => button.onclick = () => selectFile(button.dataset.fileId));
  $$("[data-reparse-id]").forEach((button) => button.onclick = () => reparseDocument(button.dataset.reparseId));
  $$('[data-diagnostic-id]').forEach((button) => button.onclick = () => downloadDiagnosticPackage(state.files.find((file)=>file.id===button.dataset.diagnosticId),button));
  renderBatchHistory();
}

function labelFor(file) {
  if (file.parseCacheReused) return "已复用";
  const label = ({ queued: "待解析", uploading: "上传中", pending: "排队", running: "解析中", done: "处理完成", ready: "已就绪", failed: "失败", error: "失败" })[file.status] ?? file.status;
  const visual = file.sourceContract?.visualCopy?.state === "failed" ? " · Visual Copy失败" : "";
  return file.status === "running" && file.progress
    ? `${label} ${file.progress.extractedPages}/${file.progress.totalPages}${visual}`
    : `${label}${visual}`;
}

async function parseFiles() {
  setError("");
  const form = new FormData();
  form.append("config", JSON.stringify({
    modelVersion: $("#modelVersion").value, language: $("#parseLanguage").value,
    isOcr: $("#ocrEnabled").checked, enableTable: $("#tableEnabled").checked,
    enableFormula: $("#formulaEnabled").checked,
  }));
  state.files.filter((file) => file.file).forEach((file) => { form.append("files", file.file, file.name); file.status = "uploading"; });
  renderFiles();
  try {
    const batch = await api("/api/batches", { method: "POST", body: form });
    state.files.forEach((file) => { delete file.file; });
    applyBatch(batch); pollBatch();
  }
  catch (error) {
    state.files.filter((file) => file.status === "uploading").forEach((file) => { file.status = "queued"; });
    renderFiles(); setError(error);
  }
}
$("#parseButton").onclick = parseFiles;
async function pollBatch() {
  if (!state.batchId) return;
  const batch = await api(`/api/batches/${state.batchId}`);
  applyBatch(batch);
  if (batch.documents.some((document) => !["done", "failed"].includes(document.state))) setTimeout(pollBatch, 1800);
}

async function reparseDocument(documentId) {
  const file = state.files.find((item) => item.id === documentId); if (!file) return;
  const impact = file.reviewState?.draft || file.reviewState?.preview
    ? "重新解析会清除旧 Parsed Document、Preview、Draft、Revision 和 Context，继续吗？"
    : "重新解析会替换当前 Parsed Document，继续吗？";
  if (!confirm(impact)) return;
  setError("");
  try {
    file.reviewState = null; delete file.sourceBlocks; file.chunkCount = 0;
    state.selectedChunkId = null; state.selectedContextIds.clear();
    applyBatch(await api(`/api/batches/${state.batchId}/documents/${documentId}/reparse`, { method: "POST" }));
    pollBatch();
  } catch (error) { setError(error); }
}

function applyBatch(batch) {
  invalidateExportSnapshot();
  rememberBatch(batch);
  const previousSelectedFile = state.files.find((file) => file.id === state.selectedFileId);
  const previousSelectedState = previousSelectedFile?.status ?? null;
  state.batchId = batch.id;
  state.demoMode = batch.demo === true || String(batch.id).startsWith("demo-");
  localStorage.setItem("chunkLabRecentBatchId", batch.id);
  state.files = batch.documents.map((document) => Object.assign(
    state.files.find((file) => file.id === document.id) ?? {}, {
    ...document, status: document.state, error: document.error, progress: document.progress, diagnostic: document.diagnostic, databaseJob: document.databaseJob,
  }));
  if (batch.documents.length && batch.documents.every((document) => document.state === "done")) setError("");
  renderFiles();
  const ready = state.files.find((file) => file.status === "done");
  const selectedId = state.selectedFileId && state.files.some((file) => file.id === state.selectedFileId)
    ? state.selectedFileId
    : ready?.id;
  const selectedFile = state.files.find((file) => file.id === selectedId);
  if (selectedFile && shouldLoadSelectedFile({
    previousSelectedFileId: previousSelectedFile?.id ?? null,
    nextSelectedFileId: selectedFile.id,
    previousSelectedState,
    nextSelectedState: selectedFile.status,
  })) void selectFile(selectedFile.id);
}

function queueLeaseRecovery(file) {
  clearTimeout(file.leaseRetryTimer);
  file.leaseRetryTimer = setTimeout(async () => {
    if (currentFile()?.id !== file.id || file.editable !== false) return;
    const path = `/api/batches/${state.batchId}/documents/${file.id}/lease`;
    try {
      const status = await api(path);
      const own = status.holder?.sessionId === state.sessionId && status.holder?.userId === state.userId;
      if (!status.locked || own) {
        const lease = await api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        file.leaseId = lease.leaseId; file.editable = lease.editable === true;
        if (currentFile()?.id === file.id) { setError(""); await selectFile(file.id); }
        return;
      }
    } catch (error) {
      if (error.code !== "DOCUMENT_LEASE_UNAVAILABLE" && currentFile()?.id === file.id) setError(error);
    }
    if (currentFile()?.id === file.id && file.editable === false) queueLeaseRecovery(file);
  }, 2000);
}

async function selectFile(id) {
  const file = state.files.find((item) => item.id === id);
  if (!file) return;
  clearTimeout(file.leaseRetryTimer);
  state.selectedFileId = id; state.selectedChunkId = null; state.linkSelection = null; state.selectedContextIds.clear(); clearSourceLock();
  $("#docTitle").textContent = file.name;
  if (file.status !== "done") {
    $("#sourceStatus").textContent = labelFor(file);
    $("#pageNav").innerHTML = ""; $("#sourceViewTabs").innerHTML = "";
    $("#pageScroll").innerHTML = `<div class="document-empty"><strong>${escapeHtml(labelFor(file))}</strong><span>${escapeHtml(diagnosticIssue(file) || "等待解析结果")}</span></div>`;
    $("#metrics").innerHTML = "";
    $("#chunkList").innerHTML = '<div class="empty">暂无解析结果</div>';
    $("#detailPanel").innerHTML = '<div class="detail-empty">暂无文档详情</div>';
    $("#generatePreview").disabled = true; $("#confirmPreview").disabled = true;
    renderFiles();
    return;
  }
  $("#sourceStatus").textContent = "加载审阅状态…";
  renderFiles();
  try {
    const lease = await api(`/api/batches/${state.batchId}/documents/${id}/lease`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    file.leaseId = lease.leaseId; file.editable = lease.editable === true;
    const data = await api(`/api/batches/${state.batchId}/documents/${id}/review`);
    file.reviewState = data.reviewState; file.reviewRevision = data.reviewRevision ?? 0; file.reviewProgress = data.reviewProgress; file.sourceBlocks = data.sourceBlocks; file.sourceUrl = data.sourceUrl; file.sourceMimeType = data.sourceMimeType;
    file.parsedDocument = data.parsedDocument; file.visualCopyUrl = data.visualCopyUrl; file.sourceContract = data.sourceContract; file.sourceText = data.sourceText; file.previewGate = data.previewGate; file.sourceMapping=data.sourceMapping;
    try { file.spuMaterialExport = await api(`/api/batches/${state.batchId}/documents/${id}/spu-material-export`); } catch { file.spuMaterialExport = null; }
    const savedConfiguration=file.reviewState.preview?.configuration??file.reviewState.draft?.configuration;
    if(savedConfiguration){state.strategy=savedConfiguration.strategy;state.imagePolicy=savedConfiguration.imagePolicy;state.params[state.strategy]=state.strategy==="semantic"?{buffer:savedConfiguration.bufferSize,threshold:savedConfiguration.breakpointPercentile,max:savedConfiguration.semanticMaxChunkSize}:{size:savedConfiguration.chunkSize,overlap:savedConfiguration.chunkOverlap,...(savedConfiguration.strategy==="parent-child"?{parent:savedConfiguration.parentChunkSize??1536}:{})};file.manualPrototype=state.strategy==="manual";$("#strategySelect").value=state.strategy;$("#imagePolicy").value=state.imagePolicy}
    if (state.demoMode && !file.reviewState.draft) { state.strategy = "manual"; $("#strategySelect").value = "manual"; if(file.reviewState.preview&&!file.manualPrototype){file.automaticPreview=structuredClone(file.reviewState.preview);file.reviewState.preview=null;} }
    if (data.annotationState) {
      const restored = createAnnotationState(data.annotationState.annotations ?? [], mineruDetections(file));
      restored.suppressedSourceBlockIds = [...new Set([
        ...restored.suppressedSourceBlockIds,
        ...(data.annotationState.suppressedSourceBlockIds ?? []),
      ])];
      restored.detectionExclusionOverrides = data.annotationState.detectionExclusionOverrides ?? {};
      syncAnnotationState(file, restored);
    }
    ensureAnnotations(file);
    state.sourceViewKind = data.sourceContract?.sourceViewKind ?? (data.sourceMimeType === "text/markdown" ? "markdown_source" : data.sourceMimeType === "text/plain" ? "txt_source" : "parsed_document");
    setReviewMode(file.reviewState.preview
      ? "preview"
      : file.reviewState.draft
        ? "draft"
        : "preview");
    if (!file.reviewState.preview && !file.reviewState.draft) {
      $("#configState").textContent = "待生成";
      $("#configState").classList.remove("dirty");
    }
    $("#sourceStatus").textContent = `${data.sourceBlocks.length} BLOCKS`;
    renderAll();
  } catch (error) {
    if (error?.code === "DOCUMENT_LEASE_UNAVAILABLE") {
      file.editable = false; file.leaseHolder = error.holder; file.leaseTtlSeconds = error.ttlSeconds;
      try {
        const data = await api(`/api/batches/${state.batchId}/documents/${id}/review`);
        file.reviewState = data.reviewState; file.sourceBlocks = data.sourceBlocks; file.sourceUrl = data.sourceUrl; file.sourceMimeType = data.sourceMimeType; file.parsedDocument = data.parsedDocument; file.sourceContract = data.sourceContract; file.sourceText = data.sourceText; file.previewGate = data.previewGate; file.sourceMapping=data.sourceMapping;
        try { file.spuMaterialExport = await api(`/api/batches/${state.batchId}/documents/${id}/spu-material-export`); } catch { file.spuMaterialExport = null; }
        setReviewMode(file.reviewState.preview ? "preview" : file.reviewState.draft ? "draft" : "preview"); renderAll();
        setError({ message: "文档正在由其他会话处理，当前为只读状态", impact: "已保存内容可正常查看。", recovery: "占用结束后会自动恢复编辑，无需刷新。" });
        queueLeaseRecovery(file);
      } catch (readError) { setError(readError); }
    } else {
      file.editable = false;
      try {
        const data = await api(`/api/batches/${state.batchId}/documents/${id}/review`);
        file.reviewState = data.reviewState;
        file.reviewRevision = data.reviewRevision ?? 0;
        file.reviewProgress = data.reviewProgress;
        file.sourceBlocks = data.sourceBlocks;
        file.sourceUrl = data.sourceUrl;
        file.sourceMimeType = data.sourceMimeType;
        file.parsedDocument = data.parsedDocument;
        file.visualCopyUrl = data.visualCopyUrl;
        file.sourceContract = data.sourceContract;
        file.sourceText = data.sourceText;
        file.previewGate = data.previewGate;
        file.sourceMapping = data.sourceMapping;
        try { file.spuMaterialExport = await api(`/api/batches/${state.batchId}/documents/${id}/spu-material-export`); } catch { file.spuMaterialExport = null; }
        ensureAnnotations(file);
        setReviewMode(file.reviewState.preview ? "preview" : file.reviewState.draft ? "draft" : "preview");
        $("#sourceStatus").textContent = `${data.sourceBlocks.length} BLOCKS`;
        renderAll();
        setError({ message: "租约服务暂不可用，当前为只读状态", impact: "可以查看原文和解析 Block，编辑操作暂不可用。", recovery: "恢复 Redis 服务后刷新页面。" });
      } catch (readError) { setError(readError); }
    }
  }
}

function currentFile() { return state.files.find((file) => file.id === state.selectedFileId); }
function profilesFor(capability) { return state.modelProfiles.filter((profile) => profile.capabilities.includes(capability)); }
function profileOptions(capability, selectedId) {
  const profiles=profilesFor(capability);
  return profiles.length
    ? profiles.map((profile)=>`<option value="${escapeHtml(profile.id)}" ${profile.id===selectedId?"selected":""}>${escapeHtml(profile.name)}</option>`).join("")
    : '<option value="">服务未配置</option>';
}
async function loadModelProfiles() {
  try {
    const [result,embeddingResult,databaseResult]=await Promise.all([api("/api/model-profiles"),api("/api/embedding-profiles"),api("/api/database-profiles")]);
    state.modelProfiles=Array.isArray(result.profiles)?result.profiles:[];
    state.embeddingProfiles=Array.isArray(embeddingResult.profiles)?embeddingResult.profiles:[];
    state.databaseProfiles=Array.isArray(databaseResult.profiles)?databaseResult.profiles:[];
    const rememberedVlm=localStorage.getItem("chunkLabVlmProfileId")??"";
    const rememberedContext=localStorage.getItem("chunkLabContextProfileId")??"";
    state.selectedVlmProfileId=profilesFor("vlm").some((profile)=>profile.id===rememberedVlm)?rememberedVlm:(profilesFor("vlm")[0]?.id??"");
    state.selectedContextProfileId=profilesFor("context").some((profile)=>profile.id===rememberedContext)?rememberedContext:(profilesFor("context")[0]?.id??"");
  } catch {
    state.modelProfiles=[];
    state.embeddingProfiles=[];
    state.databaseProfiles=[];
  }
}
function setReviewMode(nextMode) {
  const previousMode = state.mode;
  state.configDisclosureUserExpanded = configurationUserExpandedAfterModeChange({ previousMode, nextMode, userExpanded: state.configDisclosureUserExpanded });
  if (previousMode !== nextMode && nextMode === "draft") state.metricsDisclosureUserExpanded = false;
  state.mode = nextMode;
}
function currentChunks() {
  return currentResult()?.chunks ?? [];
}
function currentResult() { const review=currentFile()?.reviewState;return state.mode==="preview"?review?.preview:review?.draft; }
function currentMetrics() {
  return currentResult()?.metrics;
}

function renderAll() { $("#chunkWorkspace").classList.toggle("manual-annotation-mode",state.strategy==="manual"&&!currentFile()?.manualPrototype);renderFiles(); renderParams(); renderConfigState(); renderMetrics(); renderPages(); renderModes(); renderChunks(); renderSelectionToolbar(); renderContextToolbar(); renderPostActions(); }

const CONFIG_PIN_KEY = "chunkLabConfigurationPinnedOpen";
function configurationPinnedOpen() { return localStorage.getItem(CONFIG_PIN_KEY) === "true"; }
function updateDisclosureControl(id, expanded) {
  const button = $(id); if (!button) return;
  button.setAttribute("aria-expanded", String(expanded));
  button.closest(".config-panel,.metrics-panel")?.classList.toggle("is-collapsed", !expanded);
  const arrow = button.querySelector(".disclosure-arrow"); if (arrow) arrow.textContent = expanded ? "▾" : "▸";
}
function syncDisclosureState() {
  const mode = state.mode;
  const review=currentFile()?.reviewState;
  const configExpanded = resolveConfigurationDisclosure({ mode, pinnedOpen: configurationPinnedOpen(), hasGenerated:Boolean(review?.preview||review?.draft), dirty: state.configDirty, generating:state.configGenerating, generationFailed: state.generationFailed, userExpanded: state.configDisclosureUserExpanded });
  const metricsExpanded = resolveMetricsDisclosure({ mode, userExpanded: state.metricsDisclosureUserExpanded });
  updateDisclosureControl("#configDisclosureToggle", configExpanded);
  updateDisclosureControl("#metricsDisclosureToggle", metricsExpanded);
  const metricsToggle = $("#metricsDisclosureToggle"); if (metricsToggle) metricsToggle.classList.toggle("hidden", mode !== "draft");
}
function bindDisclosureControls() {
  $("#configDisclosureToggle").onclick = () => { state.configDisclosureUserExpanded = $("#configDisclosureToggle").getAttribute("aria-expanded") !== "true"; syncDisclosureState(); };
  $("#metricsDisclosureToggle").onclick = () => { state.metricsDisclosureUserExpanded = $("#metricsDisclosureToggle").getAttribute("aria-expanded") !== "true"; syncDisclosureState(); };
  $("#pinConfigOpen").onchange = (event) => { localStorage.setItem(CONFIG_PIN_KEY, String(event.target.checked)); state.configDisclosureUserExpanded = event.target.checked; syncDisclosureState(); };
  $("#pinConfigOpen").checked = configurationPinnedOpen();
}
bindDisclosureControls();

function renderConfigState() {
  const indicator = $("#configState");
  const preserveStatus = indicator.classList.contains("dirty") || indicator.textContent === "生成中";
  const file=currentFile(),review = file?.reviewState;
  if(!preserveStatus&&file?.manualPrototype&&review?.preview)indicator.textContent=file.manualPreviewPartial?`P.${state.currentPage} 部分 Preview`:`完整 Preview · ${review.preview.chunks.length} Chunks`;
  else if(!preserveStatus)indicator.textContent = review?.preview ? "Preview 已生成" : review?.draft ? "Draft 已确认" : "待生成";
  $("#configDigest").textContent = configurationDigest({ strategy: state.strategy, imagePolicy: state.imagePolicy, parameters: state.params[state.strategy] ?? {}, status: indicator.textContent });
  syncDisclosureState();
}

function renderParams() {
  $("#strategySelect").value = state.strategy;
  const parameters = state.params[state.strategy] ?? {};
  const definitions = state.strategy === "semantic"
    ? [["buffer", "Buffer", parameters.buffer, 1, 5], ["threshold", "断点 %", parameters.threshold, 50, 99], ["max", "最大 Token", parameters.max, 128, 2048]]
    : state.strategy === "parent-child" ? [["parent", "父块 Token", parameters.parent, 256, 8192], ["size", "子块 Token", parameters.size, 32, 2048], ["overlap", "子块重叠 Token", parameters.overlap, 0, 512]]
    : state.strategy === "manual" ? [] : [["size", "最大 Token", parameters.size, 128, 2048], ["overlap", "Overlap", parameters.overlap, 0, 256]];
  $("#params").innerHTML = definitions.map(([key,label,value,min,max]) => `<div class="param"><label>${label}</label><input type="range" data-param="${key}" min="${min}" max="${max}" value="${value}"><output>${value}</output></div>`).join("");
  $$("#params input").forEach((input) => input.oninput = () => { state.params[state.strategy][input.dataset.param] = +input.value; input.nextElementSibling.value = input.value; markConfigDirty(); });
  const hints = {
    "parent-child": "父块保留段落上下文，子块用于向量检索；命中子块时返回父块。父块须大于子块，重叠须小于子块。表格与图片保持完整。",
    structure: "按商品身份、标题和受保护内容组组织边界，适合复杂说明书。",
    sentence: "LlamaIndex SentenceSplitter，优先保留完整句子。",
    token: "LlamaIndex TokenTextSplitter 边界 + 可追踪的项目级 Overlap。",
    semantic: "自定义 Semantic Boundary；超长结果按完整句子预算回退。",
    manual: "使用 MinerU 框作为起点，按页修订标注并生成可跨页的人工 Preview。",
  };
  $("#strategyHint").textContent = hints[state.strategy];
  $("#generatePreview").classList.remove("hidden");
  $("#generatePreview").textContent = state.strategy === "manual" ? "生成整文档 Chunk" : "应用参数并生成预览";
  $("#generatePreview").disabled = !currentFile() || currentFile()?.editable === false;
  $("#generateManualPage").disabled = !currentFile() || currentFile()?.editable === false || state.strategy !== "manual";
}

function markConfigDirty() {
  state.configDirty = state.strategy !== "manual";
  state.generationFailed = false;
  $("#configState").textContent = state.strategy === "manual" ? "等待人工标注" : "参数尚未生成";
  $("#configState").classList.add("dirty");
  $("#confirmPreview").disabled = true;
  renderMetrics();
  renderModes();
  syncDisclosureState();
  const file=currentFile();
  if(state.strategy === "manual") return;
  if(file) api(`/api/batches/${state.batchId}/documents/${file.id}/chunk-configuration`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload())}).then((gate)=>{file.previewGate={...(file.previewGate??{}),...gate}}).catch((error)=>setError(error));
}
$("#strategySelect").onchange = (event) => { const file=currentFile();state.strategy = event.target.value;ensureAnnotations(file);if(file){if(state.strategy==="manual"&&!file.manualPrototype&&file.reviewState?.preview){file.automaticPreview=structuredClone(file.reviewState.preview);file.reviewState.preview=null;}else if(state.strategy!=="manual"&&file.automaticPreview){file.reviewState.preview=structuredClone(file.automaticPreview);file.manualPrototype=false;}}renderParams(); markConfigDirty(); renderAll(); };
$("#imagePolicy").onchange = (event) => { state.imagePolicy = event.target.value; markConfigDirty(); renderAll(); };

function payload() {
  const parameters = state.params[state.strategy] ?? {};
  return {
    strategy: state.strategy, ...(state.strategy === "parent-child" ? {parentChunkSize: parameters.parent} : {}), chunkSize: parameters.size ?? 512, chunkOverlap: parameters.overlap ?? 0,
    bufferSize: parameters.buffer ?? 1, breakpointPercentile: parameters.threshold ?? 90,
    semanticMaxChunkSize: parameters.max ?? 768, imagePolicy: state.imagePolicy,
  };
}

$("#generatePreview").onclick = async () => {
  const file = currentFile(); if (!file) return;
  if (state.strategy === "manual") return generateManualPreview("document");
  file.manualPrototype = false;
  const requestId = ++state.requestId;
  state.configGenerating=true; $("#generatePreview").disabled = true; $("#configState").textContent = "生成中"; $(".chunk-workspace").setAttribute("aria-busy", "true"); syncDisclosureState();
  try {
    const preview = await api(`/api/batches/${state.batchId}/documents/${file.id}/chunks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload()) });
    if (requestId !== state.requestId) return;
    const review = await api(`/api/batches/${state.batchId}/documents/${file.id}/review`);
    file.reviewState = review.reviewState; file.previewGate = review.previewGate; file.sourceBlocks = preview.sourceBlocks;
    state.configDirty = false; state.configGenerating=false; state.generationFailed = false; setReviewMode("preview"); state.selectedChunkId = null; $("#configState").textContent = "Preview 已生成"; $("#configState").classList.remove("dirty"); renderAll();
  } catch (error) { if (requestId === state.requestId) { state.configGenerating=false; state.generationFailed = true; setError(error); syncDisclosureState(); } }
  finally { if (requestId === state.requestId) { $("#generatePreview").disabled = false; $(".chunk-workspace").removeAttribute("aria-busy"); } }
};

function renderMetrics() {
  const metrics = currentMetrics();
  const draftMetrics = state.mode === "preview" ? currentFile()?.reviewState?.draft?.metrics : null;
  const delta = (value, previous, suffix = "") => draftMetrics && value !== previous
    ? `<small class="metric-delta">Δ ${value > previous ? "+" : ""}${Number((value - previous).toFixed(1))}${suffix}</small>`
    : "";
  if(!metrics){$("#metrics").innerHTML="";$("#metricsDigest").textContent="暂无指标";return}
  const file=currentFile(),chunks=currentChunks(),configuration=currentResult()?.configuration??{},metricConfiguration=state.configDirty&&state.strategy!=="manual"?payload():configuration,quality=tokenSizeQuality(chunks,metricConfiguration),manual=configuration.strategy==="manual"||(state.strategy==="manual"&&file?.manualPrototype);
  const tokenDistribution = metrics.tokenDistribution ?? {};
  const distributionLabel = [
    ["0-79", tokenDistribution.under80 ?? 0],
    ["80-255", tokenDistribution["80to255"] ?? 0],
    ["256-511", tokenDistribution["256to511"] ?? 0],
    ["512-1023", tokenDistribution["512to1023"] ?? 0],
    ["1024+", tokenDistribution["1024plus"] ?? 0],
  ].map(([label, count]) => `${label}: ${count}`).join(" · ");
  const items = [
    ["chunks", "分块数", metrics.chunkCount, delta(metrics.chunkCount, draftMetrics?.chunkCount), "当前 Preview 中的 Chunk 总数"],
    ["tokenAverage", "平均 TOKEN", metrics.token.average, delta(metrics.token.average, draftMetrics?.token.average), "每个 Chunk 的平均 Token 数"],
    ["tokenRange", "TOKEN 范围", `${metrics.token.minimum}-${metrics.token.maximum}`, "", "最短与最长 Chunk 的 Token 数", distributionLabel],
    ...(!manual?[["overlap", "重叠比例", `${(metrics.actualOverlapRatio * 100).toFixed(1)}%`, delta(metrics.actualOverlapRatio * 100, (draftMetrics?.actualOverlapRatio ?? 0) * 100, "%"), "自动策略产生的相邻文本重叠比例"],["sizing", "过短 / 超长", `${quality?.undersized??0} / ${quality?.oversized??0}`, "", quality?`建议范围 ${quality.minimum}-${quality.maximum} Token`:"当前策略不评估尺寸"]]:[]),
    ...(file?.sourceMimeType==="application/pdf"&&metrics.crossPageCount>0?[["crossPage", "跨页块", metrics.crossPageCount, delta(metrics.crossPageCount, draftMetrics?.crossPageCount), "来源跨越多个页面的 Chunk 数量"]]:[]),
    ...(metrics.typeCounts.image>0?[["image", "图片块", metrics.typeCounts.image, "", "图片 Chunk 数量"]]:[]),
    ...(metrics.typeCounts.table>0?[["table", "表格块", metrics.typeCounts.table, "", "表格 Chunk 数量"]]:[]),
  ];
  const insight=quality?qualityInsight(quality,chunks.length):"";
  $("#metrics").innerHTML = `${insight?`<div class="metric-insight ${quality.undersized||quality.oversized?"needs-attention":"balanced"}"><strong>切分判断</strong><span>${escapeHtml(insight)}</span><small>${escapeHtml(quality.strategyLabel)} · 建议 ${quality.minimum}-${quality.maximum} Token</small></div>`:""}${items.map(([,label,value,change,description,detail]) => `<div class="metric" title="${escapeHtml(description)}"><span>${label}</span><strong>${escapeHtml(value)}</strong>${detail?`<small class="metric-distribution">${escapeHtml(detail)}</small>`:""}${change}</div>`).join("")}`;
  $("#metricsDigest").textContent = `${metrics.chunkCount} 个 Chunk · 平均 ${metrics.token.average} Token · 过短/超长 ${quality?.undersized??0}/${quality?.oversized??0}`;
}

function tokenSizeQuality(chunks,configuration=currentResult()?.configuration??{}) {
  const strategy=configuration.strategy??state.strategy;if(strategy==="manual")return null;
  const ratios={structure:.25,sentence:.25,token:.5,semantic:.2},parameters=state.params[strategy]??{},maximum=Number(strategy==="semantic"?(configuration.semanticMaxChunkSize??parameters.max):(configuration.chunkSize??parameters.size));
  if(!Number.isFinite(maximum)||maximum<=0)return null;
  const minimum=Math.max(1,Math.round(maximum*(ratios[strategy]??.25))),candidates=chunks.filter((chunk)=>chunk.type==="text"&&!chunk.excluded),undersized=candidates.filter((chunk)=>chunk.tokenCount<minimum).length,oversized=candidates.filter((chunk)=>chunk.tokenCount>maximum).length;
  return {minimum,maximum,undersized,oversized,candidateCount:candidates.length,strategyLabel:({structure:"Structure-Aware",sentence:"SentenceSplitter",token:"TokenTextSplitter",semantic:"Semantic Boundary"})[strategy]??strategy};
}
function qualityInsight(quality,totalCount) {
  const unit=quality.candidateCount===totalCount?"个 Chunk":"个文本 Chunk";
  if(!quality.candidateCount)return "当前结果没有可评估的文本 Chunk";
  if(quality.undersized&&quality.oversized)return `当前结果大小不均：${quality.undersized} ${unit} 过短，${quality.oversized} 个超长`;
  if(quality.undersized)return `当前结果偏碎：${quality.undersized}/${quality.candidateCount} ${unit} 低于建议长度`;
  if(quality.oversized)return `当前结果偏长：${quality.oversized}/${quality.candidateCount} ${unit} 超过目标 Token`;
  return `当前结果尺寸合适：${quality.candidateCount} ${unit} 均在建议范围内`;
}

function renderModes() {
  const review = currentFile()?.reviewState;
  $$(".tab").forEach((tab) => { const active = tab.dataset.mode === state.mode; tab.classList.toggle("active", active); tab.setAttribute("aria-selected", String(active)); tab.tabIndex = active ? 0 : -1; tab.disabled = tab.dataset.mode === "preview" ? !review?.preview : !review?.draft; });
  const previewExpired = state.configDirty || currentFile()?.previewGate?.previewExpired;
  $("#confirmPreview").disabled = !review?.preview || previewExpired || currentFile()?.editable === false;
  $("#confirmPreview").textContent = !review?.preview&&review?.draft ? "Draft 已确认" : previewExpired ? "请先生成新 Preview" : "采用此 Preview";
  $("#discardPreview").classList.toggle("hidden", !review?.preview || !review?.draft);
  $("#discardPreview").disabled = currentFile()?.editable !== true;
}
function spuScopeGate(file){const result=file?.spuMaterialExport??{};if(result.scopeStatus!=="confirmed"||!(result.targetSpuIds??[]).length)return "资料归属确认后才能生成输出";const chunks=file?.reviewState?.draft?.chunks??[];const blockers=chunks.filter((chunk)=>["unassigned","conflicted"].includes(chunk.scope));if(blockers.length)return blockers.some((chunk)=>chunk.scope==="conflicted")?"存在冲突，暂不可导出":"存在未分配 Chunk，暂不可导出";return ""}
function renderPostActions(){const file=currentFile(),ready=state.mode==="draft"&&Boolean(file?.reviewState?.draft),editable=file?.editable===true;$("#spuMaterialButton").classList.toggle("hidden",!ready);$("#markdownButton").classList.toggle("hidden",!ready);$("#embeddingButton").classList.toggle("hidden",!ready);$("#databaseButton").classList.toggle("hidden",!ready);$("#retrievalButton").classList.toggle("hidden",!ready);const gate=spuScopeGate(file);$("#markdownButton").disabled=!ready||!editable;$("#markdownButton").title=gate||(!editable?"当前文档不可编辑":"");for(const id of ["embeddingButton","databaseButton"]){const button=$("#"+id);button.disabled=!ready||!editable;button.title=(!editable?"当前文档不可编辑":"")}const retrieval=$("#retrievalButton");retrieval.disabled=!ready||!state.agenticRetrievalUiUrl;retrieval.title=state.agenticRetrievalUiUrl?"在新标签页打开 AgenticRetrival":"未配置 AGENTIC_RETRIEVAL_UI_URL";$("#chunkSearchButton").disabled=!ready||!file?.databaseJob;$("#quickIngestButton").disabled=!file||file.status!=="done"||!editable}
function embeddingJobMarkup(job){if(!job)return "";return job.items.map((item)=>`<div class="integration-job-item ${escapeHtml(item.status)}"><span>${escapeHtml(item.chunkId)}</span><strong>${escapeHtml(({succeeded:"成功",failed:"失败",skipped:"跳过"})[item.status]??item.status)}</strong><small>${item.reason?escapeHtml(item.reason):`${item.vectorRecord?.dimensions??0} 维 · 尝试 ${item.attempts}`}</small></div>`).join("")}
function renderEmbeddingJob(job,reused=false){const file=currentFile();if(!file)return;file.embeddingJob=job;file.embeddingModelId=job.profileId;const stale=job.stale===true;const staleNote=stale?` · 已失效${job.staleReasons?.length?`：${job.staleReasons.join("；")}`:""}`:"";$("#integrationStatus").textContent=`${reused?"幂等复用 · ":""}${stale?"Embedding 已失效":job.status==="completed"?"Embedding 成功，待入库":job.status==="partial_failure"?"Embedding 部分失败":"Embedding 失败"}${staleNote} · 成功 ${job.summary.succeeded} · 失败 ${job.summary.failed} · 跳过 ${job.summary.skipped}`;$("#integrationItems").innerHTML=embeddingJobMarkup(job);$("#saveIntegration").textContent=job.summary.failed||stale?"重新向量化": "完成"}
function databaseJobMarkup(job){if(!job)return "";return job.items.map((item)=>`<div class="integration-job-item ${escapeHtml(item.status)}"><span>${escapeHtml(item.chunkId)}</span><strong>${escapeHtml(({written:"已写入",unchanged:"未变化",deleted:"已删除",failed:"失败",skipped:"跳过"})[item.status]??item.status)}</strong><small>${item.reason?escapeHtml(item.reason):`尝试 ${item.attempts}`}</small></div>`).join("")}
function renderDatabaseJob(job,reused=false){const file=currentFile();if(!file)return;file.databaseJob=job;file.databaseProfileId=job.profileId;$("#integrationStatus").textContent=`${reused?"幂等复用 · ":""}${job.status==="completed"?"入库成功，处理完成":job.status==="partial_failure"?"入库部分失败":"入库失败"} · 写入 ${job.summary.written} · 未变化 ${job.summary.unchanged} · 删除 ${job.summary.deleted} · 失败 ${job.summary.failed} · 跳过 ${job.summary.skipped}`;$("#integrationItems").innerHTML=databaseJobMarkup(job);$("#saveIntegration").textContent=job.summary.failed?"重试失败项":"完成"}
function spuStatusLabel(status){return ({not_started:"尚未生成 Markdown",pending:"待生成",complete:"已生成",complete_with_exclusions:"已生成，含排除项",blocked:"已阻断",stale:"需重新生成",failed:"失败"})[status]??status??"尚未生成 Markdown"}
function currentSpuIds(file){if(!file)return[];if(Array.isArray(file.pendingSpuIds))return file.pendingSpuIds;file.pendingSpuIds=[...(file.spuMaterialExport?.pendingSpuIds??file.spuMaterialExport?.targetSpuIds??(file.spuId?[file.spuId]:[]))];return file.pendingSpuIds}
function rememberSpu(file,spu){if(!file||!spu?.spuId)return;file.spuRecordsById={...(file.spuRecordsById??{}),[spu.spuId]:spu}}
function selectedSpuRecord(file,spuId){return file?.spuRecordsById?.[spuId]??{spuId,productName:"未登记商品",brand:"",modelSeries:""}}
function shortSourceHash(value){let hash=0x811c9dc5;for(let index=0;index<value.length;index+=1){hash^=value.charCodeAt(index);hash=Math.imul(hash,0x01000193)}return(hash>>>0).toString(16).padStart(8,"0")}
function safeSourceBaseName(name){const original=String(name??"").replace(/\.[^.]+$/,"");const base=original.normalize("NFKD").replace(/[^\x00-\x7F]+/g,"-").replace(/[^A-Za-z0-9._-]+/g,"-").replace(/[-_.]{2,}/g,"-").replace(/^[-_.]+|[-_.]+$/g,"").slice(0,70)||"source";return /[^\x00-\x7F]/.test(original)?`${base}-${shortSourceHash(original)}`:base}
function previewFileName(file,spuId){const result=file?.spuMaterialExport??{},type=$("#spuDocumentType")?.value??result.documentType??"manual",child=(result.children??[]).find((item)=>item.spuId===spuId&&item.documentType===type&&item.status!=="stale"&&item.fileName);if(child?.fileName)return child.fileName;const preview=result.documentType===type?(result.filenamePreviews??[]).find((item)=>item.spuId===spuId):null;if(preview?.fileName)return preview.fileName;const version=result.nextExportVersion??"v1";return `${spuId}_${type}_${safeSourceBaseName(file?.name)}_${version}.md`}
async function persistPendingSpuSelection(file){if(!file||!state.batchId)return;await api(`/api/batches/${state.batchId}/documents/${file.id}/spu-material-selection`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({targetSpuIds:currentSpuIds(file)})})}
function renderSelectedSpus(file){const ids=currentSpuIds(file),list=$("#spuSelectedList");if(!list)return;const documentType=$("#spuDocumentType")?.value??file?.spuMaterialExport?.documentType??"manual";list.innerHTML=ids.length?ids.map((spuId)=>{const spu=selectedSpuRecord(file,spuId),meta=[spu.brand,spu.modelSeries].filter(Boolean).join(" · ")||"已登记 SPU";return `<div class="spu-selected-item"><span><strong>${escapeHtml(spu.productName)}</strong> · ${escapeHtml(spuId)}</span><button class="icon-button" type="button" data-remove-spu="${escapeHtml(spuId)}" aria-label="移除 ${escapeHtml(spuId)}">×</button><small>${escapeHtml(meta)} · ${escapeHtml(documentType)} · ${escapeHtml(previewFileName(file,spuId))}</small></div>`}).join(""):'<div class="empty">尚未选择 SPU</div>';$$('[data-remove-spu]').forEach((button)=>button.onclick=async()=>{file.pendingSpuIds=currentSpuIds(file).filter((id)=>id!==button.dataset.removeSpu);renderSpuScopeFields(file);try{await persistPendingSpuSelection(file)}catch(error){setError(error)}})}
function renderSpuScopeFields(file){const result=file?.spuMaterialExport??{},ids=currentSpuIds(file),confirmedIds=result.targetSpuIds??[],typeSelect=$("#spuDocumentType");if(typeSelect.dataset.documentId!==file?.id){typeSelect.value=result.documentType??file?.spuDocumentType??"manual";typeSelect.dataset.documentId=file?.id??""}renderSelectedSpus(file);const unchanged=result.scopeStatus==="confirmed"&&ids.length===confirmedIds.length&&ids.every((id)=>confirmedIds.includes(id))&&typeSelect.value===(result.documentType??typeSelect.value);const chunks=file?.reviewState?.draft?.chunks??[],hasException=chunks.some((chunk)=>chunk.scope&&chunk.scope!=="assigned"),hasConflict=chunks.some((chunk)=>chunk.scope==="conflicted"),confirmButton=$("#confirmSpuScope");$("#spuScopeState").textContent=hasConflict?"存在冲突":hasException?"已设置 Chunk 例外":unchanged?`已确认资料归属 · ${ids.length} 个 SPU`:"未确认资料归属";$("#spuScopeState").className=`scope-state ${unchanged&&!hasConflict?"confirmed":""}`;$("#spuScopeHint").textContent=unchanged?"普通 Chunk 将继承文档 SPU；可继续设置少量例外。":"选择并确认文档资料归属后才能生成输出。";confirmButton.disabled=!file?.editable||!ids.length||unchanged;confirmButton.textContent=unchanged?"已确认":"确认资料归属"}
function exportChildMarkup(file,child){const query=`?spuId=${encodeURIComponent(child.spuId)}`,links=child.markdownKey?`<a href="/api/batches/${encodeURIComponent(state.batchId)}/documents/${encodeURIComponent(file.id)}/spu-material-export/markdown${query}" target="_blank" rel="noreferrer">Markdown</a> · <a href="/api/batches/${encodeURIComponent(state.batchId)}/documents/${encodeURIComponent(file.id)}/spu-material-export/manifest${query}" target="_blank" rel="noreferrer">Manifest</a>`:"无可下载产物";const extra=child.status==="blocked"?` · ${escapeHtml(child.reason??"请检查 Chunk 归属")}`:child.status==="stale"?` · ${escapeHtml((child.staleReasons??[]).join("；")||"来源或审阅版本已变化")}`:"";return `<div class="integration-job-item ${escapeHtml(child.status==="blocked"?"failed":child.status==="stale"?"skipped":"succeeded")}"><span>${escapeHtml(child.spuId)}</span><strong>${escapeHtml(spuStatusLabel(child.status))}</strong><small>${escapeHtml(child.fileName??child.documentType??"")} · ${escapeHtml(child.exportVersion??"-")}${extra} · ${links}</small></div>`}
function renderSpuMaterialExport(result){const file=currentFile();if(!file||!result)return;file.spuMaterialExport=result;file.spuId=result.spuId??file.spuId;file.spuDocumentType=result.documentType??file.spuDocumentType;const children=result.children??[];$("#integrationStatus").textContent=`${result.reused?"幂等复用 · ":""}${spuStatusLabel(result.status)}${result.staleReasons?.length?` · ${result.staleReasons.join("；")}`:""}`;$("#integrationItems").innerHTML=children.length?children.map((child)=>exportChildMarkup(file,child)).join(""):'<div class="empty">确认范围后可生成每个 SPU 的 Markdown</div>';if(state.integrationKind==="spu-material"){renderSpuScopeFields(file);$("#saveIntegration").textContent=result.status==="blocked"||result.status==="stale"?"重新生成 Markdown":"生成 Markdown"}}
async function refreshSpuMaterialStatus(file){const result=await api(`/api/batches/${state.batchId}/documents/${file.id}/spu-material-export`);file.spuMaterialExport=result;file.spuId=result.spuId??file.spuId;file.spuDocumentType=result.documentType??file.spuDocumentType;return result}
function renderSpuCategoryOptions(selected=$("#spuCategorySelect").value){const select=$("#spuCategorySelect"),query=$("#spuCategorySearch").value.trim().toLocaleLowerCase(),categories=state.spuCategories.filter((category)=>category.id===selected||!query||`${category.name} ${category.code}`.toLocaleLowerCase().includes(query));select.innerHTML='<option value="">请选择大类</option>'+categories.map((category)=>`<option value="${escapeHtml(category.id)}">${escapeHtml(category.name)} · ${escapeHtml(category.code)}</option>`).join("");if(categories.some((category)=>category.id===selected))select.value=selected}
function syncSpuCategorySelects(){const source=$("#spuCategorySelect"),target=$("#spuExistingCategory");if(source&&target){target.innerHTML=source.innerHTML;target.value=source.value}}
async function loadSpuCatalogUi(file){try{const result=await api("/api/spu-categories");state.spuCategories=result.categories??[];renderSpuCategoryOptions();syncSpuCategorySelects();await Promise.all(currentSpuIds(file).map(async(spuId)=>{if(file.spuRecordsById?.[spuId])return;const found=await api(`/api/spus?query=${encodeURIComponent(spuId)}&limit=1`);if(found.spus?.[0]?.spuId===spuId)rememberSpu(file,found.spus[0])}));renderSpuScopeFields(file)}catch(error){setError(error)}}
function openIntegrationDialog(kind){const file=currentFile();if(!file)return;state.integrationKind=kind;const spuMaterial=kind==="spu-material",embedding=kind==="embedding";$("#integrationTitle").textContent=spuMaterial?"SPU 商品资料":embedding?"选择 Embedding 模型":"选择目标数据库";$("#integrationLabel").classList.toggle("hidden",spuMaterial);$("#integrationLabel").firstChild.textContent=embedding?"Embedding 模型":"目标数据库";$("#spuMaterialFields").classList.toggle("hidden",!spuMaterial);$("#integrationSelect").classList.toggle("hidden",spuMaterial);$("#integrationItems").innerHTML="";if(spuMaterial){renderSpuMaterialExport(file.spuMaterialExport??{targetSpuIds:[],scopeStatus:"unassigned",status:"not_started",children:[],nextExportVersion:"v1"});$("#saveIntegration").disabled=!file.editable;$("#saveIntegration").textContent="生成 Markdown";$("#integrationDialog").showModal();loadSpuCatalogUi(file);return}const values=embedding?state.embeddingProfiles.map((profile)=>[profile.id,`${profile.name} · ${profile.dimensions} 维 · ${profile.maxTokens} Token`]):state.databaseProfiles.map((profile)=>[profile.id,`${profile.name} · ${profile.kind} · schema ${profile.schemaVersion}`]);const selected=embedding?(file.embeddingJob?.profileId??file.embeddingModelId):(file.databaseJob?.profileId??file.databaseProfileId);$("#integrationSelect").innerHTML=values.length?values.map(([value,label])=>`<option value="${escapeHtml(value)}" ${value===selected?"selected":""}>${escapeHtml(label)}</option>`).join(""):'<option value="">服务未配置</option>';$("#integrationStatus").textContent=embedding?(file.embeddingJob?(file.embeddingJob.status==="completed"?"Embedding 成功，待入库":"已恢复最近一次任务"):"选择模型后启动向量化"):(file.databaseJob?(file.databaseJob.status==="completed"?"入库成功，处理完成":"已恢复最近一次写入任务"):"选择数据库后提交向量记录");$("#integrationItems").innerHTML=embedding?embeddingJobMarkup(file.embeddingJob):databaseJobMarkup(file.databaseJob);$("#saveIntegration").disabled=!values.length;$("#saveIntegration").textContent=embedding?(file.embeddingJob?.summary.failed?"重试失败项":file.embeddingJob?"完成":"开始向量化"):(file.databaseJob?.summary.failed?"重试失败项":file.databaseJob?"完成":"提交向量记录");$("#integrationDialog").showModal()}
function spuDraftPayload(){return{productName:$("#spuProductName").value.trim(),categoryId:$("#spuCategorySelect").value,brand:$("#spuBrand").value.trim(),modelSeries:$("#spuModelSeries").value.trim()}}
async function addSelectedSpu(spu){const file=currentFile();if(!file||!spu?.spuId)return;rememberSpu(file,spu);file.pendingSpuIds=[...new Set([...currentSpuIds(file),spu.spuId])];renderSpuScopeFields(file);try{await persistPendingSpuSelection(file)}catch(error){setError(error)}}
function renderSpuPreview(){const box=$("#spuCandidateState"),matches=$("#spuMatches"),preview=state.spuPreview;if(!preview){box.textContent="填写商品名称和大类后生成候选 SPU ID。";matches.replaceChildren();return}const hasMatches=Boolean(preview.matches?.length);box.innerHTML=`<strong>${escapeHtml(preview.candidateSpuId)}</strong><span>${hasMatches?"发现疑似已有 SPU，请先核对；也可以明确创建新 SPU。":"未发现疑似重复，可以创建并使用。"}</span><button class="ghost-button" id="createSpuCandidate" type="button">${hasMatches?"仍然创建新 SPU":"创建并使用"}</button>`;matches.innerHTML=(preview.matches??[]).map((spu)=>`<div class="spu-match"><span><strong>${escapeHtml(spu.productName)}</strong> · ${escapeHtml(spu.spuId)}</span><button class="ghost-button" type="button" data-use-spu="${escapeHtml(spu.spuId)}">使用此 SPU</button><small>${escapeHtml([spu.brand,spu.modelSeries].filter(Boolean).join(" · ")||"无品牌/型号信息")}</small></div>`).join("");$("#createSpuCandidate").onclick=async()=>{const draft=spuDraftPayload();state.spuCreationRequestId??=browserUuid();try{$("#createSpuCandidate").disabled=true;const result=await api("/api/spus",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...draft,candidateSpuId:preview.candidateSpuId,creationRequestId:state.spuCreationRequestId})});await addSelectedSpu(result.spu);$("#spuCandidateState").innerHTML=`<strong>${escapeHtml(result.spu.spuId)}</strong><span>${result.reused?"已复用本次创建结果。":"已创建并加入当前资料。"}</span>`;state.spuCreationRequestId=null}catch(error){setError(error);$("#createSpuCandidate").disabled=false}};$$('[data-use-spu]').forEach((button)=>button.onclick=async()=>{const spu=preview.matches.find((item)=>item.spuId===button.dataset.useSpu);if(spu)await addSelectedSpu(spu)})}
async function refreshSpuPreview(requestId){const draft=spuDraftPayload();if(!draft.productName||!draft.categoryId){if(requestId===state.spuPreviewRequestId){state.spuPreview=null;renderSpuPreview()}return}$("#spuCandidateState").textContent="正在生成候选 SPU ID 并检查重复商品…";try{const preview=await api("/api/spus/preview",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(draft)});if(requestId!==state.spuPreviewRequestId)return;state.spuPreview=preview;renderSpuPreview()}catch(error){if(requestId!==state.spuPreviewRequestId)return;state.spuPreview=null;$("#spuCandidateState").textContent="候选 SPU 生成失败";$("#spuMatches").replaceChildren();setError(error)}}
function queueSpuPreview(){state.spuCreationRequestId=null;clearTimeout(state.spuPreviewTimer);const requestId=++state.spuPreviewRequestId;state.spuPreviewTimer=setTimeout(()=>refreshSpuPreview(requestId),250)}
for(const selector of ["#spuProductName","#spuBrand","#spuModelSeries"])$(selector).addEventListener("input",queueSpuPreview);
$("#spuCategorySearch").oninput=()=>renderSpuCategoryOptions();
$("#spuCategorySelect").onchange=queueSpuPreview;
$("#spuDocumentType").onchange=()=>{const file=currentFile();if(file)renderSpuScopeFields(file)};
$("#toggleSpuCategory").onclick=()=>$("#spuNewCategoryFields").classList.toggle("hidden");
let categoryCodeTimer=null;$("#spuCategoryName").oninput=()=>{clearTimeout(categoryCodeTimer);const name=$("#spuCategoryName").value.trim();if(!name){$("#spuCategoryCode").value="";return}categoryCodeTimer=setTimeout(async()=>{try{const result=await api("/api/spu-categories/preview",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name})});if($("#spuCategoryName").value.trim()===name)$("#spuCategoryCode").value=result.suggestedCode}catch(error){setError(error)}},200)};
$("#spuCategoryCode").oninput=()=>{$("#spuCategoryCode").value=$("#spuCategoryCode").value.toUpperCase().replace(/[^A-Z]/g,"").slice(0,8)};
$("#saveSpuCategory").onclick=async()=>{const name=$("#spuCategoryName").value.trim(),code=$("#spuCategoryCode").value.trim();if(!name||!code)return setError("请填写类目名称并确认英文编码");try{$("#saveSpuCategory").disabled=true;const result=await api("/api/spu-categories",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,code})});$("#spuCategorySearch").value="";await loadSpuCatalogUi(currentFile());$("#spuCategorySelect").value=result.category.id;$("#spuNewCategoryFields").classList.add("hidden");queueSpuPreview()}catch(error){setError(error)}finally{$("#saveSpuCategory").disabled=false}};
for(const button of [$("#spuMaterialButton"),$("#embeddingButton"),$("#databaseButton")])button.addEventListener("click",()=>setError(""),true);
$("#spuMaterialButton").onclick=()=>openIntegrationDialog("spu-material");
$("#spuMaterialButton").addEventListener("click",()=>{setTimeout(()=>{state.integrationKind="spu-assignment";const title=$("#integrationTitle");if(title)title.textContent="分配资料归属";const output=$("#spuOutputConfig");if(output)output.classList.add("hidden");syncSpuCategorySelects();$("#integrationItems").innerHTML="";$("#integrationStatus").textContent="资料归属确认后才能生成输出";$("#saveIntegration").textContent="关闭";$("#integrationDialog").classList.add("assignment-dialog")},0)},true);
$("#markdownButton").onclick=async()=>{const file=currentFile(),gate=spuScopeGate(file),button=$("#markdownButton");if(gate)return setError(gate);try{button.disabled=true;button.textContent="Markdown 生成中...";const ids=file.spuMaterialExport?.targetSpuIds??[],result=await api(`/api/batches/${state.batchId}/documents/${file.id}/spu-material-export`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({spuId:ids[0],targetSpuIds:ids,documentType:file.spuMaterialExport?.documentType??file.spuDocumentType,expectedRevision:file.reviewRevision})});file.spuMaterialExport=await refreshSpuMaterialStatus(file);renderAll();$("#saveState").textContent=result.reused?"Markdown 已是最新版本":file.spuMaterialExport.status==="complete_with_exclusions"?"Markdown 已生成，含排除项":"Markdown 已生成";button.textContent=result.reused?"已是最新 Markdown":"重新生成 Markdown"}catch(error){setError(error);$("#saveState").textContent="Markdown 生成失败";button.textContent="重试生成 Markdown"}finally{renderPostActions()}};
$("#embeddingButton").onclick=()=>openIntegrationDialog("embedding");$("#databaseButton").onclick=()=>openIntegrationDialog("database");
$("#saveIntegration").addEventListener("click",()=>setError(""),true);
$("#saveIntegration").addEventListener("click",(event)=>{if(state.integrationKind!=="spu-assignment")return;event.preventDefault();event.stopImmediatePropagation();$("#integrationDialog").close();$("#integrationDialog").classList.remove("assignment-dialog")},true);
$("#saveIntegration").addEventListener("click",(event)=>{const file=currentFile();if(!file||!['embedding','database'].includes(state.integrationKind))return;const existing=state.integrationKind==="embedding"?file.embeddingJob:file.databaseJob;if(existing&&!existing.summary.failed){event.preventDefault();event.stopImmediatePropagation();$("#integrationDialog").close()}},true);
$("#confirmSpuScope").onclick=async()=>{const file=currentFile();if(!file)return;const targetSpuIds=currentSpuIds(file);if(!targetSpuIds.length)return setError("请至少选择一个目标 SPU");try{$("#confirmSpuScope").disabled=true;$("#integrationStatus").textContent="正在确认资料归属";const result=await api(`/api/batches/${state.batchId}/documents/${file.id}/spu-material-scope`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({targetSpuIds,spuId:targetSpuIds[0],documentType:$("#spuDocumentType").value,expectedRevision:file.reviewRevision})});file.spuId=result.spuId;file.spuDocumentType=result.documentType;file.pendingSpuIds=[...targetSpuIds];await refreshSpuMaterialStatus(file);const review=await api(`/api/batches/${state.batchId}/documents/${file.id}/review`);file.reviewState=review.reviewState;file.reviewRevision=review.reviewRevision??file.reviewRevision;renderSpuMaterialExport(file.spuMaterialExport);renderAll();$("#integrationStatus").textContent="资料归属已确认";$("#saveState").textContent="资料归属已确认"}catch(error){setError(error);$("#integrationStatus").textContent="资料归属确认失败"}finally{renderSpuScopeFields(file)}};
$("#retrievalButton").onclick=()=>{if(!state.agenticRetrievalUiUrl)return setError("未配置 AGENTIC_RETRIEVAL_UI_URL");window.open(state.agenticRetrievalUiUrl,"_blank","noopener,noreferrer")};
$("#chunkSearchButton").onclick=openRetrievalDialog;
$("#chunkTypeFilter").onchange=(event)=>{state.chunkTypeFilter=event.target.value;renderChunks()};
document.addEventListener("click",(event)=>{if(event.target.closest?.("#runRetrievalTest"))setError("")},true);
let quickIngestRunning = false;
$("#quickIngestDialog").addEventListener("cancel", event => { if (quickIngestRunning) event.preventDefault(); });
$("#quickIngestButton").onclick = () => {
  const file = currentFile(); if (!file) return;
  $("#quickEmbeddingProfile").innerHTML = state.embeddingProfiles.map(profile => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)} · ${profile.dimensions} 维</option>`).join("");
  $("#quickDatabaseProfile").innerHTML = state.databaseProfiles.map(profile => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`).join("");
  $("#quickIngestStatus").textContent = state.embeddingProfiles.length && state.databaseProfiles.length ? `${file.name} · 使用当前切块策略` : "请先配置 Embedding 模型和目标数据库";
  $("#quickIngestItems").replaceChildren();
  $("#startQuickIngest").disabled = !state.embeddingProfiles.length || !state.databaseProfiles.length;
  $("#startQuickIngest").textContent = "开始入库";
  $("#quickIngestDialog").showModal();
};
$("#startQuickIngest").onclick = async () => {
  const file = currentFile(); if (!file || quickIngestRunning) return;
  const path = `/api/batches/${state.batchId}/documents/${file.id}`;
  const post = (suffix, body) => api(path + suffix, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  quickIngestRunning = true;
  for (const id of ["startQuickIngest", "closeQuickIngest", "quickEmbeddingProfile", "quickDatabaseProfile"]) $("#" + id).disabled = true;
  try {
    setError("");
    if (state.configDirty || (!file.reviewState?.preview && !file.reviewState?.draft)) {
      $("#quickIngestStatus").textContent = "1 / 3 · 正在切分文档";
      if (state.strategy === "manual") {
        await generateManualPreview("document");
        if (!file.reviewState?.preview) throw new Error("请先生成可用的人工切分预览");
      } else {
        await post("/chunks", payload());
        const review = await api(path + "/review");
        file.reviewState = review.reviewState; file.previewGate = review.previewGate;
        state.configDirty = false;
      }
    }
    if (file.reviewState?.preview) {
      let result;
      try { result = await post("/review/confirm", {}); }
      catch (error) {
        if (error.code !== "REPLACEMENT_CONFIRMATION_REQUIRED" || !confirm("采用当前预览会替换之前的修订与 Context，是否继续入库？")) throw error;
        result = await post("/review/confirm", { confirmReplacement: true });
      }
      file.reviewState = result.reviewState;
    }
    $("#configState").classList.remove("dirty");
    $("#configState").textContent = "Draft 已确认";
    if (!file.reviewState?.draft?.chunks.some(chunk => !chunk.excluded && chunk.finalText.trim())) throw new Error("没有可入库的文本内容，请检查解析或切分结果");
    setReviewMode("draft");
    $("#quickIngestStatus").textContent = "2 / 3 · 正在向量化";
    let embedding = await post("/embedding-jobs", { profileId: $("#quickEmbeddingProfile").value });
    if (embedding.reused && embedding.job.summary.failed) embedding = await post(`/embedding-jobs/${embedding.job.id}/retry`, {});
    file.embeddingJob = embedding.job;
    $("#quickIngestItems").innerHTML = embeddingJobMarkup(embedding.job);
    if (embedding.job.summary.failed || !embedding.job.summary.succeeded) throw new Error(`向量化未完成：成功 ${embedding.job.summary.succeeded}，失败 ${embedding.job.summary.failed}，跳过 ${embedding.job.summary.skipped}。可重试失败项。`);
    $("#quickIngestStatus").textContent = "3 / 3 · 正在写入数据库";
    let database = await post("/database-jobs", { profileId: $("#quickDatabaseProfile").value, embeddingJobId: embedding.job.id });
    if (database.reused && database.job.summary.failed) database = await post(`/database-jobs/${database.job.id}/retry`, {});
    file.databaseJob = database.job;
    $("#quickIngestItems").innerHTML = databaseJobMarkup(database.job);
    if (database.job.summary.failed || !(database.job.summary.written + database.job.summary.unchanged)) throw new Error("入库未完成，请查看失败原因并重试");
    $("#quickIngestStatus").textContent = `入库完成 · ${database.job.summary.written + database.job.summary.unchanged} 个子块 / 记录 · 跳过 ${database.job.summary.skipped} 项`;
    $("#saveState").textContent = "入库完成，可进行检索验证";
    $("#startQuickIngest").textContent = "再次检查并入库";
  } catch (error) {
    $("#quickIngestStatus").textContent = error.message;
    $("#startQuickIngest").textContent = "重试入库";
  } finally {
    quickIngestRunning = false;
    for (const id of ["startQuickIngest", "closeQuickIngest", "quickEmbeddingProfile", "quickDatabaseProfile"]) $("#" + id).disabled = false;
    renderAll();
  }
};
function openRetrievalDialog(){const file=currentFile();if(!file)return;$("#retrievalQuery").value="";$("#retrievalRelevantIds").value=state.selectedChunkId??currentFile()?.reviewState?.draft?.chunks.find(chunk=>!chunk.excluded)?.id??"";$("#retrievalK").value="5";$("#retrievalStatus").textContent="需要先完成 Embedding 和数据库入库。";$("#retrievalItems").replaceChildren();$("#retrievalDialog").showModal()}
$("#runRetrievalTest").onclick=async(event)=>{event.preventDefault();const file=currentFile();if(!file)return;const query=$("#retrievalQuery").value.trim(),relevantChunkIds=$("#retrievalRelevantIds").value.split(/\r?\n|,/).map((value)=>value.trim()).filter(Boolean),k=Number($("#retrievalK").value);if(!query||!relevantChunkIds.length)return setError("请填写查询和至少一个相关 Chunk ID");try{$("#runRetrievalTest").disabled=true;$("#retrievalStatus").textContent="检索测试执行中";const result=await api(`/api/batches/${state.batchId}/documents/${file.id}/retrieval-tests`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query,relevantChunkIds,k})});$("#retrievalStatus").textContent=`Recall@${result.k} ${(result.recallAtK*100).toFixed(1)}% · 命中 ${result.hitCount}/${result.relevantCount} · 索引 ${result.indexVersion}`;$("#retrievalMeta").textContent=`模型 ${result.embeddingModel} · 数据库 ${result.databaseProfileId} · 已入库 ${result.dataScope.indexedRecordCount}/${result.dataScope.draftChunkCount} · 测试 ${new Date(result.testedAt).toLocaleString("zh-CN",{hour12:false})}`;$("#retrievalItems").innerHTML=result.results.map((item)=>`<div class="integration-job-item ${item.relevant?"succeeded":"skipped"}"><span>${escapeHtml(item.chunkId)}</span><strong>${item.relevant?"命中":"未命中"}</strong><small>${item.score.toFixed(4)} · ${escapeHtml(item.text)}</small>${item.parentChunk?`<details class="parent-context"><summary>父块 ${escapeHtml(item.parentChunk.id)}</summary><pre>${escapeHtml(item.parentChunk.text)}</pre></details>`:""}</div>`).join("");}catch(error){$("#retrievalStatus").textContent="检索测试失败";setError(error)}finally{$("#runRetrievalTest").disabled=false}};
$("#saveIntegration").onclick=async(event)=>{event.preventDefault();const file=currentFile();if(!file)return;const spuMaterial=state.integrationKind==="spu-material",embedding=state.integrationKind==="embedding";try{$("#saveIntegration").disabled=true;if(spuMaterial){const targetSpuIds=currentSpuIds(file),confirmed=file.spuMaterialExport?.targetSpuIds??[],selectedDocumentType=$("#spuDocumentType").value;if(file.spuMaterialExport?.scopeStatus!=="confirmed"||file.spuMaterialExport?.documentType!==selectedDocumentType||!targetSpuIds.length||targetSpuIds.length!==confirmed.length||targetSpuIds.some((id)=>!confirmed.includes(id)))throw new Error("请先确认资料归属");$("#integrationStatus").textContent="Markdown 导出中";const body={spuId:targetSpuIds[0],targetSpuIds,documentType:selectedDocumentType,expectedRevision:file.reviewRevision};const result=await api(`/api/batches/${state.batchId}/documents/${file.id}/spu-material-export`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const status=await refreshSpuMaterialStatus(file);renderSpuMaterialExport({...status,reused:result.reused});$("#saveState").textContent=status.status==="blocked"?"Markdown 已阻断":"Markdown 已生成";return}$("#integrationStatus").textContent=embedding?"向量化任务执行中":"数据库写入任务执行中";const selected=$("#integrationSelect").value;if(embedding){const retry=file.embeddingJob?.summary.failed&&file.embeddingJob.profileId===selected,result=await api(retry?`/api/batches/${state.batchId}/documents/${file.id}/embedding-jobs/${file.embeddingJob.id}/retry`:`/api/batches/${state.batchId}/documents/${file.id}/embedding-jobs`,{method:"POST",headers:{"Content-Type":"application/json"},body:retry?"{}":JSON.stringify({profileId:selected})});renderEmbeddingJob(result.job,result.reused);$("#saveState").textContent=result.job.summary.failed?"Embedding 部分失败":"Embedding 已完成"}else{const retry=file.databaseJob?.summary.failed&&file.databaseJob.profileId===selected,result=await api(retry?`/api/batches/${state.batchId}/documents/${file.id}/database-jobs/${file.databaseJob.id}/retry`:`/api/batches/${state.batchId}/documents/${file.id}/database-jobs`,{method:"POST",headers:{"Content-Type":"application/json"},body:retry?"{}":JSON.stringify({profileId:selected,embeddingJobId:file.embeddingJob?.id})});renderDatabaseJob(result.job,result.reused);$("#saveState").textContent=result.job.summary.failed?"数据库写入部分失败":"数据库写入完成"}}catch(error){setError(error);$("#integrationStatus").textContent=spuMaterial?"Markdown 导出失败":embedding?"Embedding 任务失败":"数据库写入失败"}finally{$("#saveIntegration").disabled=false}};
$$(".tab").forEach((tab) => tab.onclick = () => { setReviewMode(tab.dataset.mode); state.selectedChunkId = null; renderAll(); });
$(".tabs").onkeydown = (event) => { if (!["ArrowLeft","ArrowRight"].includes(event.key)) return; const enabled = $$(".tab").filter((tab) => !tab.disabled); const index = enabled.findIndex((tab) => tab.dataset.mode === state.mode); const next = enabled[(index + (event.key === "ArrowRight" ? 1 : -1) + enabled.length) % enabled.length]; next?.click(); next?.focus(); };
$("#discardPreview").onclick = async () => { const file = currentFile(); if (!file) return; try { const result=await api(`/api/batches/${state.batchId}/documents/${file.id}/review/preview`,{method:"DELETE"});file.reviewState=result.reviewState;setReviewMode("draft");renderAll(); } catch(error){setError(error)} };
$("#confirmPreview").onclick = async () => {
  const file = currentFile(); if (!file?.reviewState.preview) return;
  let result;
  try {
    result = await api(`/api/batches/${state.batchId}/documents/${file.id}/review/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  } catch (error) {
    if (error.code !== "REPLACEMENT_CONFIRMATION_REQUIRED") throw error;
    const impact = error.impact;
    const message = `替换会清除 ${impact.humanRevisionCount} 条人工修订和 ${impact.contextCount} 个 Context，继续吗？`;
    if (!confirm(message)) return;
    result = await api(`/api/batches/${state.batchId}/documents/${file.id}/review/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmReplacement: true }) });
  }
  file.reviewState = result.reviewState; file.manualPreviewPartial = false; invalidateExportSnapshot(); setReviewMode("draft"); state.selectedChunkId = file.reviewState.draft?.chunks[0]?.id ?? null; state.linkSelection = null; renderAll();
};

function annotationTypeFor(block) {
  const type = block.raw?.type ?? block.contentType ?? block.type;
  if (type === "page_number" || block.role === "page_number") return "page_number";
  if((block.rawBlockId??block.id??"").includes("warning")) return "warning";
  if((block.rawBlockId??block.id??"").includes("caption")) return "caption";
  if (block.role === "heading" || type === "title") return "heading";
  if (block.role === "warning") return "warning";
  if (block.role === "caption") return "caption";
  return ANNOTATION_LABELS[type] ? type : "text";
}
function annotationLocation(block) {
  const location = block.sourceLocation ?? block.sourceSegment ?? {};
  return { page: location.page ?? block.page ?? 1, bbox: location.bbox ?? block.bbox ?? null, evidence: location.bboxEvidence ?? null, sourceViewKind: location.sourceViewKind ?? null };
}
function demoAnnotationLocation(block) {
  const id=block.rawBlockId??block.id??"",fallback=annotationLocation(block);
  if(id==="demo-title")return{page:1,bbox:[80,70,920,140]};
  const intro=/demo-intro-(\d+)/.exec(id);if(intro){const number=Number(intro[1]),page=number<=4?1:2,column=number<=4?[80,470]:[530,920],row=(number-1)%4;return{page,bbox:[column[0],180+row*150,column[1],285+row*150]}}
  if(id==="demo-warning-title")return{page:2,bbox:[80,700,470,745]};
  if(id==="demo-warning-body")return{page:2,bbox:[80,750,470,850]};
  if(id==="demo-image")return{page:2,bbox:[530,700,920,980]};
  if(id==="demo-caption")return{page:2,bbox:[530,990,920,1040]};
  if(id==="demo-table")return{page:2,bbox:[80,1080,920,1320]};
  return fallback;
}
function isRenderableAnnotation(file, item) {
  const bbox=item?.bbox;
  if(!Number.isFinite(item?.page)||!Array.isArray(bbox)||bbox.length!==4||!bbox.every(Number.isFinite))return false;
  return (item.coordinateSpace==="normalized"||item.layer==="manual"||String(item.id).startsWith("manual-"))&&bbox[0]>=0&&bbox[1]>=0&&bbox[2]>bbox[0]&&bbox[3]>bbox[1]&&bbox[2]<=1&&bbox[3]<=1;
}
function ensureAnnotations(file) {
  if (!file) return;
  const baseline=mineruDetections(file);
  if (!file.annotationState) {
    syncAnnotationState(file, createAnnotationState([], baseline));
    file.annotationPageStates = {};
  } else if (!file.annotationState.mineruDetections?.length && baseline.length) {
    syncAnnotationState(file,{...file.annotationState,mineruDetections:structuredClone(baseline)});
  }
}
function syncAnnotationState(file, next) {
  file.annotationState = next;
  file.annotations = next.annotations;
  file.suppressedSourceBlockIds = next.suppressedSourceBlockIds;
  file.annotationUndo = next.undo;
  file.annotationRedo = next.redo;
}
function mineruDetections(file) {
  const source = file?.sourceBlocks?.length ? file.sourceBlocks : parsedBlocks(file);
  return applyAnnotationExclusionPolicy(source.map((block, index) => {
    const location = state.demoMode ? demoAnnotationLocation(block) : annotationLocation(block);
    return {
      id: sourceBlockId(block), sourceBlockIds: [sourceBlockId(block)], page: location.page,
      bbox: Array.isArray(location.bbox) ? [...location.bbox] : null, bboxEvidence: location.evidence, sourceViewKind: location.sourceViewKind,
      sourceDocumentVersion: file.parsedDocument?.sourceDocumentVersion ?? file.sourceContract?.sourceDocumentVersion,
      visualCopyVersion: file.sourceContract?.visualCopy?.visualCopyVersion,
      type: annotationTypeFor(block), text: block.searchText ?? block.text ?? "", readingOrder: Number.isFinite(block.readingOrder) ? block.readingOrder : index,
      layer: "detection",
    };
  }).map((item)=>{
    if(!Array.isArray(item.bbox))return null;
    const sourceBbox=[...item.bbox],geometry=pageGeometry(file,item.page);
    const bbox=state.demoMode
      ? [sourceBbox[0]/geometry.width,sourceBbox[1]/geometry.height,sourceBbox[2]/geometry.width,sourceBbox[3]/geometry.height]
      : normalizeTrustedBbox({sourceDocumentVersion:item.sourceDocumentVersion,visualCopyVersion:item.visualCopyVersion,sourceViewKind:item.sourceViewKind,page:item.page,bbox:sourceBbox,evidence:item.bboxEvidence,pageGeometry:{...geometry,cssWidth:geometry.width,cssHeight:geometry.height,devicePixelRatio:1},current:{sourceDocumentVersion:file.sourceContract?.sourceDocumentVersion,visualCopyVersion:file.sourceContract?.visualCopy?.visualCopyVersion}});
    return bbox?{...item,sourceBbox,bbox,coordinateSpace:"normalized"}:null;
  }).filter((item)=>item&&isRenderableAnnotation(file,item)));
}
function pageGeometry(file, page) {
  if (state.demoMode) return { width: 1000, height: 1414, pageWidth: 1000, pageHeight: 1414, rotation: 0, mediaBox: [0,0,1000,1414], cropBox: [0,0,1000,1414], coordinateOrigin: "top-left" };
  const mapped = file?.sourceMapping?.pages?.find((item) => item.page === page);
  return { width: mapped?.pageWidth ?? 1000, height: mapped?.pageHeight ?? 1414, pageWidth: mapped?.pageWidth ?? 1000, pageHeight: mapped?.pageHeight ?? 1414, rotation: mapped?.orientation ?? 0, mediaBox: mapped?.mediaBox ?? [0,0,mapped?.pageWidth ?? 1000,mapped?.pageHeight ?? 1414], cropBox: mapped?.cropBox ?? [0,0,mapped?.pageWidth ?? 1000,mapped?.pageHeight ?? 1414], coordinateOrigin: mapped?.coordinateOrigin ?? "top-left" };
}
function pushAnnotationHistory(file) {
  file.annotationUndo.push(structuredClone(file.annotations));
  if (file.annotationUndo.length > 40) file.annotationUndo.shift();
  file.annotationRedo = [];
}
function mutateAnnotations(change) {
  const file = currentFile(); if (!file) return;
  ensureAnnotations(file); pushAnnotationHistory(file); change(file.annotations);
  file.annotationState = { annotations:file.annotations, undo:file.annotationUndo, redo:file.annotationRedo };
  queueAnnotationSave(file); renderPages(); renderChunks(); renderSelectionToolbar();
}
function queueAnnotationSave(file) {
  clearTimeout(state.annotationSaveTimer); file.annotationSaveState = "saving";
  $("#annotationSaveState").textContent = "更新中";
  state.annotationSaveTimer = setTimeout(async () => {
    try {
      const result = await api(`/api/batches/${state.batchId}/documents/${file.id}/review/annotations`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          annotations: file.annotationState.annotations,
          suppressedSourceBlockIds: file.annotationState.suppressedSourceBlockIds ?? [],
          detectionExclusionOverrides: file.annotationState.detectionExclusionOverrides ?? {},
        }),
      });
      file.annotationState = { ...file.annotationState, ...result.annotationState };
      file.annotations = file.annotationState.annotations;
      file.annotationSaveState = "saved"; $("#annotationSaveState").textContent = "已更新"; $("#saveState").textContent = "人工标注已更新";
    } catch (error) {
      file.annotationSaveState = "failed"; $("#annotationSaveState").textContent = "保存失败"; setError(error);
    }
  }, 420);
}
function effectiveAnnotationBoxes(file = currentFile()) {
  ensureAnnotations(file);
  return file?.annotationState ? effectiveAnnotations(file.annotationState).filter((item) => isRenderableAnnotation(file, item)) : [];
}
function selectedAnnotations(file = currentFile()) {
  return effectiveAnnotationBoxes(file).filter((item) => state.selectedBlockIds.has(item.id));
}
function annotationBounds(items) {
  return items.reduce(([x0,y0,x1,y1],item)=>[Math.min(x0,item.bbox[0]),Math.min(y0,item.bbox[1]),Math.max(x1,item.bbox[2]),Math.max(y1,item.bbox[3])],[Infinity,Infinity,-Infinity,-Infinity]);
}
function mergedAnnotation(file, items, groupId = null, bbox = annotationBounds(items), type = null) {
  const ordered=[...items].sort((a,b)=>a.readingOrder-b.readingOrder),types=new Set(ordered.map((item)=>item.type));
  return {id:`manual-${browserUuid()}`,sourceBlockIds:[...new Set(ordered.flatMap((item)=>item.sourceBlockIds??[]))],page:ordered[0].page,bbox,type:type??(types.size===1?ordered[0].type:"text"),readingOrder:Math.min(...ordered.map((item)=>item.readingOrder)),logicalGroupId:groupId,excluded:ordered.every((item)=>item.excluded),manual:true};
}
function clearAnnotationSelection() { state.selectedBlockIds.clear(); state.lastSelectedBlockId=null; state.lockedBlockId=null; state.lockedChunkId=null; state.lockedSourceKey=null; state.linkSelection=null; state.crossPageCollecting=false; }
function mergeSelectedAnnotations(crossPage = false) {
  const file=currentFile(),selected = selectedAnnotations(file);
  if (selected.length < 2) return setError("请至少选择两个框");
  const pages = new Set(selected.map((item) => item.page));
  if (crossPage && pages.size < 2) return setError("跨页合并需要选择至少两个页面的框");
  if (!crossPage && pages.size > 1) return setError("同页合并只能选择同一页的框，请使用跨页合并");
  const selectedIds=new Set(selected.map((item)=>item.id)),groupId=crossPage?`manual-group-${browserUuid()}`:null;
  state.crossPageCollecting = false; state.annotationTool = "select";
  mutateAnnotations((annotations) => {
    const firstIndex=Math.min(...selected.map((item)=>annotations.findIndex((candidate)=>candidate.id===item.id))),byPage=new Map();
    selected.forEach((item)=>{const pageItems=byPage.get(item.page)??[];pageItems.push(item);byPage.set(item.page,pageItems)});
    const replacements=[...byPage.values()].map((items)=>mergedAnnotation(file,items,groupId)).sort((a,b)=>a.readingOrder-b.readingOrder);
    const remaining=annotations.filter((item)=>!selectedIds.has(item.id));
    remaining.splice(Math.min(firstIndex,remaining.length),0,...replacements);annotations.splice(0,annotations.length,...remaining);
    state.selectedBlockIds=new Set(replacements.map((item)=>item.id));state.lastSelectedBlockId=replacements.at(-1)?.id??null;state.lockedBlockId=replacements[0]?.id??null;
  });
  $("#saveState").textContent = crossPage ? "跨页内容已合并" : "选中框已合并";
}
function splitAnnotation(annotationId, clientX, clientY, vertical) {
  const file = currentFile(), annotation = file?.annotations?.find((item) => item.id === annotationId); if (!annotation?.bbox) return;
  const page = document.querySelector(`[data-page="${annotation.page}"]`), rect = page?.getBoundingClientRect(); if (!rect) return;
  const geometry = pageGeometry(file, annotation.page), coordinate = vertical ? (clientX - rect.left) / rect.width * geometry.width : (clientY - rect.top) / rect.height * geometry.height;
  const [x0,y0,x1,y1] = annotation.bbox, minimum = vertical ? (x1-x0)*.15 : (y1-y0)*.15;
  if ((vertical && (coordinate <= x0+minimum || coordinate >= x1-minimum)) || (!vertical && (coordinate <= y0+minimum || coordinate >= y1-minimum))) return setError("拆分位置需要远离框边缘");
  mutateAnnotations((annotations) => {
    const index = annotations.findIndex((item) => item.id === annotationId); const base = annotations[index];
    const first = {...base,id:`${base.id}-a`,bbox:vertical?[x0,y0,coordinate,y1]:[x0,y0,x1,coordinate],manual:true};
    const second = {...base,id:`${base.id}-b`,bbox:vertical?[coordinate,y0,x1,y1]:[x0,coordinate,x1,y1],readingOrder:base.readingOrder+.01,manual:true};
    annotations.splice(index,1,first,second); state.selectedBlockIds = new Set([first.id,second.id]);
  });
  state.annotationTool = "select";
}
function metricsForChunks(chunks) {
  const tokens = chunks.map((chunk)=>chunk.tokenCount), bands = {under80:0,"80to255":0,"256to511":0,"512to1023":0,"1024plus":0};
  tokens.forEach((value)=>{if(value<80)bands.under80++;else if(value<256)bands["80to255"]++;else if(value<512)bands["256to511"]++;else if(value<1024)bands["512to1023"]++;else bands["1024plus"]++});
  return {chunkCount:chunks.length,token:{minimum:tokens.length?Math.min(...tokens):0,average:tokens.length?Number((tokens.reduce((a,b)=>a+b,0)/tokens.length).toFixed(1)):0,maximum:tokens.length?Math.max(...tokens):0},tokenDistribution:bands,actualOverlapRatio:0,crossPageCount:chunks.filter((chunk)=>new Set(chunk.sourceSegments.map((item)=>item.page)).size>1).length,oversizedCount:chunks.filter((chunk)=>chunk.tokenCount>1024).length,undersizedCount:chunks.filter((chunk)=>chunk.tokenCount<80).length,typeCounts:{text:chunks.filter((chunk)=>chunk.type==="text").length,image:chunks.filter((chunk)=>chunk.type==="image").length,table:chunks.filter((chunk)=>chunk.type==="table").length},missingProductIdentityCount:0,contextCandidateCount:chunks.filter((chunk)=>chunk.contextCandidateReasons.length).length};
}
async function generateManualPreview(scope) {
  const file = currentFile(); if (!file) return; ensureAnnotations(file);
  const requestId=++state.requestId,selectedAnnotationIds=scope==="page"?[...state.selectedBlockIds]:[],previousChunks=file.reviewState?.draft?.chunks??file.reviewState?.preview?.chunks??file.automaticPreview?.chunks??[];
  const requestBody={scope,page:scope==="page"?state.currentPage:undefined,selectedAnnotationIds,effectiveAnnotations:effectiveAnnotationBoxes(file),suppressedSourceBlockIds:file.annotationState.suppressedSourceBlockIds??[],previousChunks,imagePolicy:state.imagePolicy,sourceDocumentVersion:file.parsedDocument?.sourceDocumentVersion,parsedDocumentVersion:file.parsedDocument?.parsedDocumentVersion};file.lastManualGenerationRequest=structuredClone(requestBody);
  state.configGenerating=true;$("#generatePreview").disabled=true;$("#generateManualPage").disabled=true;$("#configState").textContent="生成中";$(".chunk-workspace").setAttribute("aria-busy","true");setError("");syncDisclosureState();
  try{
    const response=await api(`/api/batches/${state.batchId}/documents/${file.id}/manual-chunks`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(requestBody)});
    if(requestId!==state.requestId)return;
    file.reviewState=response.reviewState;file.manualPrototype=true;file.manualPreviewPartial=scope==="page";file.lastManualGenerationResponse=response.generation;
    const chunks=file.reviewState.preview?.chunks??[];state.configDirty=false;state.configGenerating=false;state.generationFailed=false;setReviewMode("preview");state.selectedChunkId=chunks.find((chunk)=>selectedAnnotationIds.some((id)=>chunk.manualAnnotationIds?.includes(id)))?.id??chunks[0]?.id??null;state.linkSelection=state.selectedChunkId?updateReviewLinkSelection(chunks,null,{kind:"chunk",id:state.selectedChunkId}):null;state.lockedChunkId=state.selectedChunkId;
    $("#configState").textContent=scope==="page"?`P.${state.currentPage} 部分 Preview`:`完整 Preview · ${chunks.length} Chunks`;$("#configState").classList.remove("dirty");
    $("#saveState").textContent=scope==="page"?"当前页 Chunk 已生成":"整文档 Chunk 已生成";renderAll();
  }catch(error){if(requestId===state.requestId){state.configGenerating=false;state.generationFailed=true;$("#configState").textContent="生成失败";focusProblemAnnotations(error);setError(error);syncDisclosureState()}}finally{if(requestId===state.requestId){$("#generatePreview").disabled=false;$("#generateManualPage").disabled=false;$(".chunk-workspace").removeAttribute("aria-busy")}}
}
$("#generateManualPage").onclick=()=>generateManualPreview("page");

function focusProblemAnnotations(error) {
  const problems=error?.details?.problemAnnotations;
  if(!Array.isArray(problems)||!problems.length)return;
  const file=currentFile();ensureAnnotations(file);const boxes=effectiveAnnotationBoxes(file),ids=problems.map((item)=>item.id).filter((id)=>boxes.some((box)=>box.id===id));
  if(!ids.length)return;
  const first=boxes.find((box)=>box.id===ids[0]);state.selectedBlockIds=new Set(ids);state.lastSelectedBlockId=ids.at(-1);state.lockedBlockId=ids[0];state.lockedSourceKey=`${first.layer??"manual"}:${first.id}`;state.lockedChunkId=null;state.currentPage=first.page;
  renderPages();renderChunks();renderSelectionToolbar();applyHighlights();scrollInsideSource(document.querySelector(`[data-block-id="${CSS.escape(first.id)}"]`));
  $("#saveState").textContent=`已定位 P.${first.page} ${ANNOTATION_LABELS[first.type]??first.type}问题框`;
}

function pageNumbers(blocks) { const pages = [...new Set(blocks.map((block) => block.sourceLocation?.page ?? block.page).filter(Boolean))]; return pages.length ? pages.sort((a,b)=>a-b) : [1]; }
function documentLastPage(file=currentFile()) { return Math.max(1, Number(file?._pdfPageCount)||Number(file?.progress?.totalPages)||Number(file?.parsedDocument?.pageDimensions?.length)||(pageNumbers(parsedBlocks(file)).at(-1)??1)); }
function sourceViews(file) {
  const extension = file?.name?.split(".").pop()?.toLowerCase(); const views=[];
  if(["pdf","png","jpg","jpeg"].includes(extension)&&file.sourceUrl)views.push(["original_file","原始文件"]);
  if(["docx","pptx","xlsx"].includes(extension)&&file.visualCopyUrl)views.push(["visual_copy","Visual Copy"]);
  if(extension==="md"&&file.sourceText!=null)views.push(["markdown_source","Markdown 源码"],["markdown_rendered","渲染结果"]);
  if(extension==="txt"&&file.sourceText!=null)views.push(["txt_source","TXT 源码"]);
  if(file.parsedDocument)views.push(["parsed_document","解析结果"]);
  return views;
}
function renderSourceViewTabs(file){const views=sourceViews(file);if(!views.some(([kind])=>kind===state.sourceViewKind))state.sourceViewKind=views[0]?.[0]??"parsed_document";$("#sourceViewTabs").innerHTML=views.map(([kind,label])=>`<button role="tab" aria-selected="${kind===state.sourceViewKind}" class="${kind===state.sourceViewKind?"active":""}" data-source-view="${kind}">${label}</button>`).join("");$$('[data-source-view]').forEach((button)=>button.onclick=()=>{state.sourceViewKind=button.dataset.sourceView;renderPages()});}
function sourcePageAsset(file, page, renderPdf = true) {
  const url=state.sourceViewKind==="visual_copy"?file?.visualCopyUrl:file?.sourceUrl;if(!url)return "";
  if(state.sourceViewKind==="visual_copy"||file.sourceMimeType==="application/pdf")return renderPdf ? `<canvas class="source-page-asset pdf-page-canvas" data-pdf-page="${page}" aria-label="${state.sourceViewKind==="visual_copy"?"Visual Copy":"原始 PDF"} 第 ${page} 页"></canvas>` : `<div class="source-page-asset pdf-page-placeholder" data-pdf-placeholder="${page}" aria-label="第 ${page} 页等待进入视口"></div>`;
  if(file.sourceMimeType?.startsWith("image/")&&page===1)return `<img class="source-page-asset" src="${escapeHtml(url)}" alt="原始图片" />`;
  return "";
}
function parsedBlocks(file){return file?.parsedDocument?.blocks??[];}
function sourceBlockId(block){return block.contentBlockId??block.id;}
function sourceTextView(file){if(state.sourceViewKind==="markdown_rendered")return `<article class="source-code rendered-source">${parsedBlocks(file).map((block)=>`<section class="source-block" data-block-id="${escapeHtml(sourceBlockId(block))}" tabindex="0"><strong>${escapeHtml(block.contentType)}</strong><p>${escapeHtml(block.display?.text??block.searchText??"")}</p></section>`).join("")}</article>`;if(state.sourceViewKind==="markdown_source"||state.sourceViewKind==="txt_source")return `<pre class="source-code">${escapeHtml(file.sourceText??"")}</pre>`;return `<article class="source-code parsed-source">${parsedBlocks(file).map((block)=>`<section class="source-block" data-block-id="${escapeHtml(sourceBlockId(block))}" tabindex="0"><strong>${escapeHtml(block.contentType)} · ${escapeHtml(block.normalizationStatus)}</strong><p>${escapeHtml(block.searchText||"[无可靠文本]")}</p></section>`).join("")}</article>`;}
function renderPages() {
  const file=currentFile();const blocks=parsedBlocks(file);renderSourceViewTabs(file);
  const pagedView = !["markdown_source","markdown_rendered","txt_source","parsed_document"].includes(state.sourceViewKind);
  $("#pageInput").disabled = !pagedView; $("#previousPage").disabled = !pagedView; $("#nextPage").disabled = !pagedView;
  $("#zoomOut").disabled = !pagedView; $("#zoomFit").disabled = !pagedView; $("#zoomActual").disabled = !pagedView; $("#zoomIn").disabled = !pagedView;
  if(!pagedView){cancelPdfRenders($("#pageScroll"));$("#pageNav").innerHTML="";$("#pageScroll").innerHTML=sourceTextView(file);bindSourceBlocks();applyHighlights();updateAnnotationLabelModes();return;}
  const pdfUrl=state.sourceViewKind==="visual_copy"?file?.visualCopyUrl:file?.sourceUrl;
  if (pdfUrl && (state.sourceViewKind==="visual_copy" || file.sourceMimeType==="application/pdf") && !file._pdfPageCount && !file._pdfPageCountPromise) {
    file._pdfPageCountPromise=getPdfPageCount(pdfUrl).then((count)=>{file._pdfPageCount=count;file._pdfPageCountPromise=null;renderPages()}).catch(()=>{file._pdfPageCountPromise=null});
  }
  const pages=pdfUrl&&file?Array.from({length:file._pdfPageCount??pageNumbers(blocks).at(-1)},(_,index)=>index+1):pageNumbers(blocks);
  if (!pages.includes(state.currentPage)) state.currentPage = pages[0];
  $("#pageInput").min=String(pages[0]); $("#pageInput").max=String(pages.at(-1)); $("#pageInput").value=String(state.currentPage);
  const currentIndex = pages.indexOf(state.currentPage);
  const renderedPages = pdfUrl ? pages : pages.length > 5 ? pages.slice(Math.max(0, currentIndex - 1), currentIndex + 2) : pages;
  const pdfWindow = new Set(pages.filter((page)=>Math.abs(page-state.currentPage)<=2));
  const linkedPages = new Set(currentChunks().filter((chunk) => chunk.id === state.lockedChunkId).flatMap((chunk) => chunk.sourceSegments.map((segment) => segment.page)));
  $("#pageNav").innerHTML = pages.map((page) => `<button data-page-target="${page}" class="${page === state.currentPage ? "active" : ""} ${linkedPages.has(page) ? "marked" : ""}">P.${page}</button>`).join("");
  cancelPdfRenders($("#pageScroll"));
  $("#pageScroll").style.setProperty("--source-zoom",String(state.zoom));
  $("#pageScroll").innerHTML=renderedPages.map((page)=>{const geometry=pageGeometry(file,page),rotated=geometry.rotation===90||geometry.rotation===270;return `<article class="document-page real-source-page" id="page-${page}" data-page="${page}" style="aspect-ratio:${rotated?geometry.height:geometry.width}/${rotated?geometry.width:geometry.height}" aria-label="来源第 ${page} 页">${sourcePageAsset(file,page,!pdfUrl||pdfWindow.has(page))}<div class="source-overlay">${sourceOverlays(file,page)}</div><span class="page-number">${page}</span></article>`}).join("")||'<div class="document-empty"><strong>来源画面不可用</strong><span>可切换到解析结果继续审阅。</span></div>';
  if(pdfUrl&&(state.sourceViewKind==="visual_copy"||file.sourceMimeType==="application/pdf"))renderPdfCanvases($("#pageScroll"),pdfUrl,state.zoom).catch((error)=>{$("#sourceStatus").textContent="PDF 页面暂时不可用，解析结果仍可审阅。";setError(error)});
  $$('[data-page-target]').forEach((button) => button.onclick = () => { state.currentPage = Number(button.dataset.pageTarget); renderPages(); scrollInsideSource($(`#page-${button.dataset.pageTarget}`),"start"); renderContextToolbar(); });
  bindSourceBlocks(); bindAnnotationCanvas(); applyHighlights(); updateAnnotationLabelModes();
  updateCurrentPageFromScroll();
}

function updateCurrentPageFromScroll(){
  const container=$("#pageScroll"); if(!container)return;
  const host=container.getBoundingClientRect(), center=host.top+host.height/2;
  let nearest=null, distance=Infinity;
  $$("#pageScroll [data-page]").forEach((page)=>{const rect=page.getBoundingClientRect(), next=Math.abs((rect.top+rect.bottom)/2-center);if(next<distance){distance=next;nearest=page}});
  if(!nearest)return; const page=Number(nearest.dataset.page); if(page===state.currentPage)return;
  state.currentPage=page; $("#pageInput").value=String(page); $$("[data-page-target]").forEach((button)=>button.classList.toggle("active",Number(button.dataset.pageTarget)===page));
  refreshPdfWindow();
}
$("#pageScroll").addEventListener("scroll",()=>requestAnimationFrame(updateCurrentPageFromScroll),{passive:true});

function refreshPdfWindow(){
  const root=$("#pageScroll"),file=currentFile(),pdfUrl=state.sourceViewKind==="visual_copy"?file?.visualCopyUrl:file?.sourceUrl;
  if(!pdfUrl||!(state.sourceViewKind==="visual_copy"||file?.sourceMimeType==="application/pdf"))return;
  const pages=$$("#pageScroll [data-page]"); let changed=false;
  pages.forEach((pageElement)=>{const page=Number(pageElement.dataset.page),active=Math.abs(page-state.currentPage)<=2,canvas=pageElement.querySelector(".pdf-page-canvas"),placeholder=pageElement.querySelector(".pdf-page-placeholder");if(active&&!canvas){placeholder?.remove();pageElement.insertAdjacentHTML("afterbegin",sourcePageAsset(file,page,true));changed=true}else if(!active&&canvas){canvas.remove();pageElement.insertAdjacentHTML("afterbegin",sourcePageAsset(file,page,false));changed=true}});
  if(!changed)return; cancelPdfRenders(root); renderPdfCanvases(root,pdfUrl,state.zoom).catch((error)=>{$("#sourceStatus").textContent="PDF 页面暂时不可用，解析结果仍可审阅。";setError(error)});
}

function logicalGroupLabel(item) { return item.logicalGroupNumber ? `组 ${String(item.logicalGroupNumber).padStart(2,"0")}` : "逻辑组"; }
function logicalGroupPages(item) { return (item.groupPages??[item.page]).map((page)=>`P${page}`).join("/"); }
function annotationBody(item) {
  if(!item.logicalGroupId)return "";
  return `<span class="annotation-group-badge" style="--group-color:${escapeHtml(item.logicalGroupColor??"#5367a5")}">${escapeHtml(logicalGroupLabel(item))} · ${item.groupMemberIndex??1}/${item.groupMemberCount??1}</span>`;
}
function sourceOverlays(file,page){
  ensureAnnotations(file); const geometry=pageGeometry(file,page);
  return effectiveAnnotationBoxes(file).filter((item)=>item.page===page).map((item)=>{
    if(item.layer==="manual"){
      const [x0,y0,x1,y1]=item.bbox,key=`manual:${item.id}`;
      const groupText=item.logicalGroupId?`，${logicalGroupLabel(item)}，成员 ${item.groupMemberIndex??1}/${item.groupMemberCount??1}，页面 ${logicalGroupPages(item)}`:"";
      return `<button class="source-block exact-source-block manual-annotation-block annotation-${escapeHtml(item.type)} ${item.excluded?"annotation-excluded":""}" data-block-id="${escapeHtml(item.id)}" data-source-key="${escapeHtml(key)}" data-source-layer="manual" data-annotation-type="${escapeHtml(item.type)}" data-source-block-ids="${escapeHtml((item.sourceBlockIds??[]).join(","))}" data-region-member-ids="${escapeHtml((item.regionMemberIds??[]).join(","))}" ${item.logicalGroupId?`data-logical-group-id="${escapeHtml(item.logicalGroupId)}" data-logical-group-number="${item.logicalGroupNumber??""}" data-group-member-index="${item.groupMemberIndex??""}" data-group-member-count="${item.groupMemberCount??""}" data-group-pages="${escapeHtml((item.groupPages??[]).join(","))}"`:""} style="left:${x0*100}%;top:${y0*100}%;width:${(x1-x0)*100}%;height:${(y1-y0)*100}%" aria-label="人工框 ${escapeHtml(ANNOTATION_LABELS[item.type]??item.type)}${escapeHtml(groupText)}" title="人工框：${escapeHtml(ANNOTATION_LABELS[item.type]??item.type)}${escapeHtml(groupText)}"><span class="block-label annotation-label" data-label-type="${escapeHtml(item.type)}">${escapeHtml(ANNOTATION_LABELS[item.type]??item.type)}</span>${annotationBody(item)}</button>`;
    }
    const [x0,y0,x1,y1]=item.bbox;
    const key=`detection:${item.id}`;
    return `<button class="source-block exact-source-block detection-block annotation-${escapeHtml(item.type)}" data-block-id="${escapeHtml(item.id)}" data-source-key="${escapeHtml(key)}" data-source-layer="detection" data-annotation-type="${escapeHtml(item.type)}" style="left:${x0*100}%;top:${y0*100}%;width:${(x1-x0)*100}%;height:${(y1-y0)*100}%" aria-label="MinerU 检测 ${escapeHtml(ANNOTATION_LABELS[item.type]??item.type)}" title="MinerU 检测：${escapeHtml(ANNOTATION_LABELS[item.type]??item.type)}"><span class="block-label annotation-label" data-label-type="${escapeHtml(item.type)}">${escapeHtml(ANNOTATION_LABELS[item.type]??item.type)}</span></button>`;
  }).join("");
}

function updateAnnotationLabelModes() {
  $$(".annotation-label").forEach((label) => {
    const box = label.closest(".exact-source-block"), rect = box?.getBoundingClientRect();
    if (!rect) return;
    const info = annotationLabelForSize(label.dataset.labelType, rect.width, rect.height);
    label.dataset.labelMode = info.mode;
    label.textContent = info.label;
    label.title = info.tooltip;
    label.setAttribute("aria-label", info.tooltip);
  });
}

function scrollInsideSource(element,align="center"){scrollReviewTargetIntoView(element,align)}
function goToPage(page){const pages=pageNumbers(parsedBlocks(currentFile()));const next=Math.max(pages[0],Math.min(pages.at(-1),Number(page)||pages[0]));state.currentPage=next;renderPages();scrollInsideSource($(`#page-${next}`),"start");}
$("#pageInput").onchange=(event)=>goToPage(event.target.value);
$("#previousPage").onclick=()=>goToPage(state.currentPage-1);
$("#nextPage").onclick=()=>goToPage(state.currentPage+1);
$("#zoomOut").onclick=()=>{state.zoomMode="custom";state.zoom=Math.max(.5,Number((state.zoom-.1).toFixed(1)));renderPages()};
$("#zoomIn").onclick=()=>{state.zoomMode="custom";state.zoom=Math.min(2.5,Number((state.zoom+.1).toFixed(1)));renderPages()};
$("#zoomFit").onclick=()=>{state.zoomMode="fit";state.zoom=1;renderPages()};
$("#zoomActual").onclick=()=>{state.zoomMode="actual";state.zoom=1.35;renderPages()};

function bindSourceBlocks() {
  $$(".source-block").forEach((element) => {
    element.onpointerdown = (event) => {
      if (state.strategy !== "manual" || state.annotationTool !== "select" || element.dataset.sourceLayer !== "manual") return;
      const file = currentFile(), item = effectiveAnnotationBoxes(file).find((candidate) => candidate.id === element.dataset.blockId), page = element.closest(".document-page"), pageRect = page?.getBoundingClientRect(), rect = element.getBoundingClientRect();
      if (!item || !state.selectedBlockIds.has(item.id) || !pageRect) return;
      const edgeX = event.clientX >= rect.right - 12, edgeY = event.clientY >= rect.bottom - 12, start = { x: event.clientX, y: event.clientY }, original = [...item.bbox]; let moved = false;
      element.setPointerCapture(event.pointerId);
      element.onpointermove = (move) => {
        const dx = (move.clientX - start.x) / pageRect.width, dy = (move.clientY - start.y) / pageRect.height;
        if (Math.abs(dx) < .002 && Math.abs(dy) < .002) return;
        moved = true; let [x0,y0,x1,y1] = original;
        if (edgeX) x1 = Math.max(x0 + .01, Math.min(1, original[2] + dx)); else { x0 = Math.max(0, Math.min(x1 - .01, original[0] + dx)); x1 = Math.min(1, x0 + original[2] - original[0]); }
        if (edgeY) y1 = Math.max(y0 + .01, Math.min(1, original[3] + dy)); else { y0 = Math.max(0, Math.min(y1 - .01, original[1] + dy)); y1 = Math.min(1, y0 + original[3] - original[1]); }
        element.style.left = `${x0 * 100}%`; element.style.top = `${y0 * 100}%`; element.style.width = `${(x1 - x0) * 100}%`; element.style.height = `${(y1 - y0) * 100}%`;
      };
      element.onpointerup = () => { element.onpointermove = null; element.onpointerup = null; if (!moved) return; element.dataset.annotationDragged = "1"; const next = [parseFloat(element.style.left) / 100, parseFloat(element.style.top) / 100, (parseFloat(element.style.left) + parseFloat(element.style.width)) / 100, (parseFloat(element.style.top) + parseFloat(element.style.height)) / 100]; mutateAnnotations((annotations) => { const target = annotations.find((candidate) => candidate.id === item.id); if (target) target.bbox = next; }); };
    };
    element.onmouseenter = () => {highlightSourceKey(element.dataset.sourceKey, "hover");highlightForSourceIds(sourceIdsForElement(element),"hover")};
    element.onmouseleave = () => clearHover();
    element.onclick = (event) => {
      if (element.dataset.annotationDragged) { delete element.dataset.annotationDragged; event.preventDefault(); return; }
      if(!element.dataset.sourceKey){if(state.strategy!=="manual")selectSourceBlock(element.dataset.blockId,event);return}
      selectSourceBlock(element.dataset.blockId, event);
    };
    element.onkeydown = (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); element.click(); } };
  });
}

function bindAnnotationCanvas() {
  if(state.strategy!=="manual")return;
  $$(".source-overlay").forEach((overlay)=>{
    overlay.onclick=(event)=>{if(event.target!==overlay)return;clearAnnotationSelection();renderPages();renderChunks();renderSelectionToolbar();};
    overlay.onpointerdown=(event)=>{
      const current=currentFile();
      if(current?.editable!==true)return;
      const shortcutMarquee=state.annotationTool==="select"&&(event.ctrlKey||event.metaKey);
      if(event.button!==0||event.target!==overlay||(!shortcutMarquee&&!["draw","marquee","watermark"].includes(state.annotationTool)))return;
      event.preventDefault();
      const tool=shortcutMarquee?"marquee":state.annotationTool,appendSelection=event.ctrlKey||event.metaKey;
      const page=overlay.closest(".document-page"),rect=page.getBoundingClientRect();
      const startX=Math.max(0,Math.min(rect.width,event.clientX-rect.left)),startY=Math.max(0,Math.min(rect.height,event.clientY-rect.top));
      const draft=document.createElement("div");draft.className="annotation-draft";draft.style.left=`${startX}px`;draft.style.top=`${startY}px`;overlay.append(draft);overlay.setPointerCapture(event.pointerId);
      overlay.onpointermove=(move)=>{const x=Math.max(0,Math.min(rect.width,move.clientX-rect.left)),y=Math.max(0,Math.min(rect.height,move.clientY-rect.top));draft.style.left=`${Math.min(startX,x)}px`;draft.style.top=`${Math.min(startY,y)}px`;draft.style.width=`${Math.abs(x-startX)}px`;draft.style.height=`${Math.abs(y-startY)}px`};
      overlay.onpointerup=(up)=>{
        overlay.onpointermove=null;overlay.onpointerup=null;draft.remove();
        const endX=Math.max(0,Math.min(rect.width,up.clientX-rect.left)),endY=Math.max(0,Math.min(rect.height,up.clientY-rect.top));
        if(Math.abs(endX-startX)<18||Math.abs(endY-startY)<18)return;
        const file=currentFile(),pageNumber=Number(page.dataset.page),bbox=normalizeBox({x:startX,y:startY},{x:endX,y:endY},rect.width,rect.height);
        let regenerateChunks=false;
        if(tool==="draw"){
          const id=`manual-${browserUuid()}`;
          syncAnnotationState(file,addAnnotation(file.annotationState,{id,page:pageNumber,bbox}));state.selectedBlockIds=new Set([id]);state.lastSelectedBlockId=id;state.lockedBlockId=id;state.lockedSourceKey=`manual:${id}`;queueAnnotationSave(file);
        }else if(tool==="marquee"){
          const boxes=effectiveAnnotationBoxes(file),ids=annotationIdsInBox(boxes,bbox,{pages:[pageNumber],fullyContained:false}),selected=appendSelection?new Set(state.selectedBlockIds):new Set();
          ids.forEach((id)=>selected.add(id));state.selectedBlockIds=selected;state.lastSelectedBlockId=[...selected].at(-1)??null;state.lockedBlockId=state.lastSelectedBlockId;state.lockedChunkId=null;const locked=boxes.find((item)=>item.id===state.lockedBlockId);state.lockedSourceKey=locked?`${locked.layer??"manual"}:${locked.id}`:null;
        }else if(tool==="watermark"){
          const [from,to]=state.watermarkRange??[pageNumber,pageNumber],pages=Array.from({length:to-from+1},(_,index)=>from+index),ids=annotationIdsInBox(effectiveAnnotationBoxes(file),bbox,{pages,fullyContained:true,containmentTolerance:.01});
          regenerateChunks=Boolean(file.reviewState?.preview?.chunks?.length||file.reviewState?.draft?.chunks?.length);
          if(ids.length){syncAnnotationState(file,deleteAnnotations(file.annotationState,ids));queueAnnotationSave(file)}
          clearAnnotationSelection();state.watermarkRange=null;$("#saveState").textContent=`已清理 ${ids.length} 个水印 Block · ${from===to?`P.${from}`:`P.${from}-${to}`}`;
        }
        state.annotationTool="select";renderAll();
        if(regenerateChunks)generateManualPreview("document");
      };
    };
  });
}

function selectSourceBlock(blockId, event) {
  const file=currentFile();ensureAnnotations(file);const blocks = effectiveAnnotationBoxes(file);
  const blockKey=(block)=>block.id;
  let rangeIds;
  if (event.shiftKey && state.lastSelectedBlockId) {
    const start = blocks.findIndex((block) => blockKey(block) === state.lastSelectedBlockId), end = blocks.findIndex((block) => blockKey(block) === blockId);
    if (start >= 0 && end >= 0) rangeIds=blocks.slice(Math.min(start,end),Math.max(start,end)+1).map(blockKey);
  }
  const next=updateAnnotationSelection({selectedIds:[...state.selectedBlockIds],lastSelectedId:state.lastSelectedBlockId,lockedBlockId:state.lockedBlockId},blockId,{toggle:state.crossPageCollecting||event.ctrlKey||event.metaKey,rangeIds});
  state.selectedBlockIds=new Set(next.selectedIds);state.lastSelectedBlockId=next.lastSelectedId;state.lockedBlockId=next.lockedBlockId;state.lockedChunkId=null;
  const locked=blocks.find((block)=>block.id===next.lockedBlockId);
  state.lockedSourceKey=locked?`${locked.layer??"manual"}:${locked.id}`:null;
  if(locked)$("#annotationType").value=locked.type;
  selectLinkedSourceIds(sourceIdsForBlock(blockId),event);renderSelectionToolbar();
}

function renderSelectionToolbar() {
  const file=currentFile();ensureAnnotations(file);const boxes=effectiveAnnotationBoxes(file),detections=boxes.filter((item)=>item.layer==="detection"),manualBoxes=boxes.filter((item)=>item.layer==="manual");
  $("#selectionCount").textContent = state.selectedBlockIds.size
    ? `已选择 ${state.selectedBlockIds.size} 个框`
    : `MinerU ${detections.length} · 人工 ${manualBoxes.length}`;
  const manual=state.strategy==="manual";
  $("#annotationTools").classList.toggle("hidden",!manual);$("#sourceReviewTools").classList.toggle("hidden",manual);
  $("#annotationSaveState").textContent=manual?(file?.annotationSaveState==="saving"?"更新中":file?.annotationSaveState==="saved"?"已更新":"人工层为空"):"来源审阅";
  $$('[data-annotation-tool]').forEach((button)=>{button.classList.toggle('active',button.dataset.annotationTool===state.annotationTool);button.disabled=!file||file.editable!==true});
  $$('.source-overlay').forEach((overlay)=>overlay.classList.toggle('draw-mode',manual&&["draw","marquee","watermark"].includes(state.annotationTool)));
  $$('[data-annotation-action]').forEach((button)=>{const action=button.dataset.annotationAction;button.disabled=!file||file.editable!==true||(["exclude","delete","merge","split"].includes(action)&&!state.selectedBlockIds.size)||(action==="merge"&&state.selectedBlockIds.size<2)||(action==="undo"&&!file.annotationUndo?.length)||(action==="redo"&&!file.annotationRedo?.length)});
  $$('[data-source-action]').forEach((button) => button.disabled = state.mode !== "draft" || !state.selectedBlockIds.size || (button.dataset.sourceAction !== "create" && !state.selectedChunkId));
}

function tableRows(text) {
  return String(text??"").split(/\r?\n/).filter((line)=>line.includes("|")&&!/^\s*\|?[\s|:-]+$/.test(line)).map((line)=>{const cells=line.split("|").map((cell)=>cell.trim());if(!cells[0])cells.shift();if(!cells.at(-1))cells.pop();return cells});
}
function renderChunkPreview(chunk) {
  if(chunk.type==="image")return `<div class="chunk-image-preview"><span>IMG</span><div><strong>${escapeHtml(chunk.imagePolicy==="exclude"?"已排除":chunk.imagePolicy==="reference"?"图片引用":"VLM 摘要 + 引用")}</strong><p>${escapeHtml(chunk.vlmSummaryEffective||chunk.finalText||"等待填写图片摘要")}</p></div></div>`;
  if(chunk.type==="table"){const model=chunk.reviewedModel?.type==="table"?chunk.reviewedModel:tableModelFromChunk(chunk);return renderStructuredTable(model,"chunk-table-preview",4)}
  return `<div class="chunk-preview-text">${escapeHtml(chunk.finalText||"[无文本]")}</div>`;
}
const CHUNK_TYPE_LABELS = Object.freeze({ title: "标题", heading: "标题", paragraph: "文本", text: "文本", list: "列表", table: "表格", image: "图片", formula: "公式", code: "代码", warning: "警告", caption: "图注", footnote: "脚注", plain_text_repair: "文本" });
function chunkTypeValue(chunk) { const value=chunk.finalType ?? chunk.automaticType ?? chunk.reviewedModel?.type ?? (chunk.type === "image" ? "image" : chunk.type === "table" ? "table" : "paragraph"); return value === "title" ? "heading" : value; }
function chunkTypeLabel(chunk) { return CHUNK_TYPE_LABELS[chunkTypeValue(chunk)] ?? (chunk.type === "image" ? "图片" : chunk.type === "table" ? "表格" : "文本"); }
function sourceInfoItem(key) {
  const file=currentFile();ensureAnnotations(file);
  const value=String(key??""),separator=value.indexOf(":"),id=value.slice(separator+1);
  return effectiveAnnotationBoxes(file).find((item)=>item.id===id);
}
function sourceInfoRow(item,layer,index) {
  const key=`${layer}:${item.id}`,type=ANNOTATION_LABELS[item.type]??item.type;
  const groupText=item.logicalGroupId?`${logicalGroupLabel(item)} · ${item.groupMemberIndex??1}/${item.groupMemberCount??1} · ${logicalGroupPages(item)}`:"MANUAL";
  return `<button class="annotation-source-row annotation-${escapeHtml(item.type)} ${item.excluded?"annotation-excluded":""}" data-source-info-key="${escapeHtml(key)}" data-source-layer="${escapeHtml(layer)}" data-source-block-ids="${escapeHtml((item.sourceBlockIds??[]).join(","))}" ${item.logicalGroupId?`data-logical-group-id="${escapeHtml(item.logicalGroupId)}" data-logical-group-number="${item.logicalGroupNumber??""}" data-group-member-index="${item.groupMemberIndex??""}" data-group-member-count="${item.groupMemberCount??""}" data-group-pages="${escapeHtml((item.groupPages??[]).join(","))}" style="--group-color:${escapeHtml(item.logicalGroupColor??"#5367a5")}"`:""} aria-label="${layer==="detection"?"MinerU 框":"人工框"} ${index+1}，${escapeHtml(type)}${item.logicalGroupId?`，${escapeHtml(groupText)}`:""}" title="${layer==="detection"?"MinerU 框":"人工框"}：${escapeHtml(type)}${item.logicalGroupId?` · ${escapeHtml(groupText)}`:""}"><span class="source-swatch"></span><strong>${escapeHtml(type)}</strong><span>P.${item.page}</span><small>${layer==="detection"?"MINERU":`<span class="source-group-identity">${escapeHtml(groupText)}</span>`}${item.excluded?" · 已排除":""}</small></button>`;
}
function manualSourceRows(items) {
  const seen=new Set();
  return items.map((item,index)=>{
    let header="";
    if(item.logicalGroupId&&!seen.has(item.logicalGroupId)){
      seen.add(item.logicalGroupId);
      header=`<button class="annotation-logical-group-header" data-logical-group-select="${escapeHtml(item.logicalGroupId)}" style="--group-color:${escapeHtml(item.logicalGroupColor??"#5367a5")}" title="选择 ${escapeHtml(logicalGroupLabel(item))} 的全部来源框"><strong>${escapeHtml(logicalGroupLabel(item))}</strong><span>${escapeHtml(logicalGroupPages(item))} · ${item.groupMemberCount??1} 个成员</span></button>`;
    }
    return header+sourceInfoRow(item,"manual",index);
  }).join("");
}
function renderAnnotationSources() {
  const file=currentFile();ensureAnnotations(file);const effective=effectiveAnnotationBoxes(file),detections=effective.filter((item)=>item.layer==="detection"),manual=effective.filter((item)=>item.layer==="manual");
  $("#chunkList").innerHTML=`<section class="annotation-source-group"><header><strong>MinerU 检测</strong><span>${detections.length}</span></header>${detections.map((item,index)=>sourceInfoRow(item,"detection",index)).join("")||'<div class="annotation-layer-empty">本页无检测框</div>'}</section><section class="annotation-source-group"><header><strong>人工标注</strong><span>${manual.length}</span></header>${manualSourceRows(manual)||'<div class="annotation-layer-empty">尚无人工标注</div>'}</section>`;
  $$('[data-source-info-key]').forEach((element)=>{
    element.onmouseenter=()=>{highlightSourceKey(element.dataset.sourceInfoKey,"hover");highlightForSourceIds(sourceIdsForElement(element),"hover")};
    element.onmouseleave=clearHover;
    element.onclick=(event)=>selectSourceInfo(element.dataset.sourceInfoKey,event);
  });
  $$('[data-logical-group-select]').forEach((element)=>{element.onclick=()=>{const group=effective.filter((item)=>item.logicalGroupId===element.dataset.logicalGroupSelect);if(!group.length)return;state.selectedBlockIds=new Set(group.map((item)=>item.id));state.lastSelectedBlockId=group.at(-1).id;state.lockedBlockId=group.at(-1).id;state.lockedSourceKey=`manual:${group.at(-1).id}`;state.lockedChunkId=null;state.currentPage=group[0].page;renderPages();renderChunks();renderSelectionToolbar();}});
  const selected=sourceInfoItem(state.lockedSourceKey);
  const manualSelected=selected&&state.lockedSourceKey?.startsWith("manual:");
  const transcriptionAllowed=manualSelected&&selected.type!=="image";
  const transcriptionGuidance=transcriptionAllowed&&!(selected.sourceBlockIds??[]).length&&!selected.manualText?.trim()
    ? '<div class="manual-transcription-guidance"><span><strong>原因：</strong>该人工框没有可用文字</span><span><strong>影响：</strong>空文本无法生成文字 Chunk</span><span><strong>下一步：</strong>填写人工转录文字，或将类型改为图片、表格等</span></div>'
    : "";
  const transcriptionEditor=transcriptionAllowed?`<label class="manual-transcription-editor"><span>人工转录文字</span><textarea id="manualTranscription" placeholder="填写该框中可见的文字；内容将作为人工修订保存">${escapeHtml(selected.manualText??"")}</textarea><small>来源保留为当前页码和框选坐标，不会写回 Parsed Document。</small></label>${transcriptionGuidance}`:"";
  $("#detailPanel").innerHTML=selected?`<div class="annotation-source-detail"><span class="eyebrow">SOURCE BOX</span><h3>${escapeHtml(ANNOTATION_LABELS[selected.type]??selected.type)}</h3><dl><div><dt>图层</dt><dd>${state.lockedSourceKey.startsWith("detection:")?"MinerU 检测":"人工标注"}</dd></div><div><dt>页码</dt><dd>P.${selected.page}</dd></div>${selected.logicalGroupId?`<div><dt>逻辑组</dt><dd>${escapeHtml(logicalGroupLabel(selected))} · ${selected.groupMemberIndex??1}/${selected.groupMemberCount??1} · ${escapeHtml(logicalGroupPages(selected))}</dd></div>`:""}<div><dt>状态</dt><dd>${selected.excluded?"已排除":"有效"}</dd></div><div><dt>坐标</dt><dd>${selected.bbox.map((value)=>Number(value).toFixed(state.lockedSourceKey.startsWith("manual:")?3:1)).join(" / ")}</dd></div><div><dt>原始来源</dt><dd>${escapeHtml((selected.sourceBlockIds??[]).join(", ")||"人工框")}</dd></div>${selected.revisionOf?`<div><dt>修订</dt><dd>替代 MinerU ${escapeHtml(selected.revisionOf)}</dd></div>`:""}</dl>${transcriptionEditor}</div>`:'<div class="detail-empty">未选择来源框</div>';
  const transcription=$("#manualTranscription");
  if(transcription){
    transcription.oninput=()=>{const annotation=file.annotationState.annotations.find((item)=>item.id===selected.id);if(!annotation)return;annotation.manualText=transcription.value;annotation.transcriptionSource="human";annotation.transcribedAt=new Date().toISOString()};
    transcription.onchange=()=>{queueAnnotationSave(file);$("#saveState").textContent="人工转录文字已更新"};
  }
  applyHighlights();
}
function qualityFlagLabel(value) {
  return ({
    source_location_page_only: "来源仅定位到页面",
    source_location_parsed_only: "来源仅定位到解析结果",
    source_location_unavailable: "来源定位不可用",
    image_asset_unavailable: "图片资产不可用",
    semantic_budget_boundary: "语义边界受 Token 预算限制",
    reading_order_uncertain: "阅读顺序待复核",
    visual_copy_unavailable: "视觉副本不可用",
    needs_review: "需要复核",
    normalization_failed: "规范化失败",
    unsupported_content: "暂不支持此内容",
    partial_content: "内容不完整",
    "过短": "过短",
    "超长": "超长",
  })[value] ?? "需要复核";
}
function renderChunks() {
  const filter=$("#chunkTypeFilter");
  if(state.strategy==="manual"&&!currentFile()?.manualPrototype){if(filter){filter.value="all";filter.disabled=true;filter.closest(".chunk-filter")?.classList.add("hidden")}return renderAnnotationSources();}
  if(filter){filter.disabled=false;filter.value=state.chunkTypeFilter;filter.closest(".chunk-filter")?.classList.remove("hidden")}
  const chunks = [...currentChunks()].sort((left,right) => {
    const leftSource = left.sourceSegments?.[0] ?? {}, rightSource = right.sourceSegments?.[0] ?? {};
    return (leftSource.page ?? Number.MAX_SAFE_INTEGER) - (rightSource.page ?? Number.MAX_SAFE_INTEGER)
      || (leftSource.bbox?.[1] ?? Number.MAX_SAFE_INTEGER) - (rightSource.bbox?.[1] ?? Number.MAX_SAFE_INTEGER)
      || (leftSource.bbox?.[0] ?? Number.MAX_SAFE_INTEGER) - (rightSource.bbox?.[0] ?? Number.MAX_SAFE_INTEGER)
      || String(left.id).localeCompare(String(right.id));
  });
  const visibleChunks = state.chunkTypeFilter === "all" ? chunks : chunks.filter((chunk) => chunkTypeValue(chunk) === state.chunkTypeFilter);
  state.selectedContextIds = new Set([...state.selectedContextIds].filter((id) => chunks.some((chunk) => chunk.id === id && contextEligible(chunk))));
  if (!visibleChunks.some((chunk) => chunk.id === state.selectedChunkId)) state.selectedChunkId = state.linkSelection ? state.linkSelection.primaryChunkId : visibleChunks[0]?.id ?? null;
  const linkNotice=state.linkSelection?.missingSourceIds?.length?`<div class="link-notice" role="status">${escapeHtml(missingSourceMessage(state.linkSelection.missingSourceIds))}：${state.linkSelection.missingSourceIds.map(escapeHtml).join("、")}</div>`:"";
  $("#chunkList").innerHTML = linkNotice+(visibleChunks.length ? visibleChunks.map((chunk,index) => {
    const eligible=contextEligible(chunk), generating=state.contextGeneratingIds.has(chunk.id), contextState=generating?"generating":chunk.contextReviewState, exclusionReasons=chunk.embeddingExclusionReasons??[], unavailable=describeUnavailableReasons(exclusionReasons,{contentType:chunk.type}), referenceOnly=isImageReference(chunk);
    const waitingImageSummary=!referenceOnly&&chunk.type==="image"&&!chunk.vlmSummaryEffective&&!chunk.finalText&&chunk.imagePolicy!=="exclude";
    const sizeQuality=tokenSizeQuality([chunk]),qualityFlags=(chunk.qualityFlags??[]).filter((flag)=>!["undersized","oversized"].includes(flag));if(sizeQuality?.undersized)qualityFlags.push("过短");if(sizeQuality?.oversized)qualityFlags.push("超长");
    const typeLabel=chunkTypeLabel(chunk);
    const availabilityFlag=referenceOnly?"":(!eligible&&!waitingImageSummary?`<span class="flag context-ineligible" title="${escapeHtml(unavailable.reason)}">不可生成</span>`:"");
    const contextStateMarkup=referenceOnly?"":`<span class="context-state ${escapeHtml(contextState)}">${escapeHtml(contextStateLabel(contextState))}</span>`;
    const contextControl=referenceOnly?"":(waitingImageSummary?`<button class="image-summary-link" data-edit-image-summary="${escapeHtml(chunk.id)}">填写图片摘要</button>`:!eligible?`<label class="context-check context-ineligible"><input type="checkbox" disabled/> 当前不可选择</label>`:state.mode!=="draft"?'<span class="context-preview-ready">采用 Draft 后可生成</span>':`<label class="context-check"><input type="checkbox" aria-label="选择 Chunk ${index+1} 生成 Context" data-context-select="${escapeHtml(chunk.id)}" ${state.selectedContextIds.has(chunk.id)?"checked":""} ${generating?"disabled":""}/> 选择生成</label>`);
    return `<article role="button" aria-label="Chunk ${index + 1}，${typeLabel}，${chunk.tokenCount} tokens" tabindex="0" class="chunk-card ${chunk.type} ${chunk.id === state.selectedChunkId ? "active" : ""} ${chunk.excluded ? "excluded" : ""}" data-chunk-id="${escapeHtml(chunk.id)}"><div class="chunk-top"><span>${String(index+1).padStart(2,"0")} · ${typeLabel}</span><span>${chunk.tokenCount} TOKENS · ${[...new Set(chunk.sourceSegments.map((s)=>s.page).filter(Boolean))].map((p)=>`P${p}`).join(",") || "SOURCE"}</span></div>${renderChunkPreview(chunk)}<div class="chunk-flags">${qualityFlags.map((flag)=>`<span class="flag">${escapeHtml(qualityFlagLabel(flag))}</span>`).join("")}${chunk.sourceSegments.some((s)=>s.isOverlap)?'<span class="flag">OVERLAP</span>':""}${availabilityFlag}${contextStateMarkup}</div>${contextControl}${!referenceOnly&&!eligible&&!waitingImageSummary?renderUnavailableNotice(unavailable,"compact"):""}</article>`;
  }).join("") : '<div class="empty">当前模式没有 Chunk</div>');
  $$("[data-chunk-id]").forEach((element) => {
    element.onmouseenter = () => highlightForChunk(element.dataset.chunkId, "hover");
    element.onmouseleave = () => clearHover();
    element.onclick = (event) => { if (event.target.closest("[data-context-select],[data-edit-image-summary]")) return; selectLinkedChunk(element.dataset.chunkId,event); };
    element.onkeydown = (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); element.click(); } };
  });
  $$('[data-context-select]').forEach((checkbox) => checkbox.onchange = () => { checkbox.checked ? state.selectedContextIds.add(checkbox.dataset.contextSelect) : state.selectedContextIds.delete(checkbox.dataset.contextSelect); renderContextToolbar(); });
  $$('[data-edit-image-summary]').forEach((button)=>button.onclick=()=>{selectLinkedChunk(button.dataset.editImageSummary);const file=currentFile();if(file)file.editingChunkId=button.dataset.editImageSummary;renderDetail();});
  renderDetail(); applyHighlights();
  renderReviewProgress();
}

function renderReviewProgress() {
  const file = currentFile(), draft = file?.reviewState?.draft, toolbar = $("#reviewProgressToolbar");
  if (!toolbar) return;
  const chunks = draft?.chunks ?? [], progress = file?.reviewProgress ?? { completedChunkIds: [] }, completed = new Set(progress.completedChunkIds ?? []);
  const editable = state.mode === "draft" && file?.editable === true;
  toolbar.classList.toggle("hidden", !draft);
  $("#reviewProgressCount").textContent = `已处理 ${chunks.filter((chunk) => completed.has(chunk.id)).length} / ${chunks.length}`;
  $("#markToHereButton").disabled = !editable || !state.selectedChunkId;
  $("#unmarkSelectedButton").disabled = !editable || !state.selectedChunkId;
}

async function updateReviewProgress(action, payload = {}) {
  const file = currentFile(); if (!file?.editable || !file.reviewState?.draft) return;
  try {
    setError("");
    const result = await api(`/api/batches/${state.batchId}/documents/${file.id}/review/progress`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload, expectedRevision: file.reviewRevision ?? 0 }) });
    file.reviewProgress = result.reviewProgress; file.reviewRevision = result.reviewRevision; setError(""); $("#saveState").textContent = action === "mark-to-here" ? "已标记到这里" : "已更新处理进度"; renderReviewProgress();
  } catch (error) { setError(error); }
}

$("#markToHereButton").onclick = () => updateReviewProgress("mark-to-here", { cursorChunkId: state.selectedChunkId });
$("#unmarkSelectedButton").onclick = () => updateReviewProgress("unmark-selected", { chunkIds: state.selectedChunkId ? [state.selectedChunkId] : [] });

function contextStateLabel(value) { return ({ not_generated: "未生成", generating: "生成中", awaiting_review: "待审核", confirmed: "已确认", human_modified: "人工修改", failed: "失败", stale: "已失效" })[value] ?? value; }
function renderUnavailableNotice(presentation,variant="") { return `<div class="context-ineligible-notice ${variant}"><span><strong>原因：</strong>${escapeHtml(presentation.reason)}</span><span><strong>影响：</strong>${escapeHtml(presentation.impact)}</span><span><strong>下一步：</strong>${escapeHtml(presentation.next)}</span></div>`; }
function isImageReference(chunk) { return chunk?.type === "image" && (chunk.imagePolicy === "reference" || chunk.imageEditorDraft?.imagePolicy === "reference"); }
function contextEligible(chunk) { return chunk.embeddingEligible === true && !(chunk.embeddingExclusionReasons??[]).length && !chunk.excluded; }
function renderChunkSpuScope(chunk,file){const ids=currentSpuIds(file),scope=chunk.scope??(ids.length===1?"assigned":"unassigned"),targets=chunk.targetSpuIds??(scope==="common"?ids:[]),editable=state.mode==="draft"&&file?.editable===true&&ids.length>0;return `<div class="chunk-scope-editor"><div class="scope-editor-head"><strong>SPU 资料归属</strong><span>${escapeHtml(scope==="assigned"?"指定 SPU":scope==="common"?"所有目标 SPU":scope==="conflicted"?"冲突，阻断导出":"未分配，阻断导出")}</span></div><label>范围<select id="chunkSpuScope" ${!editable?"disabled":""}><option value="assigned" ${scope==="assigned"?"selected":""}>指定 SPU</option><option value="common" ${scope==="common"?"selected":""}>公共资料（复制到目标 SPU）</option><option value="unassigned" ${scope==="unassigned"?"selected":""}>未分配</option><option value="conflicted" ${scope==="conflicted"?"selected":""}>冲突</option></select></label><div id="chunkSpuTargets" class="chunk-spu-targets">${(scope==="assigned"||scope==="conflicted")?ids.map((id)=>`<label><input type="checkbox" data-chunk-spu-target value="${escapeHtml(id)}" ${targets.includes(id)?"checked":""} ${!editable?"disabled":""}/> ${escapeHtml(id)}</label>`).join(""):scope==="common"?`<span class="scope-help">${ids.length} 个目标 SPU 均会包含此 Chunk</span>`:`<span class="scope-help">先选择归属，才能导出 Markdown</span>`}</div>${editable?'<button class="ghost-button" id="saveChunkSpuScope" type="button">保存归属</button>':""}</div>`}

function renderContextToolbar() {
  const toolbar = $("#contextToolbar"); if (!toolbar) return;
  const editable = state.mode === "draft" && Boolean(currentFile()?.reviewState?.draft) && currentFile()?.editable === true;
  toolbar.classList.toggle("hidden", !editable);
  if (!editable) return;
  $("#contextSelectionCount").textContent = state.selectedContextIds.size ? `已选择 ${state.selectedContextIds.size} 个 Chunk` : "未选择 Context 项";
  const busy = state.contextGeneratingIds.size > 0;
  const chunks=currentChunks(), contextChunks=chunks.filter((chunk)=>!isImageReference(chunk)), awaiting=contextChunks.filter((chunk)=>chunk.contextReviewState==="awaiting_review").length, failed=contextChunks.filter((chunk)=>chunk.contextReviewState==="failed").length, skipped=contextChunks.filter((chunk)=>!contextEligible(chunk)).length;
  $("#contextProgress").textContent = `生成中 ${state.contextGeneratingIds.size} · 待审核 ${awaiting} · 失败 ${failed} · 不合格 ${skipped}${state.contextSummary?` · ${state.contextSummary}`:""}`;
  $("#generateSelectedContext").disabled = !state.selectedContextIds.size || busy || !state.selectedContextProfileId;
  const pageCandidates = chunks.filter((chunk) => contextEligible(chunk) && !state.contextGeneratingIds.has(chunk.id) && (chunk.contextCandidateReasons ?? []).length && chunk.sourceSegments.some((segment) => (segment.page ?? 1) === state.currentPage));
  $("#generatePageContext").disabled = !pageCandidates.length || busy || !state.selectedContextProfileId;
  $("#generatePageContext").textContent = `生成 P.${state.currentPage} 候选 (${pageCandidates.length})`;
}

$("#clearContextSelection").onclick = () => { state.selectedContextIds.clear(); renderChunks(); renderContextToolbar(); };
$("#generateSelectedContext").onclick = () => generateContexts([...state.selectedContextIds]);
$("#generatePageContext").onclick = () => generateContexts(currentChunks().filter((chunk) => (chunk.contextCandidateReasons ?? []).length && chunk.sourceSegments.some((segment) => (segment.page ?? 1) === state.currentPage)).map((chunk) => chunk.id));

async function generateContexts(chunkIds) {
  const file = currentFile(); if (!file || !chunkIds.length) return;
  const visibleProfile=$("#contextProfileSelect")?.value;if(visibleProfile){state.selectedContextProfileId=visibleProfile;localStorage.setItem("chunkLabContextProfileId",visibleProfile)}
  const requestedChunks=file.reviewState.draft.chunks.filter((chunk)=>chunkIds.includes(chunk.id));
  const eligibleIds=requestedChunks.filter(contextEligible).map((chunk)=>chunk.id), skippedCount=chunkIds.length-eligibleIds.length;
  if (!eligibleIds.length) { state.contextSummary=`本次跳过 ${skippedCount}`; renderAll(); return; }
  const protectedChunks = requestedChunks.filter((chunk) => contextEligible(chunk) && ["human_modified", "confirmed"].includes(chunk.contextReviewState));
  const allowHumanContextOverwrite = protectedChunks.length ? confirm(`其中 ${protectedChunks.length} 个 Chunk 已有审核过的 Context。确认重新生成并覆盖吗？`) : false;
  if (protectedChunks.length && !allowHumanContextOverwrite) return;
  const requestId = ++state.contextRequestId;
  state.contextGeneratingIds=new Set(eligibleIds); state.contextSummary=skippedCount?`本次跳过 ${skippedCount}`:"";
  $("#saveState").textContent = "Context 生成中"; setError(""); renderAll();
  try {
    const result = await api(`/api/batches/${state.batchId}/documents/${file.id}/context/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chunkIds:eligibleIds, allowHumanContextOverwrite, profileId:state.selectedContextProfileId }) });
    if (requestId !== state.contextRequestId) return;
    file.reviewState = mergeContextGenerationResult(result.reviewState, file.reviewState, eligibleIds); invalidateExportSnapshot(); state.selectedContextIds.clear(); state.contextGeneratingIds.clear();
    const completed=file.reviewState.draft.chunks.filter((chunk)=>eligibleIds.includes(chunk.id)), failed=completed.filter((chunk)=>chunk.contextReviewState==="failed").length;
    state.contextSummary=skippedCount?`本次跳过 ${skippedCount}`:""; $("#saveState").textContent = failed ? "部分 Context 失败" : "Context 待审核"; renderAll();
  } catch (error) { state.contextGeneratingIds.clear(); state.contextSummary=`请求失败${skippedCount?` · 本次跳过 ${skippedCount}`:""}`; setError(error); $("#saveState").textContent = "Context 失败"; renderAll(); }
}

function vlmStatusLabel(value) { return ({unconfigured:"未配置",generating:"生成中",awaiting_review:"待审核",failed:"失败"})[value]??"未配置"; }
function imageLinkCandidates(chunk,query="",selectedIds=[]){return relatedChunkCandidates(currentChunks(),chunk.id,{query,selectedIds,requireEmbeddingEligibility:true,limit:6,before:3,after:3,adjacentOnly:true})}
function renderImageEditorMarkup(chunk,editing){
  const draft=chunk.imageEditorDraft??{imagePolicy:chunk.imagePolicy??"summary",relatedChunkIds:[...(chunk.relatedChunkIds??[])],humanSummary:chunk.vlmSummaryReviewed??"",humanSupplement:chunk.vlmSummarySupplement??""};
  const policy=draft.imagePolicy,selectedIds=new Set(draft.relatedChunkIds??[]),query=chunk.imageRelatedQuery??"",candidates=imageLinkCandidates(chunk,query,selectedIds),invalidIds=chunk.invalidRelatedChunkIds??[];
  const profileId=chunk.vlmProfileId&&profilesFor("vlm").some((profile)=>profile.id===chunk.vlmProfileId)?chunk.vlmProfileId:state.selectedVlmProfileId;
  const generating=state.vlmGeneratingIds.has(chunk.id)||chunk.vlmStatus==="generating";
  const metadata=[chunk.vlmProfileName,chunk.vlmModel,chunk.vlmPromptVersion,chunk.vlmCacheHit?"缓存命中":null,chunk.vlmGeneratedAt?new Date(chunk.vlmGeneratedAt).toLocaleString():null].filter(Boolean).join(" · ");
  const rows=candidates.map((candidate)=>'<label data-image-related-row><input type="checkbox" data-related-chunk-id="'+escapeHtml(candidate.id)+'" '+(selectedIds.has(candidate.id)?"checked ":"")+(!editing?"disabled ":"")+'/><span><strong>'+escapeHtml(candidate.id)+'</strong><small>'+escapeHtml(candidate.finalText.slice(0,120))+'</small></span></label>').join("");
  const invalidNotice=invalidIds.length?'<div class="context-ineligible-notice"><span><strong>原因：</strong>'+invalidIds.length+' 个原关联已排除、删除、替换或失去检索资格。</span><span><strong>影响：</strong>失效对象已由服务端移出有效关联，图片资格已重算。</span><span><strong>下一步：</strong>恢复原文字 Chunk，或选择新的有效文字 Chunk 后保存。</span></div>':"";
  const links=policy==="exclude"?"":'<div class="image-related-editor"><div class="image-related-heading"><strong>关联文字 Chunk</strong><span id="imageRelatedCount">'+selectedIds.size+' 个</span></div>'+(editing?'<label>搜索<input id="imageRelatedSearch" type="search" value="'+escapeHtml(query)+'" placeholder="按 Chunk ID 或文本搜索"/></label>':"")+'<div class="image-related-list">'+(rows||'<div class="context-none">没有匹配的文字 Chunk</div>')+'</div>'+invalidNotice+'</div>';
  const referenceNotice=policy==="reference"?'<div class="link-notice">仅引用策略：只关联文字 Chunk，不需要人工摘要或 VLM。图片自身不进入文本 Embedding，下游通过关联文字工作。</div>':"";
  const vlm=policy==="summary"?'<label>图片理解模型<select id="vlmProfileSelect" '+(!editing||generating?"disabled":"")+'>'+profileOptions("vlm",profileId)+'</select></label><button class="primary-button" id="generateVlmSummary" '+(!editing||!profileId||generating?"disabled":"")+'>'+(generating?"正在生成图片摘要":"发送图片并生成摘要")+'</button><div class="model-generation-status" role="status"><strong>'+escapeHtml(vlmStatusLabel(generating?"generating":chunk.vlmStatus))+'</strong>'+(metadata?'<span>'+escapeHtml(metadata)+'</span>':"")+(chunk.vlmError?'<span>'+escapeHtml(chunk.vlmError)+'</span>':"")+'</div><label>VLM 原始摘要<textarea id="vlmGenerated" readonly>'+escapeHtml(chunk.vlmSummaryGenerated??"")+'</textarea></label><label>人工摘要<textarea id="vlmReviewed" '+(!editing?"readonly":"")+' placeholder="独立撰写或修改机器摘要">'+escapeHtml(draft.humanSummary??"")+'</textarea></label><label>人工补充<textarea id="vlmSupplement" '+(!editing?"readonly":"")+' placeholder="补充型号、适用范围等检索信息">'+escapeHtml(draft.humanSupplement??"")+'</textarea></label>':"";
  return '<div class="image-review-editor"><label>图片策略<select id="chunkImagePolicy" '+(!editing?"disabled":"")+'><option value="exclude" '+(policy==="exclude"?"selected":"")+'>排除</option><option value="reference" '+(policy==="reference"?"selected":"")+'>仅引用</option><option value="summary" '+(policy==="summary"?"selected":"")+'>摘要 + 引用</option></select></label>'+referenceNotice+links+vlm+'<div class="effective-summary"><span>最终生效文本</span><p>'+escapeHtml(chunk.finalText||"当前策略不产生图片检索文本")+'</p></div>'+(editing?'<div class="save-action-row"><button class="primary-button" id="saveImageSummary">保存图片策略</button><span id="imagePolicyFeedback" class="action-feedback" role="status" aria-live="polite">'+escapeHtml(chunk.imagePolicyFeedback??"")+'</span></div>':"")+'</div>';
}
function renderImageReviewEditor(chunk,editing) { return renderImageEditorMarkup(chunk,editing); }
function renderDetail() {
  const chunk = currentChunks().find((candidate) => candidate.id === state.selectedChunkId);
  if (!chunk) { $("#detailPanel").innerHTML = '<div class="detail-empty">选择一个 Chunk 查看详情</div>'; return; }
  const file=currentFile(), editable = state.mode === "draft", editing=editable&&file?.editingChunkId===chunk.id, referenceOnly=isImageReference(chunk), eligible=contextEligible(chunk), generating=state.contextGeneratingIds.has(chunk.id), exclusionReasons=chunk.embeddingExclusionReasons??[], unavailable=describeUnavailableReasons(exclusionReasons,{contentType:chunk.type,hasReliableText:Boolean(chunk.finalText?.trim()),hasTableStructure:chunk.reviewedModel?.type==="table"||chunk.normalizedModels?.some((model)=>model?.type==="table")}), staleReason=chunk.contextStaleReason??chunk.contextError;
  const mobile=false;
  const reviewedType=chunk.tableEditorDraft?.type??chunk.finalType??chunk.reviewedModel?.type??chunk.automaticType??(chunk.contentTypes?.[0]==="table"?"table":chunk.contentTypes?.[0]==="image"?"image":"paragraph");
  const editorValue=chunk.finalText,tableEditorModel=chunk.tableEditorDraft??chunk.reviewedModel??tableModelFromChunk(chunk);
  const contextProfileId=chunk.contextProfileId&&profilesFor("context").some((profile)=>profile.id===chunk.contextProfileId)?chunk.contextProfileId:state.selectedContextProfileId;
  const contextServiceNotice=eligible&&editable&&!contextProfileId?'<div class="context-ineligible-notice"><span><strong>原因：</strong>Context 服务尚未配置。</span><span><strong>影响：</strong>当前不能调用模型生成 Context。</span><span><strong>下一步：</strong>可先填写并保存人工 Context，或联系维护人员完成服务配置。</span></div>':"";
  const contextModelControl=editable?`<label class="context-model-select">Context 模型<select id="contextProfileSelect" ${generating?"disabled":""}>${profileOptions("context",contextProfileId)}</select></label>${contextServiceNotice}`:"";
  const contentEditor=reviewedType==="table"?renderTableEditor(tableEditorModel,editing):chunk.type==="image"?renderImageReviewEditor(chunk,editing):`<textarea id="chunkEditor" ${!editing?"readonly":""} aria-label="Chunk 审阅内容">${escapeHtml(editorValue)}</textarea>`;
  $("#detailPanel").classList.toggle("image-reference-detail", referenceOnly);
  $("#detailPanel").innerHTML = `<div class="detail-head"><div><strong>${escapeHtml(chunk.id)}</strong><div class="detail-meta">${escapeHtml(chunk.automaticType??chunk.type)} → ${escapeHtml(chunk.finalType??reviewedType)} · ${chunk.tokenCount} TOKENS · ${escapeHtml(contextStateLabel(chunk.contextReviewState))}</div></div><div><button class="icon-button" id="undoButton" title="撤销" ${!editable?"disabled":""}>↶</button><button class="icon-button" id="redoButton" title="重做" ${!editable?"disabled":""}>↷</button></div></div>
    <div class="typed-editor"><label>审阅类型<select id="reviewedType" ${!editing||mobile?"disabled":""}>${["heading","paragraph","list","table","image","formula","code","warning","caption","footnote","plain_text_repair"].map((type)=>`<option value="${type}" ${type===reviewedType?"selected":""}>${type}</option>`).join("")}</select></label></div>
    <div class="detail-actions"><button id="editChunkButton" ${!editable?"disabled":""}>${editing?"结束编辑":"编辑"}</button><button id="splitButton" ${!editing||chunk.type!=="text"||mobile?"disabled":""}>在光标拆分</button><button id="mergeButton" ${!editing||mobile?"disabled":""}>合并下一块</button><button id="excludeButton" ${!editable?"disabled":""}>${chunk.excluded?"恢复":"排除"}</button><button id="restoreButton" ${!editing?"disabled":""}>恢复自动文本</button></div>
     ${contentEditor}
     ${reviewedType==="table"?renderTableRetrievalEditor(chunk,editing):""}
     <div class="detail-section spu-scope-detail">${renderChunkSpuScope(chunk,file)}</div>
     <div class="detail-section context-review"><div class="context-title"><h3>Context Enhancement</h3><span class="context-state ${escapeHtml(generating?"generating":chunk.contextReviewState)}">${escapeHtml(contextStateLabel(generating?"generating":chunk.contextReviewState))}</span></div>${contextModelControl}${!eligible?renderUnavailableNotice(unavailable):""}${chunk.contextError && chunk.contextReviewState!=="stale" ? `<div class="context-error">${escapeHtml(chunk.contextError)}</div>` : ""}${chunk.contextReviewState==="stale"?`<div class="context-stale-note">已失效：${escapeHtml(staleReason||"Chunk 内容或范围已变化")}。仅供审阅，不进入 embeddingText。</div>`:""}<textarea id="contextEditor" ${!editable?"readonly":""} placeholder="生成或人工填写 2-4 句背景说明">${escapeHtml(chunk.contextEditorDraft??chunk.contextText??"")}</textarea>${chunk.contextModel||chunk.contextPromptVersion?`<div class="context-version">模型 ${escapeHtml(chunk.contextModel??"-")} · Prompt ${escapeHtml(chunk.contextPromptVersion??"-")}</div>`:""}${(chunk.contextScope??[]).length ? `<details class="context-scope"><summary>实际采用的 Context 范围 (${chunk.contextScope.length})</summary>${chunk.contextScope.map((item)=>`<span>${escapeHtml(item)}</span>`).join("")}</details>` : ""}${(chunk.skippedNeighborReasons??[]).length?`<details class="context-scope skipped-neighbors"><summary>跳过的邻居 (${chunk.skippedNeighborReasons.length})</summary>${chunk.skippedNeighborReasons.map((item)=>`<span>${escapeHtml(item.chunkId)}：${escapeHtml((item.reasons??[]).join("；"))}</span>`).join("")}</details>`:""}${editable ? `<div class="context-actions"><button id="generateOneContext" ${!eligible||generating||!contextProfileId?"disabled":""}>${["failed","stale"].includes(chunk.contextReviewState)?"重新生成":"生成 Context"}</button><button id="saveManualContext">保存人工 Context</button><button id="confirmContext" ${chunk.contextReviewState!=="awaiting_review"?"disabled":""}>确认 Context</button></div>` : ""}</div>
    <div class="detail-section"><h3>Source Segments</h3>${chunk.sourceSegments.map((segment)=>`<button class="source-segment ${segment.isOverlap?"overlap":""}" data-source-segment-block-id="${escapeHtml(segment.contentBlockId??segment.blockId)}"><span>${escapeHtml(segment.contentBlockId??segment.blockId)} · ${Number.isInteger(segment.sourceStart)&&Number.isInteger(segment.sourceEnd)?`${segment.sourceStart}-${segment.sourceEnd}`:"Block 级来源"}</span><span>${segment.page?`P.${segment.page}`:escapeHtml(segment.locationQuality??"SOURCE")}${segment.isOverlap?" · OVERLAP":""}</span></button>`).join("")}</div>`;
  $$('[data-source-segment-block-id]').forEach((element)=>{element.onmouseenter=()=>highlightForBlock(element.dataset.sourceSegmentBlockId,"hover");element.onmouseleave=clearHover;element.onclick=(event)=>{const sourceIds=[element.dataset.sourceSegmentBlockId];selectLinkedSourceIds(sourceIds,event);scrollSourceIds(sourceIds)}});
  const chunkEditor=$("#chunkEditor");if(chunkEditor){const resize=()=>{chunkEditor.style.height="auto";chunkEditor.style.height=`${chunkEditor.scrollHeight+2}px`};resize();chunkEditor.addEventListener("input",resize)}
   if (!editable) return;
   if($("#chunkSpuScope"))$("#chunkSpuScope").onchange=()=>{const next=$("#chunkSpuScope").value;const targetBox=$("#chunkSpuTargets");if(!targetBox)return;const ids=currentSpuIds(file);targetBox.innerHTML=(next==="assigned"||next==="conflicted")?ids.map((id)=>`<label><input type="checkbox" data-chunk-spu-target value="${escapeHtml(id)}"/> ${escapeHtml(id)}</label>`).join(""):next==="common"?`<span class="scope-help">${ids.length} 个目标 SPU 均会包含此 Chunk</span>`:`<span class="scope-help">先选择归属，才能导出 Markdown</span>`};
   if($("#saveChunkSpuScope"))$("#saveChunkSpuScope").onclick=async()=>{const scope=$("#chunkSpuScope").value,targetSpuIds=$$('[data-chunk-spu-target]:checked').map((input)=>input.value);if((scope==="assigned"||scope==="conflicted")&&!targetSpuIds.length)return setError("请选择至少一个目标 SPU");try{const result=await api(`/api/batches/${state.batchId}/documents/${file.id}/chunks/${encodeURIComponent(chunk.id)}/spu-scope`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({scope,targetSpuIds,expectedRevision:file.reviewRevision})});const live=file.reviewState.draft.chunks.find((item)=>item.id===chunk.id);if(live){live.scope=result.scope;live.targetSpuIds=result.targetSpuIds}file.reviewRevision=result.reviewRevision;file.spuMaterialExport=await refreshSpuMaterialStatus(file);invalidateExportSnapshot();$("#saveState").textContent="Chunk SPU 归属已保存";renderAll()}catch(error){setError(error)}};
  $("#editChunkButton").onclick=()=>{file.editingChunkId=editing?null:chunk.id;renderDetail()};
  if($("#chunkImagePolicy"))$("#chunkImagePolicy").onchange=()=>{
    chunk.imageEditorDraft={imagePolicy:$("#chunkImagePolicy").value,relatedChunkIds:[...(chunk.imageEditorDraft?.relatedChunkIds??chunk.relatedChunkIds??[])],humanSummary:$("#vlmReviewed")?.value??chunk.imageEditorDraft?.humanSummary??chunk.vlmSummaryReviewed??"",humanSupplement:$("#vlmSupplement")?.value??chunk.imageEditorDraft?.humanSupplement??chunk.vlmSummarySupplement??""};
    renderDetail();
  };
  $$("[data-related-chunk-id]").forEach((input)=>input.onchange=()=>{
    const selected=new Set(chunk.imageEditorDraft?.relatedChunkIds??chunk.relatedChunkIds??[]);input.checked?selected.add(input.dataset.relatedChunkId):selected.delete(input.dataset.relatedChunkId);
    chunk.imageEditorDraft={...(chunk.imageEditorDraft??{}),imagePolicy:$("#chunkImagePolicy").value,relatedChunkIds:[...selected],humanSummary:$("#vlmReviewed")?.value??chunk.imageEditorDraft?.humanSummary??chunk.vlmSummaryReviewed??"",humanSupplement:$("#vlmSupplement")?.value??chunk.imageEditorDraft?.humanSupplement??chunk.vlmSummarySupplement??""};
    if($("#imageRelatedCount"))$("#imageRelatedCount").textContent=selected.size+" 个";
  });
  if($("#imageRelatedSearch"))$("#imageRelatedSearch").oninput=(event)=>{
    chunk.imageRelatedQuery=event.target.value;renderDetail();const search=$("#imageRelatedSearch");search?.focus();search?.setSelectionRange(search.value.length,search.value.length);
  };
  if(chunk.parentChunk){
    const parent = parentContextFor(chunk,currentChunks());
    const details=document.createElement("details");details.className="parent-context";
    const summary=document.createElement("summary");summary.textContent=`父块 ${parent.id} · ${parent.childCount} 个子块`;
    const content=document.createElement("pre");content.textContent=parent.text;
    details.append(summary,content);$("#detailPanel").prepend(details);
  }
  if($("#contextEditor"))$("#contextEditor").oninput=(event)=>{chunk.contextEditorDraft=event.target.value};
  if($("#chunkEditor")){const typeEditor=$("#reviewedType");let typeChanged=false;typeEditor.onchange=async()=>{typeChanged=true;const type=typeEditor.value;if(type==="table"){chunk.tableEditorDraft=tableModelFromChunk(chunk);renderDetail();return}await queueReviewedModelSave(chunk,type,$("#chunkEditor").value)};typeEditor.onblur=async()=>{if(!editing||typeChanged)return;const editor=$("#chunkEditor");if(editor&&editor.value!==editorValue)await queueReviewedModelSave(chunk,typeEditor.value,editor.value)};$("#chunkEditor").onblur=async(event)=>{if(!editing||event.relatedTarget===typeEditor)return;const type=typeEditor.value;if(event.target.value!==editorValue||type!==reviewedType)await queueReviewedModelSave(chunk,type,event.target.value)};}
   if($("#tableEditor"))bindTableEditor(chunk,reviewedType);
   if($("#saveTableRetrieval"))bindTableRetrievalEditor(chunk,editing);
  if($("#vlmProfileSelect"))$("#vlmProfileSelect").onchange=(event)=>{state.selectedVlmProfileId=event.target.value;localStorage.setItem("chunkLabVlmProfileId",event.target.value)};
  if($("#generateVlmSummary"))$("#generateVlmSummary").onclick=()=>generateVlmSummary(chunk);
  if($("#saveImageSummary"))$("#saveImageSummary").onclick=()=>saveImageSummary(chunk);
  if($("#contextProfileSelect"))$("#contextProfileSelect").onchange=(event)=>{state.selectedContextProfileId=event.target.value;localStorage.setItem("chunkLabContextProfileId",event.target.value)};
  $("#excludeButton").onclick = () => runReviewAction({type:chunk.excluded?"restore":"exclude",chunkId:chunk.id});
  $("#restoreButton").onclick = () => saveReviewedModel(chunk,["heading","paragraph","list","formula","code","warning","caption","footnote"].includes(chunk.automaticType)?chunk.automaticType:"paragraph",chunk.automaticText);
  $("#undoButton").onclick = () => runReviewAction({type:"undo"}); $("#redoButton").onclick = () => runReviewAction({type:"redo"});
  $("#splitButton").onclick = () => splitSelectedChunk($("#chunkEditor").selectionStart);
  $("#mergeButton").onclick = () => mergeNextChunk();
  $("#generateOneContext").onclick = () => generateContexts([chunk.id]);
  $("#saveManualContext").onclick = () => saveManualContext(chunk.id, $("#contextEditor").value);
  $("#confirmContext").onclick = () => confirmChunkContext(chunk.id);
}

function tableModelFromChunk(chunk){
  if(chunk.reviewedModel?.type==="table")return structuredClone(chunk.reviewedModel);
  const normalized=chunk.normalizedModels?.find((model)=>model?.type==="table"),parsed=tableRows(chunk.finalText),rawColumns=normalized?.columns?.length?normalized.columns:(parsed.shift()??["字段","值"]),rawRows=normalized?.rows?.length?normalized.rows:parsed,width=Math.max(1,rawColumns.length,...rawRows.map((row)=>row.length)),columns=Array.from({length:width},(_,index)=>String(rawColumns[index]??`列 ${index+1}`)),rows=(rawRows.length?rawRows:[Array(width).fill("")]).map((row,rowIndex)=>Array.from({length:width},(_,columnIndex)=>({cellId:`${chunk.tableId??chunk.id}:r${rowIndex+1}c${columnIndex+1}`,text:String(row[columnIndex]?.text??row[columnIndex]??""),rowSpan:1,colSpan:1}))),sourceSegmentIds=(chunk.sourceSegments??[]).map((segment)=>segment.contentBlockId??segment.blockId).filter(Boolean),tableId=chunk.tableId??`table:${chunk.id}`;
  return{type:"table",tableId,title:normalized?.title??"",columns,rows:rawRows.length?rows:[],rowGroups:[{rowGroupId:`${tableId}:group:1`,order:0,repeatedHeader:false,sourceSegmentIds,rowStart:0,rowCount:rawRows.length}]}
}
function renderStructuredTable(model,className="structured-table",limit=Infinity){const placements=tablePlacements(model),rows=placements.slice(0,limit),groups=limit===Infinity?new Map((model.rowGroups??[]).map((group)=>[group.rowStart,group])):new Map();if(!model.columns?.length||!rows.length)return'<div class="chunk-preview-text">表格结构不可用</div>';return`<table class="${className}">${model.title?`<caption>${escapeHtml(model.title)}</caption>`:""}<thead><tr>${model.columns.map((column)=>`<th scope="col">${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>${rows.map((row,rowIndex)=>`${groups.has(rowIndex)?`<tr class="table-row-group"><th colspan="${model.columns.length}">行组 ${groups.get(rowIndex).order+1}${groups.get(rowIndex).repeatedHeader?" · 重复表头":""}</th></tr>`:""}<tr>${row.map(({cell})=>`<td${cell.rowSpan>1?` rowspan="${cell.rowSpan}"`:""}${cell.colSpan>1?` colspan="${cell.colSpan}"`:""}>${escapeHtml(cell.text)}</td>`).join("")}</tr>`).join("")}</tbody></table>`}
function tableIdentity(model){return`<div class="table-identity"><span>${escapeHtml(model.tableId??"未编号表格")}</span><span>${model.rowGroups?.length??1} 个行组</span></div>`}
function renderTableEditor(model,editing){
  if(!editing)return`<div class="table-cell-editor" id="tableEditor">${tableIdentity(model)}<div class="table-editor-scroll">${renderStructuredTable(model,"structured-table-review")}</div></div>`;
  const placements=tablePlacements(model),groups=new Map((model.rowGroups??[]).map((group)=>[group.rowStart,group]));
  return`<div class="table-cell-editor editing" id="tableEditor">${tableIdentity(model)}<label class="table-title-field">表格标题<input id="tableTitle" value="${escapeHtml(model.title??"")}"/></label><div class="table-editor-scroll"><table class="structured-table-editor"><thead><tr>${model.columns.map((column,index)=>`<th><input data-table-column="${index}" value="${escapeHtml(column)}" aria-label="第 ${index+1} 列标题"/></th>`).join("")}<th class="table-row-action">操作</th></tr></thead><tbody>${placements.map((row,rowIndex)=>`${groups.has(rowIndex)?`<tr class="table-row-group"><th colspan="${model.columns.length+1}">行组 ${groups.get(rowIndex).order+1}${groups.get(rowIndex).repeatedHeader?" · 重复表头":""}</th></tr>`:""}<tr>${row.map(({cell,columnIndex})=>`<td${cell.rowSpan>1?` rowspan="${cell.rowSpan}"`:""}${cell.colSpan>1?` colspan="${cell.colSpan}"`:""}><label class="table-cell-select"><input type="checkbox" data-table-cell-select="${escapeHtml(cell.cellId)}" aria-label="选择第 ${rowIndex+1} 行第 ${columnIndex+1} 列"/><span></span></label><input data-table-cell-id="${escapeHtml(cell.cellId)}" value="${escapeHtml(cell.text)}" aria-label="第 ${rowIndex+1} 行第 ${columnIndex+1} 列"/></td>`).join("")}<td class="table-row-action"><button data-remove-table-row="${rowIndex}" title="删除本行" aria-label="删除第 ${rowIndex+1} 行">×</button></td></tr>`).join("")}</tbody></table></div><div class="table-editor-actions"><button id="addTableRowBefore">上方加行</button><button id="addTableRowAfter">下方加行</button><button id="addTableColumnBefore">左侧加列</button><button id="addTableColumnAfter">右侧加列</button><button id="removeTableColumn" title="删除选中单元格所在列">删除选中列</button><button id="mergeTableCells">合并选中</button><button id="splitTableCell">拆分单元格</button><button class="primary-button" id="saveTableEditor">保存表格</button></div></div>`
}
function tableRetrievalCandidates(chunk,query="",selectedIds=[],limit=6){return relatedChunkCandidates(currentChunks(),chunk.id,{query,selectedIds,requireEmbeddingEligibility:true,limit,before:3,after:3,adjacentOnly:!query})}
function tableSourceChunkVersion(candidate,file){return candidate.sourceSegments?.[0]?.parsedDocumentVersion??candidate.sourceSegments?.[0]?.sourceDocumentVersion??file.parsedDocument?.parsedDocumentVersion??"draft"}
function renderTableRetrievalEditor(chunk,editing){
  const file=currentFile(),draft=chunk.tableRetrievalDraft??{},selected=new Set(draft.sourceChunkIds??[]),query=chunk.tableRelatedQuery??"",candidates=tableRetrievalCandidates(chunk,query,selected),logicalTableId=draft.logicalTableId??`document:${file?.id??"document"}:table:${chunk.tableId??chunk.id}`,status=draft.tableVersionId?`<div class="table-retrieval-status"><span>版本 ${escapeHtml(draft.tableVersionId)}</span><strong>${draft.vectorReady?"vector_ready":"未就绪"}</strong></div>`:"";
  const rows=candidates.map((candidate)=>`<label class="table-retrieval-row"><input type="checkbox" data-table-retrieval-source-id="${escapeHtml(candidate.id)}" ${selected.has(candidate.id)?"checked ":""}${editing?"":"disabled "}/><span><strong>${escapeHtml(candidate.id)}</strong><small>${escapeHtml(candidate.finalText.slice(0,160))}</small></span></label>`).join("");
  return `<div class="detail-section table-retrieval-editor"><div class="context-title"><h3>普通检索关联文字</h3><span id="tableRetrievalCount">${selected.size} 个</span></div><div class="link-notice">表格检索只引用关联文字 Chunk，不需要人工摘要或 VLM。</div>${editing?`<label>搜索<input id="tableRelatedSearch" type="search" value="${escapeHtml(query)}" placeholder="按 Chunk ID 或文本搜索"/></label>`:""}<div class="table-retrieval-list">${rows||'<div class="context-none">没有匹配的文字 Chunk</div>'}</div><div class="table-retrieval-actions"><button class="primary-button" id="saveTableRetrieval" ${editing?"":"disabled"}>保存表格检索版本</button><span id="tableRetrievalFeedback" class="action-feedback" role="status" aria-live="polite">${escapeHtml(chunk.tableRetrievalFeedback??"")}</span>${status}</div><input type="hidden" id="tableRetrievalLogicalTableId" value="${escapeHtml(logicalTableId)}"/></div>`;
}
function bindTableRetrievalEditor(chunk,editing){
  if(!editing)return;
  $$('[data-table-retrieval-source-id]').forEach((input)=>input.onchange=()=>{const selected=new Set(chunk.tableRetrievalDraft?.sourceChunkIds??[]);input.checked?selected.add(input.dataset.tableRetrievalSourceId):selected.delete(input.dataset.tableRetrievalSourceId);chunk.tableRetrievalDraft={...(chunk.tableRetrievalDraft??{}),sourceChunkIds:[...selected],finalSummary:""};$("#tableRetrievalCount").textContent=`${selected.size} 个`;chunk.tableRetrievalFeedback="";$("#tableRetrievalFeedback").textContent=""});
  $("#tableRelatedSearch").oninput=(event)=>{chunk.tableRelatedQuery=event.target.value;renderDetail();const search=$("#tableRelatedSearch");search?.focus();search?.setSelectionRange(search.value.length,search.value.length)};
  $("#saveTableRetrieval").onclick=()=>saveTableRetrievalVersion(chunk);
}
async function saveTableRetrievalVersion(chunk){
  const file=currentFile();if(!file)return;
  const candidates=tableRetrievalCandidates(chunk,"",chunk.tableRetrievalDraft?.sourceChunkIds??[],Infinity),selectedIds=[...(chunk.tableRetrievalDraft?.sourceChunkIds??[])],logicalTableId=$("#tableRetrievalLogicalTableId")?.value??`document:${file.id}:table:${chunk.tableId??chunk.id}`,model=chunk.tableEditorDraft??chunk.reviewedModel??tableModelFromChunk(chunk);
  if(!selectedIds.length){chunk.tableRetrievalFeedback="请至少关联一个文字 Chunk";$("#tableRetrievalFeedback").textContent=chunk.tableRetrievalFeedback;return setError({message:"请至少关联一个文字 Chunk。",recovery:"选择同一文档内的有效文字 Chunk 后重试。"})}
  chunk.tableRetrievalFeedback="保存中...";$("#tableRetrievalFeedback").textContent=chunk.tableRetrievalFeedback;
  const summary="";
  const sourceChunks=selectedIds.map((id,order)=>{const candidate=candidates.find((item)=>item.id===id);return candidate?{sourceChunkId:candidate.id,sourceChunkVersion:tableSourceChunkVersion(candidate,file),order,finalText:candidate.finalText}:null}).filter(Boolean);
  try{
    $("#saveTableRetrieval").disabled=true;$("#saveState").textContent="表格检索版本保存中";setError("");
    const sourceSegments=(chunk.sourceSegments??[]).map((segment)=>({id:segment.contentBlockId??segment.blockId,page:segment.page??null,bbox:segment.bbox??null}));
    const result=await api("/api/table-retrieval/versions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({logicalTableId,reviewedModel:model,sourceSegments,finalSummary:summary,sourceChunks,batchId:state.batchId,documentId:file.id,chunkId:chunk.id})});
    chunk.tableRetrievalDraft={logicalTableId,finalSummary:summary,sourceChunkIds:selectedIds,tableVersionId:result.version.tableVersionId,vectorReady:result.bundle?.vectorReady===true};if(result.reviewState)file.reviewState=result.reviewState;const savedChunk=file.reviewState?.draft?.chunks?.find((candidate)=>candidate.id===chunk.id);if(savedChunk)savedChunk.tableRetrievalFeedback=result.bundle?.vectorReady?"已保存并就绪":"已保存";$("#saveState").textContent=result.bundle?.vectorReady?"表格检索版本已就绪":"表格检索版本已保存";renderDetail();
  }catch(error){chunk.tableRetrievalFeedback="保存失败";$("#tableRetrievalFeedback").textContent=chunk.tableRetrievalFeedback;setError(error);$("#saveState").textContent="表格检索版本保存失败";$("#saveTableRetrieval").disabled=false}
}
function tableModelFromEditor(base){const model=structuredClone(base),columns=$$("[data-table-column]").map((input)=>input.value.trim()||`列 ${Number(input.dataset.tableColumn)+1}`),values=new Map($$("[data-table-cell-id]").map((input)=>[input.dataset.tableCellId,input.value]));model.title=$("#tableTitle")?.value.trim()??"";model.columns=columns;model.rows.forEach((row)=>row.forEach((cell)=>{if(values.has(cell.cellId))cell.text=values.get(cell.cellId)}));return model}
function newTableCell(model,text=""){return{cellId:`${model.tableId}:cell:${browserUuid()}`,text,rowSpan:1,colSpan:1}}
function tableOperationError(reason,next="请调整选择后重试。"){setError({message:reason,recovery:next})}
function mergeSelectedTableCells(model,selected){const placements=tablePlacements(model).flat(),chosen=placements.filter(({cell})=>selected.has(cell.cellId));if(chosen.length<2)return tableOperationError("请至少选择两个单元格。"),false;if(chosen.some(({cell})=>cell.rowSpan!==1||cell.colSpan!==1))return tableOperationError("选区包含已合并单元格。","请先拆分现有合并单元格，再重新选择。"),false;const rows=chosen.map((item)=>item.rowIndex),columns=chosen.map((item)=>item.columnIndex),top=Math.min(...rows),bottom=Math.max(...rows),left=Math.min(...columns),right=Math.max(...columns),expected=(bottom-top+1)*(right-left+1),groups=(model.rowGroups??[]).filter((group)=>chosen.some((item)=>item.rowIndex>=group.rowStart&&item.rowIndex<group.rowStart+group.rowCount));if(groups.length>1)return tableOperationError("不能跨来源行组合并单元格。","请在同一个行组内重新选择。"),false;if(chosen.length!==expected||chosen.some((item)=>item.rowIndex<top||item.rowIndex>bottom||item.columnIndex<left||item.columnIndex>right))return tableOperationError("所选单元格不是完整矩形。","请选择连续行列中的完整矩形区域。"),false;const anchor=chosen.find((item)=>item.rowIndex===top&&item.columnIndex===left);anchor.cell.rowSpan=bottom-top+1;anchor.cell.colSpan=right-left+1;anchor.cell.text=chosen.map(({cell})=>cell.text.trim()).filter(Boolean).join(" / ");model.rows=model.rows.map((row)=>row.filter((cell)=>cell===anchor.cell||!selected.has(cell.cellId)));selected.clear();selected.add(anchor.cell.cellId);return true}
function splitSelectedTableCell(model,selected){const placements=tablePlacements(model).flat(),chosen=placements.filter(({cell})=>selected.has(cell.cellId));if(chosen.length!==1)return tableOperationError("拆分时只能选择一个合并单元格。"),false;const target=chosen[0],rowSpan=target.cell.rowSpan,colSpan=target.cell.colSpan;if(rowSpan===1&&colSpan===1)return tableOperationError("所选单元格尚未合并。"),false;const entries=placements.filter((item)=>item.cell!==target.cell);target.cell.rowSpan=1;target.cell.colSpan=1;entries.push(target);for(let row=target.rowIndex;row<target.rowIndex+rowSpan;row++)for(let column=target.columnIndex;column<target.columnIndex+colSpan;column++)if(row!==target.rowIndex||column!==target.columnIndex)entries.push({cell:newTableCell(model),rowIndex:row,columnIndex:column});model.rows=Array.from({length:model.rows.length},(_,rowIndex)=>entries.filter((item)=>item.rowIndex===rowIndex).sort((left,right)=>left.columnIndex-right.columnIndex).map((item)=>item.cell));selected.clear();selected.add(target.cell.cellId);return true}
function bindTableEditor(chunk,reviewedType){
  $("#reviewedType").onchange=()=>{const type=$("#reviewedType").value;if(type==="table")return;delete chunk.tableEditorDraft;saveReviewedModel(chunk,type,chunk.finalText)};
  if(!$("#saveTableEditor"))return;
  chunk.tableSelectedCellIds??=new Set();const selected=chunk.tableSelectedCellIds,base=chunk.tableEditorDraft??chunk.reviewedModel??tableModelFromChunk(chunk),update=(change)=>{const model=tableModelFromEditor(base);if(change(model)===false)return;chunk.tableEditorDraft=model;renderDetail()};
  $$('[data-table-cell-select]').forEach((input)=>{input.checked=selected.has(input.dataset.tableCellSelect);input.onchange=()=>input.checked?selected.add(input.dataset.tableCellSelect):selected.delete(input.dataset.tableCellSelect)});
  const positionOperation=(operation)=>update((model)=>{const error=operation(model,selected);if(error)return tableOperationError(error),false});
  $("#addTableRowBefore").onclick=()=>positionOperation((model,selection)=>insertTableRow(model,selection,"before",newTableCell));
  $("#addTableRowAfter").onclick=()=>positionOperation((model,selection)=>insertTableRow(model,selection,"after",newTableCell));
  $("#addTableColumnBefore").onclick=()=>positionOperation((model,selection)=>insertTableColumn(model,selection,"before",newTableCell));
  $("#addTableColumnAfter").onclick=()=>positionOperation((model,selection)=>insertTableColumn(model,selection,"after",newTableCell));
  $("#removeTableColumn").onclick=()=>{if(!confirm("删除选中单元格所在列及其中内容？"))return;positionOperation(removeSelectedTableColumn)};
  $$('[data-remove-table-row]').forEach((button)=>button.onclick=()=>{const rowIndex=Number(button.dataset.removeTableRow);if(!confirm(`删除第 ${rowIndex+1} 行及其中内容？`))return;update((model)=>{if(model.rows.length<=1)return tableOperationError("表格至少需要一行。"),false;if(model.rows.some((row)=>row.some((cell)=>cell.rowSpan>1)))return tableOperationError("表格包含跨行合并单元格。","请先拆分跨行单元格。"),false;const group=model.rowGroups.find((item)=>rowIndex>=item.rowStart&&rowIndex<item.rowStart+item.rowCount);if(group?.rowCount===1)return tableOperationError("每个来源行组至少保留一行。"),false;model.rows.splice(rowIndex,1);if(group)group.rowCount--;model.rowGroups.filter((item)=>item.rowStart>rowIndex).forEach((item)=>item.rowStart--)})});
  $("#mergeTableCells").onclick=()=>update((model)=>mergeSelectedTableCells(model,selected));$("#splitTableCell").onclick=()=>update((model)=>splitSelectedTableCell(model,selected));
  $("#saveTableEditor").onclick=()=>{const model=tableModelFromEditor(base);delete chunk.tableEditorDraft;delete chunk.tableSelectedCellIds;saveReviewedModel(chunk,"table","",model)}
}
function reviewedModelFromEditor(type,value){if(type==="table"){const model=JSON.parse(value);return{...model,type:"table"}}if(type==="heading")return{type,text:value,level:1};if(type==="list")return{type,ordered:false,items:value.split(/\r?\n/).map((item)=>item.replace(/^[-*]\s*/,"").trim()).filter(Boolean)};if(type==="image")return{type,imageId:"reviewed-image",caption:value};if(type==="formula")return{type,latex:value};if(type==="code")return{type,source:value};if(type==="warning")return{type,level:"warning",body:value};if(type==="caption"||type==="footnote"||type==="paragraph")return{type,text:value};return{type:"plain_text_repair",classification:"paragraph",text:value}}
function pushChunkHistory(file){file.chunkUndo=file.chunkUndo??[];file.chunkRedo=[];file.chunkUndo.push(structuredClone(file.reviewState.draft.chunks));if(file.chunkUndo.length>40)file.chunkUndo.shift()}
function recomputeManualChunk(chunk){chunk.tokenCount=Math.ceil((chunk.finalText??"").length/2);if(["confirmed","human_modified"].includes(chunk.contextReviewState)){chunk.contextReviewState="stale";chunk.contextStaleReason="Chunk 内容已修改"}}
function queueReviewedModelSave(chunk,type,value,modelOverride=null){const file=currentFile();if(!file)return Promise.resolve();const key=`${chunk.id}:${type}:${value}:${JSON.stringify(modelOverride)}`;if(file.reviewedSavePending?.key===key)return file.reviewedSavePending.promise;const previous=file.reviewedSavePending?.promise??Promise.resolve();const promise=previous.then(()=>{const chunks=file.reviewState.draft?.chunks??[],live=chunks.find((item)=>item.id===chunk.id)??chunks.find((item)=>item.replacedChunkId===chunk.id)??chunks.find((item)=>item.id===state.selectedChunkId)??chunk;return saveReviewedModel(live,type,value,modelOverride)}).finally(()=>{if(file.reviewedSavePending?.promise===promise)delete file.reviewedSavePending});file.reviewedSavePending={key,promise};return promise}
async function saveReviewedModel(chunk,type,value,modelOverride=null){const file=currentFile();if(!file)return;const reviewedModel=modelOverride??reviewedModelFromEditor(type,value),previousId=chunk.id,body={reviewedModel,...(reviewedModel.type==="table"?{expectedRevision:chunk.reviewRevision??0}:{})};try{$("#saveState").textContent="服务端重算中";const result=await api(`/api/batches/${state.batchId}/documents/${file.id}/chunks/${encodeURIComponent(chunk.id)}/reviewed-model`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});file.reviewState=result.reviewState;const chunks=file.reviewState.draft?.chunks??[],replacement=chunks.find((item)=>item.replacedChunkId===previousId);if(replacement){state.selectedChunkId=replacement.id;state.lockedChunkId=replacement.id;state.linkSelection=updateReviewLinkSelection(chunks,state.linkSelection,{kind:"chunk",id:replacement.id})}file.editingChunkId=null;invalidateExportSnapshot();$("#saveState").textContent="已保存并重算";renderAll()}catch(error){setError(error)}}
function restorePendingImageReview(reviewState,chunkId,pendingImageReview){const generatedChunk=reviewState?.draft?.chunks.find((candidate)=>candidate.id===chunkId);if(generatedChunk)generatedChunk.imageEditorDraft=pendingImageReview}
async function generateVlmSummary(chunk){const file=currentFile(),profileId=$("#vlmProfileSelect")?.value??state.selectedVlmProfileId;if(!file||!profileId)return;const draft=chunk.imageEditorDraft??{};const pendingImageReview={imagePolicy:$("#chunkImagePolicy")?.value??draft.imagePolicy??chunk.imagePolicy??"summary",relatedChunkIds:[...(draft.relatedChunkIds??chunk.relatedChunkIds??[])],humanSummary:$("#vlmReviewed")?.value??draft.humanSummary??chunk.vlmSummaryReviewed??"",humanSupplement:$("#vlmSupplement")?.value??draft.humanSupplement??chunk.vlmSummarySupplement??""};if(pendingImageReview.imagePolicy!=="summary")return setError({message:"仅“摘要 + 引用”策略可生成图片摘要。",impact:"未发送图片，也不会产生模型费用。",recovery:"请选择“摘要 + 引用”并保存后再生成。"});state.selectedVlmProfileId=profileId;localStorage.setItem("chunkLabVlmProfileId",profileId);state.vlmGeneratingIds.add(chunk.id);$("#saveState").textContent="图片摘要生成中";setError("");renderDetail();try{const result=await api(`/api/batches/${state.batchId}/documents/${file.id}/chunks/${encodeURIComponent(chunk.id)}/vlm-summary`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({profileId})});file.reviewState=result.reviewState;restorePendingImageReview(file.reviewState,chunk.id,pendingImageReview);invalidateExportSnapshot();$("#saveState").textContent="图片摘要待审核"}catch(error){try{const review=await api(`/api/batches/${state.batchId}/documents/${file.id}/review`);file.reviewState=review.reviewState;restorePendingImageReview(file.reviewState,chunk.id,pendingImageReview)}catch{}setError(error);$("#saveState").textContent="图片摘要生成失败"}finally{state.vlmGeneratingIds.delete(chunk.id);renderAll()}}
async function saveImageSummary(chunk){const file=currentFile();if(!file)return;const draft=chunk.imageEditorDraft??{};const imagePolicy=$("#chunkImagePolicy")?.value??draft.imagePolicy??chunk.imagePolicy??"summary",body={imagePolicy,humanSummary:imagePolicy==="reference"?"":$("#vlmReviewed")?.value??draft.humanSummary??chunk.vlmSummaryReviewed??"",humanSupplement:imagePolicy==="reference"?"":$("#vlmSupplement")?.value??draft.humanSupplement??chunk.vlmSummarySupplement??"",relatedChunkIds:[...(draft.relatedChunkIds??chunk.relatedChunkIds??[])]};if(body.imagePolicy==="reference"&&!body.relatedChunkIds.length){chunk.imagePolicyFeedback="请至少关联一个文字 Chunk";$("#imagePolicyFeedback").textContent=chunk.imagePolicyFeedback;return setError({code:"IMAGE_REFERENCE_REQUIRED",message:"仅引用图片必须关联至少一个有效文字 Chunk。",impact:"图片策略不会保存，图片也不会进入文本下游。",recovery:"请搜索并选择同一文档内至少一个文字 Chunk 后重试。"})}try{setError("");$("#saveState").textContent="正在保存图片策略到当前 Draft";chunk.imagePolicyFeedback="保存中...";$("#imagePolicyFeedback").textContent=chunk.imagePolicyFeedback;const result=await api(`/api/batches/${state.batchId}/documents/${file.id}/chunks/${encodeURIComponent(chunk.id)}/image-summary`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});file.reviewState=result.reviewState;const savedChunk=file.reviewState?.draft?.chunks?.find((candidate)=>candidate.id===chunk.id);if(savedChunk)savedChunk.imagePolicyFeedback="已保存到当前 Draft";file.editingChunkId=null;invalidateExportSnapshot();$("#saveState").textContent="图片策略已保存到当前 Draft";renderAll()}catch(error){chunk.imagePolicyFeedback="保存失败";$("#imagePolicyFeedback").textContent=chunk.imagePolicyFeedback;setError(error);$("#saveState").textContent="图片策略保存失败"}}

async function saveManualContext(chunkId, contextText) {
  const file = currentFile(); if (!file) return;
  try { const result = await api(`/api/batches/${state.batchId}/documents/${file.id}/context/${encodeURIComponent(chunkId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contextText }) }); file.reviewState = result.reviewState; invalidateExportSnapshot(); $("#saveState").textContent = "人工 Context 已保存"; renderAll(); }
  catch (error) { setError(error); }
}

async function confirmChunkContext(chunkId) {
  const file = currentFile(); if (!file) return;
  try { const result = await api(`/api/batches/${state.batchId}/documents/${file.id}/context/${encodeURIComponent(chunkId)}/confirm`, { method: "POST" }); file.reviewState = result.reviewState; invalidateExportSnapshot(); $("#saveState").textContent = "Context 已确认"; renderAll(); }
  catch (error) { setError(error); }
}

async function runReviewAction(command) {
  const file=currentFile();if(!file)return;
  const previousIds=new Set(file.reviewState.draft?.chunks.map((chunk)=>chunk.id)??[]),previousSelection=state.selectedChunkId,selectedSources=[...(state.linkSelection?.sourceIds??[])];
  try {
    $("#saveState").textContent="服务端重算中";
    const result=await api(`/api/batches/${state.batchId}/documents/${file.id}/review/actions`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(command)});
    file.reviewState=result.reviewState;invalidateExportSnapshot();
    const chunks=file.reviewState.draft?.chunks??[];
    if(command.type==="source-create")state.selectedChunkId=chunks.find((chunk)=>!previousIds.has(chunk.id))?.id??state.selectedChunkId;
    if(selectedSources.length){let selection=null;selectedSources.forEach((sourceId,index)=>{selection=updateReviewLinkSelection(chunks,selection,{kind:"source",id:sourceId},index>0)});state.linkSelection=selection;state.selectedChunkId=selection?.primaryChunkId??null;state.lockedChunkId=state.selectedChunkId}
    else if(previousSelection&&!chunks.some((chunk)=>chunk.id===previousSelection)){state.selectedChunkId=chunks.find((chunk)=>chunk.replacedChunkId===previousSelection)?.id??null;state.lockedChunkId=state.selectedChunkId}
    $("#saveState").textContent="已保存并重算";renderAll();
  }catch(error){setError(error)}
}

function splitSelectedChunk(cursor) {
  const file=currentFile(), chunks=file.reviewState.draft.chunks, index=chunks.findIndex((item)=>item.id===state.selectedChunkId), chunk=chunks[index];
  if(cursor<=0||cursor>=chunk.finalText.length)return setError("请把光标放在正文中间");
  if(chunk.finalText!==chunk.automaticText)return setError("人工改写后无法推导精确来源；请先恢复自动文本再拆分");
  runReviewAction({type:"split",chunkId:chunk.id,cursor});
}

function mergeNextChunk(){const file=currentFile(),chunks=file.reviewState.draft.chunks,index=chunks.findIndex((item)=>item.id===state.selectedChunkId),left=chunks[index],right=chunks[index+1];if(!right)return setError("没有下一块可合并");if((left.finalType??left.type)!==(right.finalType??right.type))return setError("只能合并相邻且同类型的 Chunk");runReviewAction({type:"merge-next",chunkId:left.id});}

function selectedBlocks(){const blocks=currentFile()?.sourceBlocks??[];return blocks.filter((block)=>state.selectedBlockIds.has(sourceBlockId(block)));}
$("#sourceToolbar").onclick=(event)=>{
  const tool=event.target.closest("[data-annotation-tool]");
  if(tool&&!tool.disabled){state.annotationTool=tool.dataset.annotationTool;state.crossPageCollecting=false;if(state.annotationTool==="watermark"){const page=state.currentPage,lastPage=documentLastPage(),from=Number(prompt("清理水印起始页（默认当前页）",String(page))),to=Number(prompt("清理水印结束页（默认文档最后一页）",String(lastPage)));if(!Number.isInteger(from)||!Number.isInteger(to)||from<1||to<from){state.annotationTool="select";return setError("页数范围无效");}state.watermarkRange=[from,Math.min(to,lastPage)];}renderSelectionToolbar();return}
  const annotationAction=event.target.closest("[data-annotation-action]");
  if(annotationAction&&!annotationAction.disabled){runAnnotationAction(annotationAction.dataset.annotationAction);return}
  const button=event.target.closest("[data-source-action]");if(button&&!button.disabled)sourceAction(button.dataset.sourceAction)
};
$("#annotationType").onchange=(event)=>{
  const file=currentFile(); if(!file||file.editable!==true||!state.selectedBlockIds.size)return;
  ensureAnnotations(file);
  const selected=[...state.selectedBlockIds], boxes=effectiveAnnotationBoxes(file), detections=boxes.filter((item)=>item.layer==="detection"&&selected.includes(item.id)), manual=selected.filter((id)=>boxes.some((item)=>item.id===id&&item.layer==="manual"));
  let next=file.annotationState;
  if(detections.length) next=reviseDetectionType(next,detections.map((item)=>item.id),event.target.value);
  if(manual.length) next=changeAnnotationType(next,manual,event.target.value);
  syncAnnotationState(file,next);
  if(detections.length){
    const revisions=next.annotations.filter((item)=>detections.some((detection)=>item.revisionOf===detection.id));
    state.selectedBlockIds=new Set([...manual,...revisions.map((item)=>item.id)]);
    state.lastSelectedBlockId=[...state.selectedBlockIds].at(-1)??null;
    state.lockedBlockId=state.lastSelectedBlockId;
    state.lockedSourceKey=state.lastSelectedBlockId?`manual:${state.lastSelectedBlockId}`:null;
  }
  queueAnnotationSave(file); renderAll();
};
function runAnnotationAction(action){
  const file=currentFile();if(!file)return;
  let regenerateMergedPage=false;
  const ids=[...state.selectedBlockIds];
  if(action==="exclude")syncAnnotationState(file,toggleAnnotationExclusion(file.annotationState,ids));
  else if(action==="delete"){syncAnnotationState(file,deleteAnnotations(file.annotationState,ids));clearAnnotationSelection();$("#saveState").textContent="已删除选中框"}
  else if(action==="merge"){
    const before=new Set(effectiveAnnotationBoxes(file).map((item)=>item.id));
    try {
        const selectedBefore=effectiveAnnotationBoxes(file).filter((item)=>ids.includes(item.id));
        const crossPage=new Set(selectedBefore.map((item)=>item.page)).size>1;
        const next=mergeAnnotations(file.annotationState,ids,{crossPage});
      syncAnnotationState(file,next);
      regenerateMergedPage=true;
      state.selectedBlockIds=new Set(effectiveAnnotationBoxes(file).filter((item)=>!before.has(item.id)).map((item)=>item.id));
      state.lastSelectedBlockId=[...state.selectedBlockIds].at(-1)??null;
      state.lockedBlockId=state.lastSelectedBlockId;
      state.lockedSourceKey=state.lockedBlockId?`manual:${state.lockedBlockId}`:null;
      state.crossPageCollecting=false;
      setError("");
       $("#saveState").textContent=crossPage?"跨页内容已合并":"选中框已合并";
    } catch(error) { setError(error); return; }
  }
  else if(action==="split"){
    const before=new Set(effectiveAnnotationBoxes(file).map((item)=>item.id));
    try {
      const next=splitAnnotations(file.annotationState,ids);
      syncAnnotationState(file,next);
      state.selectedBlockIds=new Set(effectiveAnnotationBoxes(file).filter((item)=>!before.has(item.id)).map((item)=>item.id));
      state.lastSelectedBlockId=[...state.selectedBlockIds].at(-1)??null;
      state.lockedBlockId=state.lastSelectedBlockId;
      const locked=effectiveAnnotationBoxes(file).find((item)=>item.id===state.lockedBlockId);
      state.lockedSourceKey=locked?`${locked.layer}:${locked.id}`:null;
      setError("");
      $("#saveState").textContent="已恢复拆分成员";
    } catch(error) { setError(error); return; }
  }
  else if(action==="undo"){syncAnnotationState(file,undoAnnotationChange(file.annotationState));clearAnnotationSelection()}
  else if(action==="redo"){syncAnnotationState(file,redoAnnotationChange(file.annotationState));clearAnnotationSelection()}
  else return;
  queueAnnotationSave(file);renderAll();
  if(regenerateMergedPage)void generateManualPreview("page");
}
function selectionIsDiscrete(blocks) {
  const sourceBlocks = currentFile()?.sourceBlocks ?? [];
  const indexes = blocks.map((block) => sourceBlocks.findIndex((candidate) => sourceBlockId(candidate) === sourceBlockId(block)));
  return indexes.some((index, position) => position && index !== indexes[position - 1] + 1);
}
async function sourceAction(action) {
  const file=currentFile(), blocks=selectedBlocks(), chunks=file.reviewState.draft.chunks;
  const target=chunks.find((chunk)=>chunk.id===state.selectedChunkId);
  if(!blocks.length)return;
  if(selectionIsDiscrete(blocks)&&!confirm(`离散来源将按阅读顺序处理：${blocks.map(sourceBlockId).join(" → ")}。继续吗？`))return;
  if(action!=="create"&&target?.finalText!==target?.automaticText&&!confirm("调整来源会按剩余原文重新组织当前正文，并保留 automaticText。继续吗？"))return;
  const type=action==="create"?"source-create":action==="add"?"source-add":"source-remove";
  await runReviewAction({type,...(type==="source-create"?{}:{chunkId:target?.id}),blockIds:blocks.map(sourceBlockId)});
}

function segmentSourceId(segment){return segment?.contentBlockId??segment?.blockId}
function sourceIdsForElement(element){const listed=String(element?.dataset?.sourceBlockIds??"").split(",").filter(Boolean);if(listed.length)return listed;return [element?.dataset?.sourceSegmentBlockId??element?.dataset?.blockId].filter(Boolean)}
function sourceIdsForBlock(blockId){const file=currentFile();ensureAnnotations(file);const item=effectiveAnnotationBoxes(file).find((candidate)=>candidate.id===blockId);return item?.sourceBlockIds?.length?[...item.sourceBlockIds]:[blockId]}
function missingSourceMessage(sourceIds){const file=currentFile();if(!file)return"所选来源暂无对应 Chunk";ensureAnnotations(file);const boxes=effectiveAnnotationBoxes(file);const manualOnly=sourceIds.length>0&&sourceIds.every((sourceId)=>boxes.some((item)=>item.layer==="manual"&&item.id===sourceId&&!(item.sourceBlockIds??[]).length));return manualOnly?"人工框尚未生成 Chunk":"所选来源暂无对应 Chunk"}
function elementMatchesSourceIds(element,selected){return sourceIdsForElement(element).some((sourceId)=>selected.has(sourceId))}
function highlightForChunk(chunkId,kind){const chunks=currentChunks(),linked=linkedTargetsForChunk(chunks,chunkId),ids=new Set(linked.sourceIds),className=kind==="hover"?"hover-linked":"locked-linked";$$('.source-block,[data-source-info-key],[data-source-segment-block-id]').forEach((el)=>el.classList.toggle(className,elementMatchesSourceIds(el,ids)));$$('[data-chunk-id]').forEach((el)=>el.classList.toggle(className,linked.chunkIds.includes(el.dataset.chunkId)));}
function highlightForBlock(blockId,kind){$$('[data-chunk-id]').forEach((el)=>{const chunk=currentChunks().find((item)=>item.id===el.dataset.chunkId);el.classList.toggle(kind==="hover"?"hover-linked":"locked-linked",chunk?.sourceSegments.some((segment)=>segmentSourceId(segment)===blockId));});}
function highlightForSourceIds(sourceIds,kind){sourceIds.forEach((sourceId)=>highlightForBlock(sourceId,kind))}
function highlightSourceKey(key,kind){if(!key)return;const className=kind==="hover"?"hover-linked":"locked-linked";$$('[data-source-key],[data-source-info-key]').filter((element)=>element.dataset.sourceKey===key||element.dataset.sourceInfoKey===key).forEach((element)=>element.classList.add(className));}
function selectSourceInfo(key,event={}){const item=sourceInfoItem(key);if(!item)return;selectSourceBlock(item.id,event);state.currentPage=item.page;renderPages();renderChunks();renderSelectionToolbar();scrollInsideSource(document.querySelector(`[data-source-key="${CSS.escape(key)}"]`));}
function clearHover(){$$('.hover-linked').forEach((el)=>el.classList.remove('hover-linked'));}
function applyHighlights(){clearHover();const linkedSources=new Set(state.linkSelection?.sourceIds??[]),linkedChunks=new Set(state.linkSelection?.chunkIds??[]);$$('.chunk-card').forEach((el)=>el.classList.toggle('locked-linked',linkedChunks.has(el.dataset.chunkId)));$$('.source-block,[data-source-info-key],[data-source-segment-block-id]').forEach((el)=>{el.classList.toggle('selected-source',elementMatchesSourceIds(el,linkedSources)||state.selectedBlockIds.has(el.dataset.blockId));el.classList.toggle('locked-linked',elementMatchesSourceIds(el,linkedSources));el.classList.remove('overlap-linked')});if(state.lockedSourceKey)highlightSourceKey(state.lockedSourceKey,'locked');const chunk=currentChunks().find((item)=>item.id===state.linkSelection?.primaryChunkId);const linkedPages=new Set(chunk?.sourceSegments.map((segment)=>segment.page));$$('[data-page-target]').forEach((el)=>el.classList.toggle('marked',linkedPages.has(Number(el.dataset.pageTarget))));if(chunk)for(const segment of chunk.sourceSegments){if(!segment.isOverlap)continue;const id=segmentSourceId(segment);$$('.source-block,[data-source-info-key],[data-source-segment-block-id]').filter((el)=>sourceIdsForElement(el).includes(id)).forEach((el)=>el.classList.add('overlap-linked'))}}
function syncAnnotationSelectionFromLinks(){const file=currentFile();ensureAnnotations(file);const selected=new Set(state.linkSelection?.sourceIds??[]),boxes=effectiveAnnotationBoxes(file).filter((item)=>(item.sourceBlockIds?.length?item.sourceBlockIds:[item.id]).some((id)=>selected.has(id)));state.selectedBlockIds=new Set(boxes.map((item)=>item.id));state.lastSelectedBlockId=boxes.at(-1)?.id??null;state.lockedBlockId=state.lastSelectedBlockId;state.lockedSourceKey=boxes.length?`${boxes.at(-1).layer??"manual"}:${boxes.at(-1).id}`:null}
function scrollPrimaryChunk(){const id=state.linkSelection?.primaryChunkId;if(!id)return;scrollReviewTargetIntoView(document.querySelector(`[data-chunk-id="${CSS.escape(id)}"]`))}
function selectLinkedSourceIds(sourceIds,event={}){const additive=Boolean(event.ctrlKey||event.metaKey);let selection=additive?state.linkSelection:null;sourceIds.forEach((sourceId,index)=>{selection=updateReviewLinkSelection(currentChunks(),selection,{kind:"source",id:sourceId},additive||index>0)});state.linkSelection=selection;state.selectedChunkId=selection?.primaryChunkId??null;state.lockedChunkId=selection?.primaryChunkId??null;renderChunks();applyHighlights();if(selection?.primaryChunkId)scrollPrimaryChunk();else if(selection?.missingSourceIds?.length)$("#saveState").textContent=missingSourceMessage(selection.missingSourceIds)}
function selectLinkedChunk(chunkId,event={}){state.linkSelection=updateReviewLinkSelection(currentChunks(),state.linkSelection,{kind:"chunk",id:chunkId},Boolean(event.ctrlKey||event.metaKey));state.selectedChunkId=state.linkSelection.primaryChunkId;state.lockedChunkId=state.linkSelection.primaryChunkId;state.lockedBlockId=null;syncAnnotationSelectionFromLinks();renderChunks();applyHighlights();renderSelectionToolbar();if(state.linkSelection.primaryChunkId)scrollFirstSource()}
function findSourceElement(sourceId){return $$('.source-block').find((element)=>sourceIdsForElement(element).includes(sourceId))}
function scrollSourceIds(sourceIds){const file=currentFile(),chunk=currentChunks().find((item)=>item.id===state.linkSelection?.primaryChunkId),segment=chunk?.sourceSegments.find((item)=>sourceIds.includes(segmentSourceId(item))),box=effectiveAnnotationBoxes(file).find((item)=>sourceIds.some((sourceId)=>sourceId===item.id||(item.sourceBlockIds??[]).includes(sourceId))),page=box?.page??segment?.page;if(page&&page!==state.currentPage){state.currentPage=page;renderPages()}scrollInsideSource(sourceIds.map(findSourceElement).find(Boolean))}
function scrollFirstSource(){const chunk=currentChunks().find((item)=>item.id===state.linkSelection?.primaryChunkId),segment=chunk?.sourceSegments[0],id=segmentSourceId(segment);if(segment?.page&&!findSourceElement(id)){state.currentPage=segment.page;renderPages()}scrollInsideSource(findSourceElement(id));}
function clearSourceLock(){clearAnnotationSelection();applyHighlights();renderSelectionToolbar();if(currentFile())renderChunks();}
$("#clearSelection").onclick=clearSourceLock;document.addEventListener('keydown',(event)=>{
  if(event.key==='Escape')return clearSourceLock();
  if(state.strategy!=="manual"||!currentFile())return;
  const modifier=event.ctrlKey||event.metaKey;
  if(event.key==="Delete"&&state.selectedBlockIds.size){event.preventDefault();runAnnotationAction("delete");}
  else if(modifier&&event.key.toLowerCase()==="z"){event.preventDefault();runAnnotationAction(event.shiftKey?"redo":"undo");}
  else if(modifier&&event.key.toLowerCase()==="y"){event.preventDefault();runAnnotationAction("redo");}
});

function invalidateExportSnapshot(){state.exportSnapshot=null;}
function downloadJson(payload, filename){const link=document.createElement("a");link.href=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:"application/json"}));link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);}
async function exportPayload(){const contractVersion=$("#exportContract").value,file=currentFile();const key=`${state.batchId}:${contractVersion}`;if(state.exportSnapshot?.key===key)return state.exportSnapshot.payload;if(file?.manualPrototype){const payload={batchId:state.batchId,exportedAt:new Date().toISOString(),contractVersion,format:"prototype",manifest:[{documentId:file.id,state:"completed",chunkCount:file.reviewState.draft?.chunks.length??0}],documents:[{documentId:file.id,name:file.name,chunks:file.reviewState.draft?.chunks??[]}],prototype:true};state.exportSnapshot={key,payload};return payload}const payload=await api(`/api/batches/${state.batchId}/export?contractVersion=${encodeURIComponent(contractVersion)}`);state.exportSnapshot={key,payload};return payload;}
$("#exportContract").onchange=invalidateExportSnapshot;
$("#exportButton").onclick=async()=>{try{const payload=await exportPayload();downloadJson(payload,`chunk-lab-${$("#exportContract").value}-export.json`);}catch(error){setError(error);}};
$("#manifestButton").onclick=async()=>{try{const payload=await exportPayload();downloadJson({batchId:payload.batchId,exportedAt:payload.exportedAt,contractVersion:payload.contractVersion,format:payload.format,manifest:payload.manifest},`chunk-lab-${$("#exportContract").value}-manifest.json`);}catch(error){setError(error);}};
async function downloadDiagnosticPackage(file,button){if(!file||!button)return;const status=button.parentElement?.querySelector(".diagnostic-status"),setStatus=(value)=>{if(status)status.textContent=value};button.disabled=true;setStatus("生成中");if(file.manualPrototype){downloadJson({prototype:true,documentId:file.id,issue:diagnosticIssue(file),generatedAt:new Date().toISOString()},`chunk-lab-${file.id}-prototype-diagnostic.json`);setStatus("已生成");button.disabled=false;return}try{const created=await api(`/api/batches/${state.batchId}/documents/${file.id}/diagnostic-package`,{method:"POST"});const diagnostic=await api(created.downloadUrl);downloadJson(diagnostic,`chunk-lab-${file.id}-diagnostic.json`);setStatus("已下载");}catch(error){setStatus("生成失败");setError(error);}finally{button.disabled=false;}}

async function api(path, init = {}, retryLease = true) {
  const headers = new Headers(init.headers || {});
  headers.set("x-user-id", state.userId); headers.set("x-session-id", state.sessionId);
  const match = path.match(/^\/api\/batches\/([^/]+)\/documents\/([^/?]+)/);
  const file = match?.[1] === state.batchId ? state.files.find(item => item.id === match[2]) : null;
  if (file?.leaseId) headers.set("x-document-lease-id", file.leaseId);
  const response = await fetch(path, { ...init, headers });
  const result = await response.json();
  if (!response.ok) {
    if (retryLease && response.status === 423 && !path.includes("/lease") &&
        ["DOCUMENT_LEASE_REQUIRED", "DOCUMENT_LEASE_EXPIRED"].includes(result.code) && file) {
      const lease = await api(`/api/batches/${match[1]}/documents/${file.id}/lease`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
      }, false);
      file.leaseId = lease.leaseId; file.editable = lease.editable === true;
      return api(path, init, false);
    }
    throw Object.assign(new Error(result.error || `HTTP ${response.status}`), result);
  }
  return result;
}

async function renewDocumentLease(file){try{const result=await api(`/api/batches/${state.batchId}/documents/${file.id}/lease/renew`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({leaseId:file.leaseId})},false);file.leaseTtlSeconds=result.ttlSeconds;file.leaseRecoveryPending=false}catch(error){if(!["DOCUMENT_LEASE_EXPIRED","DOCUMENT_LEASE_REQUIRED"].includes(error?.code))throw error;file.leaseRecoveryPending=true;const lease=await api(`/api/batches/${state.batchId}/documents/${file.id}/lease`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"},false);file.leaseId=lease.leaseId;file.leaseTtlSeconds=lease.ttlSeconds;file.editable=lease.editable===true;file.leaseRecoveryPending=false;setError("");$("#saveState").textContent="编辑租约已恢复";renderAll()}}
setInterval(async()=>{const file=currentFile();if(!file?.leaseId||!state.batchId||(file.editable!==true&&file.leaseRecoveryPending!==true))return;try{await renewDocumentLease(file)}catch(error){file.editable=false;file.leaseRecoveryPending=error?.code!=="DOCUMENT_LEASE_UNAVAILABLE";setError(error);renderAll()}},15000);
window.addEventListener("beforeunload",()=>{const file=currentFile();if(!file?.leaseId||!state.batchId)return;fetch(`/api/batches/${state.batchId}/documents/${file.id}/lease`,{method:"DELETE",keepalive:true,headers:{"Content-Type":"application/json","x-user-id":state.userId,"x-session-id":state.sessionId},body:JSON.stringify({leaseId:file.leaseId})}).catch(()=>{});});
function setError(value){const box=$("#batchError");if(!value){box.replaceChildren();box.classList.add("hidden");return}const presentation=formatUserFacingError(value);box.innerHTML=`<span><strong>原因：</strong>${escapeHtml(presentation.reason)}</span><span><strong>影响：</strong>${escapeHtml(presentation.impact)}</span><span><strong>下一步：</strong>${escapeHtml(presentation.next)}</span>`;box.classList.remove("hidden");box.focus();}
function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,(char)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);}
async function restoreRecentBatch() {
  const batchId = new URLSearchParams(location.search).get("batchId")?.trim()
    || localStorage.getItem("chunkLabRecentBatchId");
  if (!batchId) return;
  try { applyBatch(await api(`/api/batches/${encodeURIComponent(batchId)}`)); }
  catch { localStorage.removeItem("chunkLabRecentBatchId"); }
}
function renderExistingSpuMatchesUi(){const categoryId=$("#spuExistingCategory")?.value,name=$("#spuExistingName")?.value.trim()??"",model=$("#spuExistingModel")?.value.trim()??"",box=$("#spuExistingMatches");if(!box)return;if(!categoryId){box.innerHTML='<div class="empty">先选择商品大类</div>';return}api(`/api/spus?categoryId=${encodeURIComponent(categoryId)}&query=${encodeURIComponent(name||model)}&limit=20`).then((result)=>{const matches=(result.spus??[]).filter((spu)=>!model||String(spu.modelSeries??"").toLocaleLowerCase().includes(model.toLocaleLowerCase()));box.innerHTML=matches.length?matches.map((spu)=>`<div class="spu-match"><span><strong>${escapeHtml(spu.productName)}</strong> · ${escapeHtml(spu.spuId)}</span><button class="ghost-button" type="button" data-existing-spu="${escapeHtml(spu.spuId)}">加入已选</button><small>${escapeHtml([spu.categoryName,spu.brand,spu.modelSeries].filter(Boolean).join(" · ")||"已有 SPU")}</small></div>`).join(""):'<div class="empty">未找到已有 SPU</div>';$$('[data-existing-spu]').forEach((button)=>button.onclick=()=>{const spu=matches.find((item)=>item.spuId===button.dataset.existingSpu);if(spu)addSelectedSpu(spu)})}).catch(setError)}
function setSpuAssignmentModeUi(mode){const existing=mode==="existing";$("#existingSpuFields")?.classList.toggle("hidden",!existing);$("#newSpuFields")?.classList.toggle("hidden",existing);$("#selectExistingSpuMode")?.classList.toggle("active",existing);$("#createNewSpuMode")?.classList.toggle("active",!existing);$("#selectExistingSpuMode")?.setAttribute("aria-selected",String(existing));$("#createNewSpuMode")?.setAttribute("aria-selected",String(!existing))}
$("#selectExistingSpuMode")?.addEventListener("click",()=>setSpuAssignmentModeUi("existing"));
$("#createNewSpuMode")?.addEventListener("click",()=>setSpuAssignmentModeUi("new"));
$("#spuExistingCategory")?.addEventListener("change",renderExistingSpuMatchesUi);
for(const selector of ["#spuExistingName","#spuExistingModel"])$(selector)?.addEventListener("input",()=>{clearTimeout(window.__spuExistingTimer);window.__spuExistingTimer=setTimeout(renderExistingSpuMatchesUi,220)});
async function loadAgenticRetrievalConfig(){try{const result=await api("/api/agentic-retrieval-config");const url=String(result.agenticRetrievalUiUrl??"").trim();state.agenticRetrievalUiUrl=/^https?:\/\/[^?#]+$/i.test(url)?url:""}catch{state.agenticRetrievalUiUrl=""}renderPostActions()}
async function bootstrap(){loadBatchHistory();await loadModelProfiles();await loadAgenticRetrievalConfig();renderFiles();renderParams();await restoreRecentBatch();}
bootstrap();
