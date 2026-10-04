import assert from "node:assert/strict";
import {
  addAnnotation,
  applyAnnotationExclusionPolicy,
  annotationLabelForSize,
  annotationIdsInBox,
  changeAnnotationType,
  createAnnotationState,
  deleteAnnotations,
  denormalizeBox,
  effectiveAnnotations,
  mergeAnnotations,
  normalizeBox,
  redoAnnotationChange,
  reviseDetectionType,
  splitAnnotations,
  toggleAnnotationExclusion,
  updateAnnotationSelection,
  undoAnnotationChange,
  type AnnotationType,
  type MineruDetection,
} from "../manual-annotations.js";

const exclusionPolicy = applyAnnotationExclusionPolicy([
  { id: "numeric", sourceBlockIds: ["numeric"], page: 1, bbox: [0.45, 0.94, 0.55, 0.98], type: "text", text: "12", excluded: false, readingOrder: 10, layer: "detection" },
  { id: "roman", sourceBlockIds: ["roman"], page: 2, bbox: [0.45, 0.94, 0.55, 0.98], type: "text", text: "xiv", excluded: false, readingOrder: 20, layer: "detection" },
  { id: "page-label", sourceBlockIds: ["page-label"], page: 3, bbox: [0.4, 0.94, 0.6, 0.98], type: "text", text: "第 3 页 / 共 20 页", excluded: false, readingOrder: 30, layer: "detection" },
  { id: "header-1", sourceBlockIds: ["header-1"], page: 1, bbox: [0.1, 0.02, 0.4, 0.05], type: "text", text: "客户服务中心", excluded: false, readingOrder: 1, layer: "detection" },
  { id: "header-2", sourceBlockIds: ["header-2"], page: 2, bbox: [0.1, 0.021, 0.4, 0.051], type: "text", text: "客户服务中心", excluded: false, readingOrder: 11, layer: "detection" },
  { id: "model", sourceBlockIds: ["model"], page: 1, bbox: [0.1, 0.03, 0.4, 0.06], type: "heading", text: "A1 Pro 型号", excluded: false, readingOrder: 2, layer: "detection" },
  { id: "legal", sourceBlockIds: ["legal"], page: 2, bbox: [0.1, 0.93, 0.7, 0.97], type: "text", text: "未经许可不得复制", excluded: false, readingOrder: 19, layer: "detection" },
]);
assert.equal(exclusionPolicy.find((item) => item.id === "numeric")?.excluded, true);
assert.equal(exclusionPolicy.find((item) => item.id === "roman")?.excluded, true);
assert.equal(exclusionPolicy.find((item) => item.id === "page-label")?.excluded, true);
assert.equal(exclusionPolicy.find((item) => item.id === "header-1")?.excluded, false);
assert.equal(exclusionPolicy.find((item) => item.id === "header-1")?.exclusionSuggested, true);
assert.equal(exclusionPolicy.find((item) => item.id === "model")?.exclusionSuggested, false);
assert.equal(exclusionPolicy.find((item) => item.id === "legal")?.exclusionSuggested, false);
let exclusionState = createAnnotationState([], exclusionPolicy);
exclusionState = toggleAnnotationExclusion(exclusionState, ["numeric"]);
assert.equal(
  effectiveAnnotations(exclusionState).find((item) => item.id === "numeric")?.excluded,
  false,
  "an automatically excluded page number can be restored from the review layer",
);
exclusionState = toggleAnnotationExclusion(exclusionState, ["numeric"]);
assert.equal(
  effectiveAnnotations(exclusionState).find((item) => item.id === "numeric")?.excluded,
  true,
  "restoring a page number can be toggled back without changing Parsed Document",
);

const types: AnnotationType[] = [
  "text", "heading", "table", "image", "list", "formula", "code", "warning", "caption",
];

let selection = updateAnnotationSelection({
  selectedIds: ["mineru-a", "mineru-b"],
  lastSelectedId: "mineru-b",
  lockedBlockId: "mineru-b",
}, "mineru-b", { toggle: true });
assert.deepEqual(selection, {
  selectedIds: ["mineru-a"],
  lastSelectedId: "mineru-a",
  lockedBlockId: "mineru-a",
}, "Ctrl/Meta clicking the locked selected box removes it and locks the remaining last box");
selection = updateAnnotationSelection(selection, "mineru-a", { toggle: true });
assert.deepEqual(selection, {
  selectedIds: [],
  lastSelectedId: null,
  lockedBlockId: null,
}, "Ctrl/Meta clicking the final selected box clears selection and locking");

let state = createAnnotationState();
assert.deepEqual(state.annotations, [], "the manual layer starts empty");

const normalized = normalizeBox({ x: 100, y: 80 }, { x: 500, y: 280 }, 1000, 800);
assert.deepEqual(normalized, [0.1, 0.1, 0.5, 0.35]);
assert.deepEqual(denormalizeBox(normalized, 1000, 800), [100, 80, 500, 280]);
assert.deepEqual(denormalizeBox(normalized, 2000, 1600), [200, 160, 1000, 560], "zoom changes pixels, not relative position");

const boxCandidates = [
  { id: "inside", page: 1, bbox: [0.2, 0.2, 0.3, 0.3] },
  { id: "partial", page: 1, bbox: [0.05, 0.2, 0.2, 0.3] },
  { id: "outside", page: 1, bbox: [0.7, 0.7, 0.8, 0.8] },
  { id: "other-page", page: 2, bbox: [0.2, 0.2, 0.3, 0.3] },
  { id: "other-page-jitter", page: 2, bbox: [0.092, 0.092, 0.408, 0.408] },
];
assert.deepEqual(annotationIdsInBox(boxCandidates, [0.1, 0.1, 0.4, 0.4], { pages: [1], fullyContained: false }), ["inside", "partial"], "batch selection includes intersecting Blocks on the selected page");
assert.deepEqual(annotationIdsInBox(boxCandidates, [0.1, 0.1, 0.4, 0.4], { pages: [1, 2], fullyContained: true }), ["inside", "other-page"], "watermark cleanup deletes only fully contained Blocks in the page range");
assert.deepEqual(
  annotationIdsInBox(boxCandidates, [0.1, 0.1, 0.4, 0.4], { pages: [1, 2], fullyContained: true, containmentTolerance: 0.01 }),
  ["inside", "other-page", "other-page-jitter"],
  "cross-page watermark cleanup tolerates small layout-detection drift without selecting distant content",
);

assert.equal(annotationLabelForSize("page_number", 120, 24).label, "页码", "page_number uses the 页码 label");
assert.equal(annotationLabelForSize("heading", 180, 24).mode, "full", "wide boxes use the full type name");
assert.equal(annotationLabelForSize("heading", 48, 18).mode, "short", "narrow boxes use the short type name");
assert.equal(annotationLabelForSize("heading", 12, 12).mode, "icon", "tiny boxes use an icon label");
assert.equal(annotationLabelForSize("heading", 12, 12).tooltip, "标题", "tiny labels retain the full type in the tooltip");

state = addAnnotation(state, { id: "a-1", page: 1, bbox: normalized });
assert.equal(state.annotations[0]?.type, "text", "draw defaults to text");
for (const type of types) {
  state = changeAnnotationType(state, ["a-1"], type);
  assert.equal(state.annotations[0]?.type, type);
}

state = toggleAnnotationExclusion(state, ["a-1"]);
assert.equal(state.annotations.length, 1, "exclude preserves the annotation");
assert.equal(state.annotations[0]?.excluded, true);

state = deleteAnnotations(state, ["a-1"]);
assert.deepEqual(state.annotations, [], "delete removes the annotation");
state = undoAnnotationChange(state);
assert.equal(state.annotations[0]?.excluded, true, "undo restores the exact deleted state");
state = redoAnnotationChange(state);
assert.deepEqual(state.annotations, [], "redo reapplies deletion");

assert.throws(
  () => addAnnotation(state, { id: "bad", page: 1, bbox: [-0.1, 0, 0.2, 0.2] }),
  /normalized bbox/,
);

let drawnOrderState = addAnnotation(createAnnotationState(), { id: "drawn-z", page: 1, bbox: [0.1, 0.1, 0.2, 0.2] });
drawnOrderState = addAnnotation(drawnOrderState, { id: "drawn-a", page: 1, bbox: [0.1, 0.3, 0.2, 0.4] });
assert.deepEqual(effectiveAnnotations(drawnOrderState).map((item) => item.id), ["drawn-z", "drawn-a"], "manual boxes keep drawing order instead of UUID order");

let mergeState = createAnnotationState([
  { id: "same-a", page: 1, bbox: [0.1, 0.1, 0.3, 0.3], type: "text", excluded: false, readingOrder: 2 },
  { id: "same-b", page: 1, bbox: [0.25, 0.2, 0.5, 0.4], type: "heading", excluded: false, readingOrder: 3 },
  { id: "page-two", page: 2, bbox: [0.2, 0.1, 0.4, 0.25], type: "text", excluded: false, readingOrder: 4 },
]);
mergeState = mergeAnnotations(mergeState, ["same-a", "same-b"]);
assert.equal(mergeState.annotations.length, 2, "same-page merge replaces old boxes");
assert.deepEqual(mergeState.annotations[0]?.bbox, [0.1, 0.1, 0.5, 0.4], "same-page range expands");
assert.deepEqual(mergeState.annotations.map((item) => item.id), [mergeState.annotations[0]?.id, "page-two"]);
assert.equal(mergeState.annotations[0]?.type, "text", "compatible text types normalize to text");

mergeState = createAnnotationState([
  { id: "text-p1", page: 1, bbox: [0.1, 0.1, 0.3, 0.3], type: "text", excluded: false, readingOrder: 1 },
  { id: "text-p2", page: 2, bbox: [0.2, 0.2, 0.4, 0.4], type: "text", excluded: false, readingOrder: 2 },
]);
mergeState = mergeAnnotations(mergeState, ["text-p1", "text-p2"], { crossPage: true });
assert.equal(mergeState.annotations.length, 2, "cross-page merge keeps one region per page");
assert.equal(new Set(mergeState.annotations.map((item) => item.logicalGroupId)).size, 1, "cross-page regions share one logical group");
assert.deepEqual(mergeState.annotations.map((item) => item.page), [1, 2], "cross-page order follows source pages");
const mergedGroupId = mergeState.annotations[0]!.logicalGroupId;
mergeState = splitAnnotations(mergeState, mergeState.annotations.map((item) => item.id));
assert.deepEqual(mergeState.annotations.map((item) => item.id), ["text-p1", "text-p2"], "split restores members and order");
assert.equal(mergeState.annotations.some((item) => item.logicalGroupId === mergedGroupId), false, "split removes logical group replacement");

let renumberState = createAnnotationState([
  { id: "renumber-p1", page: 1, bbox: [0.1, 0.1, 0.2, 0.2], type: "table", excluded: false, readingOrder: 1 },
  { id: "renumber-p2", page: 2, bbox: [0.1, 0.1, 0.2, 0.2], type: "table", excluded: false, readingOrder: 2 },
  { id: "renumber-p3", page: 3, bbox: [0.1, 0.1, 0.2, 0.2], type: "table", excluded: false, readingOrder: 3 },
  { id: "renumber-p4", page: 4, bbox: [0.1, 0.1, 0.2, 0.2], type: "table", excluded: false, readingOrder: 4 },
]);
renumberState = mergeAnnotations(renumberState, ["renumber-p1", "renumber-p2"], { crossPage: true, groupId: "renumber-first" });
renumberState = mergeAnnotations(renumberState, ["renumber-p3", "renumber-p4"], { crossPage: true, groupId: "renumber-second" });
assert.deepEqual(new Set(renumberState.annotations.map((item) => item.logicalGroupNumber)), new Set([1, 2]), "active logical groups start at one");
const firstRenumberGroup = renumberState.annotations.filter((item) => item.logicalGroupId === "renumber-first").map((item) => item.id);
renumberState = splitAnnotations(renumberState, firstRenumberGroup);
assert.equal(renumberState.annotations.filter((item) => item.logicalGroupId === "renumber-second").every((item) => item.logicalGroupNumber === 1), true, "splitting a group compacts the remaining group number");
renumberState = mergeAnnotations(renumberState, ["renumber-p1", "renumber-p2"], { crossPage: true, groupId: "renumber-third" });
assert.equal(renumberState.annotations.filter((item) => item.logicalGroupId === "renumber-third").every((item) => item.logicalGroupNumber === 1), true, "re-merging after split reuses the first available group number");
assert.equal(renumberState.annotations.filter((item) => item.logicalGroupId === "renumber-second").every((item) => item.logicalGroupNumber === 2), true, "later active groups remain consecutively numbered");

assert.throws(
  () => mergeAnnotations(createAnnotationState([
    { id: "text", page: 1, bbox: [0, 0, 0.2, 0.2], type: "text", excluded: false },
    { id: "table", page: 1, bbox: [0.3, 0, 0.5, 0.2], type: "table", excluded: false },
  ]), ["text", "table"]),
  /不兼容类型|compatible/i,
  "incompatible types are explicitly blocked",
);

mergeState = createAnnotationState([
  { id: "group-a", page: 1, bbox: [0.1, 0.1, 0.2, 0.2], type: "text", excluded: false, logicalGroupId: "g" },
  { id: "group-b", page: 2, bbox: [0.1, 0.1, 0.2, 0.2], type: "text", excluded: false, logicalGroupId: "g" },
]);
mergeState = deleteAnnotations(mergeState, ["group-a"]);
assert.equal(mergeState.annotations[0]?.logicalGroupId, undefined, "deleting the last group member clears group metadata");

let tableState = createAnnotationState([
  { id: "table-p1", page: 1, bbox: [0.1, 0.1, 0.8, 0.4], type: "table", excluded: false, readingOrder: 1 },
  { id: "table-p2", page: 2, bbox: [0.1, 0.2, 0.8, 0.5], type: "table", excluded: false, readingOrder: 2 },
]);
tableState = mergeAnnotations(tableState, ["table-p1", "table-p2"], { crossPage: true });
assert.equal(tableState.annotations.every((item) => item.type === "table"), true, "cross-page tables retain table type");
assert.throws(
  () => mergeAnnotations(tableState, [tableState.annotations[0]!.id, tableState.annotations[0]!.id]),
  /至少选择两个框/,
  "duplicate member ids do not count as two members",
);

let historyState = createAnnotationState([
  { id: "history-p1", page: 1, bbox: [0.1, 0.1, 0.2, 0.2], type: "text", excluded: false, readingOrder: 1 },
  { id: "history-p2", page: 2, bbox: [0.1, 0.1, 0.2, 0.2], type: "text", excluded: false, readingOrder: 2 },
]);
historyState = mergeAnnotations(historyState, ["history-p1", "history-p2"], { crossPage: true });
const historyMergedIds = historyState.annotations.map((item) => item.id);
historyState = undoAnnotationChange(historyState);
assert.deepEqual(historyState.annotations.map((item) => item.id), ["history-p1", "history-p2"], "undo restores pre-merge members");
historyState = redoAnnotationChange(historyState);
assert.deepEqual(historyState.annotations.map((item) => item.id), historyMergedIds, "redo restores merged regions");
historyState = splitAnnotations(historyState, historyMergedIds);
historyState = undoAnnotationChange(historyState);
assert.deepEqual(historyState.annotations.map((item) => item.id), historyMergedIds, "undo restores the logical group after split");
historyState = redoAnnotationChange(historyState);
assert.deepEqual(historyState.annotations.map((item) => item.id), ["history-p1", "history-p2"], "redo reapplies split");

let deleteGroupState = createAnnotationState([
  { id: "member-p1", page: 1, bbox: [0.1, 0.1, 0.2, 0.2], type: "text", excluded: false, readingOrder: 1 },
  { id: "member-p2", page: 2, bbox: [0.1, 0.1, 0.2, 0.2], type: "text", excluded: false, readingOrder: 2 },
  { id: "member-p3", page: 3, bbox: [0.1, 0.1, 0.2, 0.2], type: "text", excluded: false, readingOrder: 3 },
]);
deleteGroupState = mergeAnnotations(deleteGroupState, ["member-p1", "member-p2", "member-p3"], { crossPage: true });
const deletedRegionId = deleteGroupState.annotations.find((item) => item.page === 2)!.id;
deleteGroupState = deleteAnnotations(deleteGroupState, [deletedRegionId]);
assert.deepEqual(deleteGroupState.annotations.map((item) => item.page), [1, 3], "delete removes only the selected group region");
assert.deepEqual(deleteGroupState.annotations[0]?.groupMembers?.map((item) => item.page), [1, 3], "remaining group snapshot removes deleted page members");
deleteGroupState = undoAnnotationChange(deleteGroupState);
assert.deepEqual(deleteGroupState.annotations.map((item) => item.page), [1, 2, 3], "undo restores a deleted group member");

const mineruBaseline: MineruDetection[] = [
  { id: "mineru-a", sourceBlockIds: ["mineru-a"], page: 1, bbox: [0.1, 0.1, 0.3, 0.2], type: "text", excluded: false, readingOrder: 1, layer: "detection" },
  { id: "mineru-b", sourceBlockIds: ["mineru-b"], page: 1, bbox: [0.1, 0.25, 0.3, 0.4], type: "text", excluded: false, readingOrder: 2, layer: "detection" },
];
const mineruBaselineBefore = structuredClone(mineruBaseline);
let revisionState = createAnnotationState([], mineruBaseline);
const mineruInputBeforeTypeRevision = structuredClone(mineruBaseline);
revisionState = reviseDetectionType(revisionState, ["mineru-a"], "image");
assert.deepEqual(mineruBaseline, mineruInputBeforeTypeRevision, "type revision keeps MinerU detections immutable");
assert.deepEqual(revisionState.annotations[0]?.sourceBlockIds, ["mineru-a"], "type revision retains every original Source Block ID");
assert.equal(revisionState.annotations[0]?.type, "image", "MinerU text can be revised to image");
assert.equal(effectiveAnnotations(revisionState).find((item) => item.id === "mineru-a"), undefined, "the original detection is replaced in the effective layer");
revisionState = undoAnnotationChange(revisionState);
assert.equal(effectiveAnnotations(revisionState).find((item) => item.id === "mineru-a")?.type, "text", "undo restores the original detection type");
revisionState = redoAnnotationChange(revisionState);
assert.equal(effectiveAnnotations(revisionState).find((item) => item.sourceBlockIds?.includes("mineru-a"))?.type, "image", "redo restores the detection revision");

revisionState = createAnnotationState([], mineruBaseline);
revisionState = mergeAnnotations(revisionState, ["mineru-a", "mineru-b"]);
assert.deepEqual(mineruBaseline, mineruBaselineBefore, "merge keeps the MinerU baseline immutable");
assert.deepEqual(revisionState.suppressedSourceBlockIds, ["mineru-a", "mineru-b"], "merge suppresses replaced MinerU sources");
assert.equal(revisionState.annotations.length, 1, "same-page MinerU merge creates one replacement revision");
assert.deepEqual(effectiveAnnotations(revisionState).map((item) => item.id), [revisionState.annotations[0]?.id], "effective boxes contain only the replacement");
assert.deepEqual(revisionState.annotations[0]?.sourceBlockIds, ["mineru-a", "mineru-b"], "replacement retains original Source Block IDs");

const restoredMergeWithoutSuppression = createAnnotationState(revisionState.annotations, mineruBaseline);
assert.deepEqual(
  restoredMergeWithoutSuppression.suppressedSourceBlockIds,
  ["mineru-a", "mineru-b"],
  "restoring an old merge infers missing suppression from replacement provenance",
);
assert.deepEqual(
  effectiveAnnotations(restoredMergeWithoutSuppression).map((item) => item.id),
  [restoredMergeWithoutSuppression.annotations[0]?.id],
  "restoring an old merge does not resurrect its MinerU source boxes",
);

const separatedDetections: MineruDetection[] = [
  { id: "separate-a", sourceBlockIds: ["separate-a"], page: 1, bbox: [0.1, 0.1, 0.4, 0.2], type: "text", excluded: false, readingOrder: 1, layer: "detection" },
  { id: "middle", sourceBlockIds: ["middle"], page: 1, bbox: [0.1, 0.25, 0.4, 0.35], type: "text", excluded: false, readingOrder: 2, layer: "detection" },
  { id: "separate-c", sourceBlockIds: ["separate-c"], page: 1, bbox: [0.1, 0.4, 0.4, 0.5], type: "text", excluded: false, readingOrder: 3, layer: "detection" },
];
const separatedBefore = structuredClone(separatedDetections);
let separatedState = mergeAnnotations(createAnnotationState([], separatedDetections), ["separate-a", "separate-c"]);
assert.equal(separatedState.annotations.length, 2, "non-contiguous same-page members remain separate replacement regions");
assert.equal(new Set(separatedState.annotations.map((item) => item.logicalGroupId)).size, 1, "separate same-page regions share one logical group");
assert.deepEqual(separatedState.annotations.map((item) => item.bbox), [separatedDetections[0]!.bbox, separatedDetections[2]!.bbox], "separate replacements keep member geometry");
assert.deepEqual(separatedState.annotations.flatMap((item) => item.sourceBlockIds ?? []), ["separate-a", "separate-c"], "the unselected middle source is not absorbed into group provenance");
assert.deepEqual(separatedState.suppressedSourceBlockIds, ["separate-a", "separate-c"], "only selected MinerU sources are suppressed");
assert.equal(effectiveAnnotations(separatedState).some((item) => item.id === "middle"), true, "the unselected middle source remains effective and clickable");
assert.deepEqual(separatedDetections, separatedBefore, "non-contiguous merge keeps MinerU input immutable");

const samePageGroupDetections: MineruDetection[] = ["a", "gap-b", "c", "gap-d", "e"].map((suffix, index) => ({
  id: `same-page-${suffix}`, sourceBlockIds: [`same-page-${suffix}`], page: 1,
  bbox: [0.1, 0.08 + index * 0.16, 0.4, 0.16 + index * 0.16], type: "text",
  excluded: false, readingOrder: index + 1, layer: "detection" as const,
}));
let samePageGroupState = mergeAnnotations(createAnnotationState([], samePageGroupDetections), ["same-page-a", "same-page-c", "same-page-e"]);
const removedSamePageRegion = samePageGroupState.annotations.find((item) => item.sourceBlockIds?.includes("same-page-c"))!;
samePageGroupState = deleteAnnotations(samePageGroupState, [removedSamePageRegion.id]);
assert.deepEqual(samePageGroupState.annotations.map((item) => item.groupMemberIndex), [1, 2], "deleting a same-page group member reindexes remaining regions");
assert.equal(samePageGroupState.annotations.every((item) => item.groupMemberCount === 2), true, "remaining same-page regions expose the updated member count");
assert.equal(samePageGroupState.annotations.every((item) => JSON.stringify(item.regionMemberIds) !== JSON.stringify(["same-page-c"])), true, "only the targeted same-page region is removed");
samePageGroupState = splitAnnotations(samePageGroupState, [samePageGroupState.annotations[0]!.id]);
assert.deepEqual(effectiveAnnotations(samePageGroupState).map((item) => item.id), ["same-page-a", "same-page-gap-b", "same-page-gap-d", "same-page-e"], "split after same-page member deletion restores remaining members without resurrecting the deleted source");

const sparsePageDetections: MineruDetection[] = [1, 3, 7].map((page, index) => ({
  id: `sparse-p${page}`, sourceBlockIds: [`sparse-p${page}`], page,
  bbox: [0.1, 0.1, 0.4, 0.2], type: "text", excluded: false,
  readingOrder: index + 1, layer: "detection" as const,
}));
const sparsePageGroup = mergeAnnotations(createAnnotationState([], sparsePageDetections), sparsePageDetections.map((item) => item.id), { crossPage: true, groupId: "manual-group-sparse" });
assert.deepEqual(new Set(sparsePageGroup.annotations.map((item) => item.logicalGroupNumber)), new Set([1]), "P1/P3/P7 regions share a stable visible group number");
assert.equal(new Set(sparsePageGroup.annotations.map((item) => item.logicalGroupColor)).size, 1, "P1/P3/P7 regions share one stable group color");
assert.deepEqual(sparsePageGroup.annotations.map((item) => item.groupMemberIndex), [1, 2, 3], "group member sequence follows reading order");
assert.equal(sparsePageGroup.annotations.every((item) => item.groupMemberCount === 3), true, "each region exposes the group member count");
assert.equal(sparsePageGroup.annotations.every((item) => JSON.stringify(item.groupPages) === JSON.stringify([1, 3, 7])), true, "each region exposes the complete sparse page set");

const immutableMineruJson: { blocks: Array<{ id: string; page: number; bbox: [number, number, number, number]; type: "text"; readingOrder: number }> } = {
  blocks: [
    { id: "source-p1", page: 1, bbox: [0.1, 0.1, 0.3, 0.2], type: "text", readingOrder: 1 },
    { id: "source-p2", page: 2, bbox: [0.1, 0.1, 0.3, 0.2], type: "text", readingOrder: 2 },
    { id: "source-p3", page: 3, bbox: [0.1, 0.1, 0.3, 0.2], type: "text", readingOrder: 3 },
  ],
};
const immutableParsedDocument = { sourceDocumentVersion: "source-v1", blocks: structuredClone(immutableMineruJson.blocks) };
const mineruJsonBefore = structuredClone(immutableMineruJson);
const parsedDocumentBefore = structuredClone(immutableParsedDocument);
const crossPageDetections: MineruDetection[] = immutableMineruJson.blocks.map((block) => ({
  ...structuredClone(block),
  sourceBlockIds: [block.id],
  excluded: false,
  layer: "detection" as const,
}));
let crossPageRevision = createAnnotationState([], crossPageDetections);
crossPageRevision = mergeAnnotations(crossPageRevision, ["source-p1", "source-p2"], { crossPage: true, groupId: "text-group" });
assert.deepEqual(crossPageRevision.annotations.map((item) => item.page), [1, 2], "cross-page MinerU merge creates one replacement region per page");
assert.deepEqual(new Set(crossPageRevision.annotations.map((item) => item.logicalGroupId)), new Set(["text-group"]), "cross-page regions share one logical group");
assert.deepEqual(crossPageRevision.annotations.map((item) => item.readingOrder), [1, 2], "cross-page replacement order follows MinerU reading order");
assert.deepEqual(effectiveAnnotations(crossPageRevision).map((item) => item.page), [1, 2, 3], "effective projection contains replacements plus unsuppressed detections in order");

const firstReplacementId = crossPageRevision.annotations[0]!.id;
crossPageRevision = mergeAnnotations(crossPageRevision, [firstReplacementId, "source-p3"], { crossPage: true, groupId: "remixed-group" });
assert.deepEqual(crossPageRevision.annotations.flatMap((item) => item.sourceBlockIds ?? []).sort(), ["source-p1", "source-p2", "source-p3"], "re-merging a replacement keeps every original Source Block ID");
assert.deepEqual(crossPageRevision.annotations.map((item) => item.regionMemberIds), [["source-p1"], ["source-p2"], ["source-p3"]], "re-merged regions retain only their own original members");
const remixedIds = crossPageRevision.annotations.map((item) => item.id);
crossPageRevision = splitAnnotations(crossPageRevision, remixedIds);
assert.deepEqual(effectiveAnnotations(crossPageRevision).map((item) => item.id), ["source-p1", "source-p2", "source-p3"], "split restores MinerU IDs and reading order");
assert.deepEqual(crossPageRevision.suppressedSourceBlockIds, [], "split releases merge suppression");
assert.deepEqual(immutableMineruJson, mineruJsonBefore, "annotation revisions never mutate MinerU JSON");
assert.deepEqual(immutableParsedDocument, parsedDocumentBefore, "annotation revisions never mutate Parsed Document");

const tableDetections = [1, 2].map((page) => ({
  id: `table-source-p${page}`, sourceBlockIds: [`table-source-p${page}`], page,
  bbox: [0.1, 0.1, 0.8, 0.4] as [number, number, number, number], type: "table" as const,
  excluded: false, readingOrder: page, layer: "detection" as const,
}));
const crossPageTableRevision = mergeAnnotations(createAnnotationState([], tableDetections), tableDetections.map((item) => item.id), { crossPage: true });
assert.equal(crossPageTableRevision.annotations.every((item) => item.type === "table"), true, "cross-page MinerU table regions retain table type");

let deleteRevision = createAnnotationState([], crossPageDetections);
deleteRevision = deleteAnnotations(deleteRevision, ["source-p2"]);
assert.deepEqual(deleteRevision.suppressedSourceBlockIds, ["source-p2"], "deleting a MinerU box creates suppression");
assert.deepEqual(effectiveAnnotations(deleteRevision).map((item) => item.id), ["source-p1", "source-p3"], "deleted MinerU boxes leave the effective input");
deleteRevision = undoAnnotationChange(deleteRevision);
assert.deepEqual(effectiveAnnotations(deleteRevision).map((item) => item.id), ["source-p1", "source-p2", "source-p3"], "undo restores deleted MinerU evidence");
deleteRevision = redoAnnotationChange(deleteRevision);
assert.deepEqual(effectiveAnnotations(deleteRevision).map((item) => item.id), ["source-p1", "source-p3"], "redo reapplies MinerU suppression");

let sourceGroupRevision = mergeAnnotations(createAnnotationState([], crossPageDetections), crossPageDetections.map((item) => item.id), { crossPage: true });
const deletedSourceRegion = sourceGroupRevision.annotations.find((item) => item.page === 2)!;
sourceGroupRevision = deleteAnnotations(sourceGroupRevision, [deletedSourceRegion.id]);
assert.deepEqual(sourceGroupRevision.annotations.map((item) => item.page), [1, 3], "deleting a logical-group region keeps the other pages");
assert.equal(sourceGroupRevision.annotations.every((item) => item.groupMembers?.every((member) => member.page !== 2)), true, "remaining logical-group snapshots drop the deleted page member");
sourceGroupRevision = splitAnnotations(sourceGroupRevision, [sourceGroupRevision.annotations[0]!.id]);
assert.deepEqual(effectiveAnnotations(sourceGroupRevision).map((item) => item.id), ["source-p1", "source-p3"], "splitting after member deletion does not resurrect the deleted source");

const overlappingRevision = createAnnotationState([
  { id: "overlap-replacement", sourceBlockIds: ["source-p1"], page: 1, bbox: [0.4, 0.1, 0.6, 0.2], type: "text", excluded: false, readingOrder: 4, manual: true },
], crossPageDetections);
assert.throws(
  () => mergeAnnotations(overlappingRevision, ["source-p1", "overlap-replacement"]),
  /重复原始来源/,
  "two selected boxes cannot contribute the same original source",
);

const incompatibleRevision = createAnnotationState([], [
  { id: "incompatible-text", sourceBlockIds: ["incompatible-text"], page: 1, bbox: [0.1, 0.1, 0.2, 0.2], type: "text", excluded: false, readingOrder: 1, layer: "detection" },
  { id: "incompatible-table", sourceBlockIds: ["incompatible-table"], page: 1, bbox: [0.3, 0.1, 0.5, 0.2], type: "table", excluded: false, readingOrder: 2, layer: "detection" },
]);
const incompatibleBefore = structuredClone(incompatibleRevision);
assert.throws(() => mergeAnnotations(incompatibleRevision, ["incompatible-text", "incompatible-table"]), /不兼容类型/);
assert.deepEqual(incompatibleRevision, incompatibleBefore, "blocked incompatible merge leaves annotations and suppression unchanged");

console.log("Manual annotation state and coordinate tests passed");
