export const ANNOTATION_TYPES = Object.freeze([
  "text", "heading", "table", "image", "list", "formula", "code", "warning", "caption",
]);

export const ANNOTATION_LABELS = Object.freeze({
  text: "文本", heading: "标题", table: "表格", image: "图片", list: "列表",
  formula: "公式", code: "代码", warning: "警告", caption: "图注", page_number: "页码",
});
export const ANNOTATION_SHORT_LABELS = Object.freeze({
  text: "文", heading: "题", table: "表", image: "图", list: "列",
  formula: "式", code: "码", warning: "警", caption: "注", page_number: "页",
});
export const ANNOTATION_ICONS = Object.freeze({
  text: "T", heading: "H", table: "▦", image: "▧", list: "≡",
  formula: "ƒ", code: "<>", warning: "!", caption: "※", page_number: "#",
});
export function browserUuid(cryptoApi = globalThis.crypto) {
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== "function")
    throw new Error("当前浏览器不支持安全随机 UUID");
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const LOGICAL_GROUP_COLORS = Object.freeze(["#9b3f73", "#0b766e", "#a45a00", "#5367a5", "#7a6420", "#a63d46"]);

export function applyAnnotationExclusionPolicy(detections = []) {
  const items = structuredClone(detections);
  const repeatedEdgeText = new Map();
  for (const item of items) {
    const text = String(item.text ?? "").trim();
    if (!text || !atPageEdge(item.bbox) || protectedEdgeText(item, text)) continue;
    const matches = repeatedEdgeText.get(text) ?? [];
    matches.push(item);
    repeatedEdgeText.set(text, matches);
  }
  for (const item of items) {
    const text = String(item.text ?? "").trim();
    if (atPageEdge(item.bbox) && isPageNumberText(item.type, text)) {
      item.excluded = true;
      item.exclusionReason = "页边缘页码默认排除，可随时恢复";
      continue;
    }
    const repeated = repeatedEdgeText.get(text) ?? [];
    const stable = repeated.length > 1 &&
      repeated.every((candidate) => Math.abs(candidate.bbox[1] - item.bbox[1]) <= 0.02);
    item.exclusionSuggested = Boolean(stable);
    if (stable)
      item.exclusionSuggestion = "多页重复且位置稳定，建议人工确认是否排除";
  }
  return items;
}

function atPageEdge(bbox) {
  return Array.isArray(bbox) && bbox.length === 4 &&
    (bbox[1] <= 0.12 || bbox[3] >= 0.88);
}

function isPageNumberText(type, text) {
  if (type === "page_number") return true;
  return /^\d+$/.test(text) ||
    /^[ivxlcdm]+$/i.test(text) ||
    /^(?:第\s*[0-9一二三四五六七八九十百千ivxlcdm]+\s*页)(?:\s*[\/／·-]\s*共\s*\d+\s*页)?$/i.test(text) ||
    /^共\s*\d+\s*页$/i.test(text);
}

function protectedEdgeText(item, text) {
  return item.type === "heading" ||
    /(型号|章节|第.+章|版本|ver(?:sion)?\.?|许可|不得|权利|保密|法律|copyright|©)/i.test(text);
}

export function annotationLabelForSize(type, width, height) {
  const fullLabel = ANNOTATION_LABELS[type] ?? ANNOTATION_LABELS.text;
  const shortLabel = ANNOTATION_SHORT_LABELS[type] ?? ANNOTATION_SHORT_LABELS.text;
  const icon = ANNOTATION_ICONS[type] ?? ANNOTATION_ICONS.text;
  const w = Number(width), h = Number(height);
  const fullWidth = fullLabel.length * 15 + 20;
  const shortWidth = shortLabel.length * 10 + 12;
  if (w >= fullWidth && h >= 18) return { mode: "full", label: fullLabel, fullLabel, shortLabel, icon, tooltip: fullLabel };
  if (w >= shortWidth && h >= 15) return { mode: "short", label: shortLabel, fullLabel, shortLabel, icon, tooltip: fullLabel };
  return { mode: "icon", label: icon, fullLabel, shortLabel, icon, tooltip: fullLabel };
}

export function createAnnotationState(annotations = [], mineruDetections = []) {
  const normalizedAnnotations = structuredClone(annotations);
  normalizeLogicalGroupNumbers(normalizedAnnotations);
  return {
    annotations: normalizedAnnotations,
    mineruDetections: structuredClone(mineruDetections),
    detectionExclusionOverrides: {},
    suppressedSourceBlockIds: inferredSuppressedSourceBlockIds(normalizedAnnotations),
    undo: [],
    redo: [],
  };
}

function inferredSuppressedSourceBlockIds(annotations) {
  return [...new Set(annotations
    .filter((item) => item.revisionOf || item.logicalGroupId || item.mergedFromIds?.length || item.groupMembers?.length)
    .flatMap(sourceIds))];
}

export function effectiveAnnotations(state) {
  const suppressed = new Set(state.suppressedSourceBlockIds ?? []);
  const overrides = state.detectionExclusionOverrides ?? {};
  const detections = (state.mineruDetections ?? [])
    .filter((item) => !(item.sourceBlockIds ?? [item.id]).some((id) => suppressed.has(id)))
    .map((item) => ({ ...structuredClone(item), excluded: overrides[item.id] ?? item.excluded, layer: "detection" }));
  const revisions = structuredClone(state.annotations ?? []).map((item) => ({
    ...item,
    layer: "manual",
    manual: true,
  }));
  return [...detections, ...revisions].sort(annotationOrder);
}

export function updateAnnotationSelection(current, blockId, options = {}) {
  const selected = new Set(current.selectedIds ?? []);
  if (options.rangeIds) options.rangeIds.forEach((id) => selected.add(id));
  else if (options.toggle) selected.has(blockId) ? selected.delete(blockId) : selected.add(blockId);
  else {
    selected.clear();
    selected.add(blockId);
  }
  const selectedIds = [...selected];
  const removed = !selected.has(blockId);
  const lockedBlockId = removed && current.lockedBlockId !== blockId
    ? current.lockedBlockId
    : selectedIds.at(-1) ?? null;
  return {
    selectedIds,
    lastSelectedId: selectedIds.at(-1) ?? null,
    lockedBlockId: lockedBlockId && selected.has(lockedBlockId) ? lockedBlockId : selectedIds.at(-1) ?? null,
  };
}

export function normalizeBox(start, end, width, height) {
  if (!(width > 0) || !(height > 0)) throw new Error("page dimensions must be positive");
  return [
    Math.min(start.x, end.x) / width,
    Math.min(start.y, end.y) / height,
    Math.max(start.x, end.x) / width,
    Math.max(start.y, end.y) / height,
  ];
}

export function denormalizeBox(bbox, width, height) {
  assertNormalizedBox(bbox);
  return [bbox[0] * width, bbox[1] * height, bbox[2] * width, bbox[3] * height];
}

export function annotationIdsInBox(annotations, bbox, options = {}) {
  const pages = new Set(options.pages ?? []);
  const tolerance = Number.isFinite(options.containmentTolerance)
    ? Math.max(0, options.containmentTolerance)
    : 0;
  const containmentBox = [
    Math.max(0, bbox[0] - tolerance),
    Math.max(0, bbox[1] - tolerance),
    Math.min(1, bbox[2] + tolerance),
    Math.min(1, bbox[3] + tolerance),
  ];
  return annotations.filter((item) => {
    if (pages.size && !pages.has(item.page)) return false;
    if (options.fullyContained) {
      return item.bbox[0] >= containmentBox[0] && item.bbox[1] >= containmentBox[1] &&
        item.bbox[2] <= containmentBox[2] && item.bbox[3] <= containmentBox[3];
    }
    return boxesOverlap(item.bbox, bbox);
  }).map((item) => item.id);
}

export function addAnnotation(state, input) {
  assertNormalizedBox(input.bbox);
  if (!Number.isSafeInteger(input.page) || input.page < 1) throw new Error("page must be a positive integer");
  const current = effectiveAnnotations(state);
  if (current.some((item) => item.id === input.id)) throw new Error("annotation id must be unique");
  const nextReadingOrder = Math.max(-1, ...current.map((item) => item.readingOrder).filter(Number.isFinite)) + 1;
  return mutate(state, (draft) => draft.annotations.push({
    id: input.id,
    page: input.page,
    bbox: [...input.bbox],
    type: "text",
    excluded: false,
    readingOrder: input.readingOrder ?? nextReadingOrder,
    sourceBlockIds: [],
    manual: true,
    layer: "manual",
  }));
}

export function changeAnnotationType(state, ids, type) {
  if (!ANNOTATION_TYPES.includes(type)) throw new Error("unsupported annotation type");
  const selected = new Set(ids);
  return mutate(state, (draft) => {
    draft.annotations.forEach((item) => { if (selected.has(item.id)) item.type = type; });
  });
}

export function reviseDetectionType(state, ids, type) {
  if (!ANNOTATION_TYPES.includes(type)) throw new Error("unsupported annotation type");
  const selected = new Set(ids);
  const detections = (state.mineruDetections ?? []).filter((item) => selected.has(item.id));
  if (detections.length !== selected.size) throw new Error("检测框不存在");
  return mutate(state, (draft) => {
    const suppressed = new Set(draft.suppressedSourceBlockIds);
    detections.forEach((item) => {
      const sourceBlockIds = sourceIds(item);
      sourceBlockIds.forEach((id) => suppressed.add(id));
      draft.annotations.push({
        ...structuredClone(item),
        id: randomId("revision"),
        type,
        sourceBlockIds,
        originalType: item.type,
        revisionOf: item.id,
        manual: true,
        layer: "manual",
      });
    });
    draft.suppressedSourceBlockIds = [...suppressed];
  });
}

export function toggleAnnotationExclusion(state, ids) {
  const selected = new Set(ids);
  return mutate(state, (draft) => {
    draft.annotations.forEach((item) => { if (selected.has(item.id)) item.excluded = !item.excluded; });
    for (const item of state.mineruDetections ?? []) {
      if (!selected.has(item.id)) continue;
      const current = state.detectionExclusionOverrides?.[item.id] ?? item.excluded;
      draft.detectionExclusionOverrides[item.id] = !current;
    }
  });
}

export function deleteAnnotations(state, ids) {
  const selectedIds = [...new Set(ids)];
  const targets = selectedIds.map((id) => effectiveAnnotations(state).find((item) => item.id === id));
  if (targets.some((item) => !item)) throw new Error("删除框不存在");
  return mutate(state, (draft) => {
    const selected = new Set(selectedIds);
    const suppressed = new Set(draft.suppressedSourceBlockIds);
    targets.forEach((target) => sourceIds(target).forEach((id) => suppressed.add(id)));
    draft.suppressedSourceBlockIds = [...suppressed];
    draft.annotations = draft.annotations.filter((item) => !selected.has(item.id));
    for (const groupId of new Set(targets.map((item) => item.logicalGroupId).filter(Boolean))) {
      const groupTargets = targets.filter((item) => item.logicalGroupId === groupId);
      const removed = new Set(groupTargets.flatMap((item) => item.regionMemberIds?.length
        ? item.regionMemberIds
        : groupMembers(item).filter((member) => member.page === item.page).map((member) => member.id)));
      const members = draft.annotations.filter((item) => item.logicalGroupId === groupId);
      if (members.length === 1 && !members[0].groupMembers?.length) {
        delete members[0].logicalGroupId;
        delete members[0].groupMembers;
      } else {
        const ordered = [...members].sort(annotationOrder);
        const groupPages = [...new Set(ordered.map((item) => item.page))].sort((left, right) => left - right);
        ordered.forEach((item, index) => {
          item.groupMembers = (item.groupMembers ?? []).filter((member) => !removed.has(member.id));
          item.groupMemberIndex = index + 1;
          item.groupMemberCount = ordered.length;
          item.groupPages = groupPages;
        });
      }
    }
  });
}

export function mergeAnnotations(state, ids, options = {}) {
  const selectedIds = [...new Set(ids)];
  if (selectedIds.length < 2) throw new Error("至少选择两个框才能合并");
  const current = effectiveAnnotations(state);
  const requested = selectedIds.map((id) => current.find((item) => item.id === id));
  if (requested.some((item) => !item)) throw new Error("合并框不存在");
  const selectedGroups = new Set(requested.map((item) => item.logicalGroupId).filter(Boolean));
  const items = current.filter((item) => selectedIds.includes(item.id) || selectedGroups.has(item.logicalGroupId));
  const pages = new Set(items.map((item) => item.page));
  const crossPage = options.crossPage === true;
  if (crossPage ? pages.size < 2 : pages.size !== 1)
    throw new Error(crossPage ? "跨页合并需要至少两个页面的框" : "同页合并只能选择同一页的框");
  const families = new Set(items.map((item) => annotationFamily(item.type)));
  if (families.size !== 1) throw new Error("不兼容类型：只能合并兼容类型的框");
  const expandedGroups = new Set();
  const originalMembers = items.flatMap((item) => {
    if (!item.logicalGroupId) return groupMembers(item);
    if (expandedGroups.has(item.logicalGroupId)) return [];
    expandedGroups.add(item.logicalGroupId);
    return groupMembers(item);
  });
  const memberIds = originalMembers.map((item) => item.id);
  if (new Set(memberIds).size !== memberIds.length) throw new Error("合并成员不能重复");
  const originalSources = originalMembers.flatMap(sourceIds);
  if (new Set(originalSources).size !== originalSources.length) throw new Error("合并结果不能重复原始来源");
  items.forEach((item) => assertNormalizedBox(item.bbox));
  const groupId = options.groupId ?? randomId("manual-group");
  const selectedSet = new Set(items.map((item) => item.id));
  const regions = [...pages].flatMap((page) => {
    const pageItems = items.filter((item) => item.page === page).sort(annotationOrder);
    return !crossPage && canCollapsePage(current, pageItems, selectedSet)
      ? [pageItems]
      : pageItems.map((item) => [item]);
  });
  const replacements = regions.map((regionItems) => {
    const regionMembers = regionItems.flatMap(regionGroupMembers);
    return {
      id: randomId("manual"),
      sourceBlockIds: [...new Set(regionItems.flatMap(sourceIds))],
      page: regionItems[0].page,
      bbox: annotationBounds(regionItems),
      type: annotationTypeForFamily(families.values().next().value, regionItems),
      readingOrder: Math.min(...regionItems.map((item) => item.readingOrder ?? Number.MAX_SAFE_INTEGER)),
      excluded: regionItems.every((item) => item.excluded),
      manual: true,
      layer: "manual",
      mergedFromIds: items.map((item) => item.id),
      logicalGroupId: groupId,
      groupMembers: structuredClone(originalMembers),
      regionMemberIds: regionMembers.map((item) => item.id),
    };
  }).sort(annotationOrder);
  const groupPages = [...new Set(replacements.map((item) => item.page))].sort((left, right) => left - right);
  replacements.forEach((item, index) => Object.assign(item, {
     groupMemberIndex: index + 1,
    groupMemberCount: replacements.length,
    groupPages,
  }));
  return mutate(state, (draft) => {
    draft.annotations = draft.annotations.filter((item) => !selectedSet.has(item.id));
    draft.annotations.push(...replacements);
    const suppressed = new Set(draft.suppressedSourceBlockIds);
    originalSources.forEach((id) => suppressed.add(id));
    draft.suppressedSourceBlockIds = [...suppressed];
    draft.annotations.sort(annotationOrder);
    normalizeLogicalGroupNumbers(draft.annotations);
  });
}

export function splitAnnotations(state, ids) {
  const selectedIds = [...new Set(ids)];
  if (!selectedIds.length) throw new Error("至少选择一个框才能拆分");
  const current = effectiveAnnotations(state);
  const targets = selectedIds.map((id) => current.find((item) => item.id === id));
  if (targets.some((item) => !item)) throw new Error("拆分框不存在");
  const processedGroups = new Set();
  const removeIds = new Set();
  const restore = [];
  for (const target of targets) {
    const groupKey = target.logicalGroupId ?? (Array.isArray(target.members) ? target.id : null);
    if (groupKey && processedGroups.has(groupKey)) continue;
    if (groupKey) processedGroups.add(groupKey);
    const targetRegions = target.logicalGroupId
      ? current.filter((item) => item.logicalGroupId === target.logicalGroupId)
      : [target];
    targetRegions.forEach((item) => removeIds.add(item.id));
    const snapshots = target.logicalGroupId ? target.groupMembers : target.members;
    if (!Array.isArray(snapshots) || !snapshots.length) throw new Error("该框没有可恢复的成员");
    restore.push(...snapshots.map((item) => structuredClone(item)));
  }
  if (new Set(restore.map((item) => item.id)).size !== restore.length) throw new Error("拆分成员存在重复来源");
  return mutate(state, (draft) => {
    draft.annotations = draft.annotations.filter((item) => !removeIds.has(item.id));
    const suppressed = new Set(draft.suppressedSourceBlockIds);
    restore.forEach((item) => sourceIds(item).forEach((id) => suppressed.delete(id)));
    draft.suppressedSourceBlockIds = [...suppressed];
    draft.annotations.push(...restore.filter((item) => item.layer !== "detection" && !isDetectionSnapshot(item)));
    draft.annotations.sort(annotationOrder);
  });
}

export function undoAnnotationChange(state) {
  if (!state.undo.length) return state;
  const previous = state.undo.at(-1);
  return {
    ...state,
    annotations: structuredClone(previous.annotations),
    suppressedSourceBlockIds: [...previous.suppressedSourceBlockIds],
    detectionExclusionOverrides: structuredClone(previous.detectionExclusionOverrides ?? {}),
    undo: state.undo.slice(0, -1),
    redo: [...state.redo, snapshot(state)],
  };
}

export function redoAnnotationChange(state) {
  if (!state.redo.length) return state;
  const next = state.redo.at(-1);
  return {
    ...state,
    annotations: structuredClone(next.annotations),
    suppressedSourceBlockIds: [...next.suppressedSourceBlockIds],
    detectionExclusionOverrides: structuredClone(next.detectionExclusionOverrides ?? {}),
    undo: [...state.undo, snapshot(state)],
    redo: state.redo.slice(0, -1),
  };
}

function mutate(state, change) {
  const draft = {
    annotations: structuredClone(state.annotations ?? []),
    suppressedSourceBlockIds: [...(state.suppressedSourceBlockIds ?? [])],
    detectionExclusionOverrides: structuredClone(state.detectionExclusionOverrides ?? {}),
  };
  change(draft);
  normalizeLogicalGroupNumbers(draft.annotations);
  return {
    ...state,
    annotations: draft.annotations,
    suppressedSourceBlockIds: draft.suppressedSourceBlockIds,
    detectionExclusionOverrides: draft.detectionExclusionOverrides,
    undo: [...state.undo, snapshot(state)].slice(-40),
    redo: [],
  };
}

function snapshot(state) {
  return { annotations: structuredClone(state.annotations ?? []), suppressedSourceBlockIds: [...(state.suppressedSourceBlockIds ?? [])], detectionExclusionOverrides: structuredClone(state.detectionExclusionOverrides ?? {}) };
}

function sourceIds(item) {
  return [...new Set(item.sourceBlockIds ?? [])];
}

function groupMembers(item) {
  if (Array.isArray(item.groupMembers)) return item.groupMembers.flatMap(groupMembers);
  if (Array.isArray(item.members)) return item.members.flatMap(groupMembers);
  return [annotationSnapshot(item)];
}

function regionGroupMembers(item) {
  const members = groupMembers(item);
  if (!item.regionMemberIds?.length) return members;
  const regionIds = new Set(item.regionMemberIds);
  return members.filter((member) => regionIds.has(member.id));
}

function annotationSnapshot(item) {
  const snapshot = structuredClone(item);
  delete snapshot.members;
  delete snapshot.groupMembers;
  delete snapshot.mergedFromIds;
  return snapshot;
}

function normalizeLogicalGroupNumbers(annotations) {
  const groups = new Map();
  for (const item of [...annotations].sort(annotationOrder)) {
    if (!item.logicalGroupId || groups.has(item.logicalGroupId)) continue;
    groups.set(item.logicalGroupId, groups.size + 1);
  }
  for (const item of annotations) {
    if (!item.logicalGroupId) {
      delete item.logicalGroupNumber;
      delete item.logicalGroupColor;
      continue;
    }
    const number = groups.get(item.logicalGroupId);
    item.logicalGroupNumber = number;
    item.logicalGroupColor = LOGICAL_GROUP_COLORS[(number - 1) % LOGICAL_GROUP_COLORS.length];
  }
}

function isDetectionSnapshot(item) {
  return item.layer === "detection" || item.manual === false;
}

function annotationFamily(type) {
  if (type === "table") return "table";
  if (type === "image") return "image";
  return "text";
}

function annotationTypeForFamily(family, items) {
  if (family !== "text") return family;
  const types = new Set(items.map((item) => item.type));
  return types.size === 1 ? items[0].type : "text";
}

function annotationOrder(left, right) {
  return (left.readingOrder ?? Number.MAX_SAFE_INTEGER) - (right.readingOrder ?? Number.MAX_SAFE_INTEGER)
    || (left.page ?? 0) - (right.page ?? 0)
    || String(left.id).localeCompare(String(right.id));
}

function annotationBounds(items) {
  return items.reduce(([x0, y0, x1, y1], item) => [
    Math.min(x0, item.bbox[0]), Math.min(y0, item.bbox[1]),
    Math.max(x1, item.bbox[2]), Math.max(y1, item.bbox[3]),
  ], [1, 1, 0, 0]);
}

function canCollapsePage(current, selected, selectedIds) {
  if (selected.length < 2) return true;
  const pageItems = current.filter((item) => item.page === selected[0].page).sort(annotationOrder);
  const indexes = selected.map((item) => pageItems.findIndex((candidate) => candidate.id === item.id)).sort((a, b) => a - b);
  if (indexes.some((index, position) => position > 0 && index !== indexes[position - 1] + 1)) return false;
  const bounds = annotationBounds(selected);
  return !pageItems.some((item) => !selectedIds.has(item.id) && boxesOverlap(bounds, item.bbox));
}

function boxesOverlap(left, right) {
  return left[0] < right[2] && left[2] > right[0] && left[1] < right[3] && left[3] > right[1];
}

function randomId(prefix) {
  return `${prefix}-${browserUuid()}`;
}

function assertNormalizedBox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite) ||
      bbox[0] < 0 || bbox[1] < 0 || bbox[2] > 1 || bbox[3] > 1 ||
      bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) {
    throw new Error("normalized bbox must be an ordered [0, 1] box");
  }
}
