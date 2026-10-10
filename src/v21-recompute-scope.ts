import { createHash } from "node:crypto";

type LocalChangeKind = "content" | "type" | "source_boundary" | "group";
type DocumentChangeKind =
  | "reading_order"
  | "product_identity"
  | "cross_chunk_boundary";
type ChangeKind = LocalChangeKind | DocumentChangeKind;

export type RecomputePlan =
  | {
      scope: "local";
      identity: { chunkId: string; replacedChunkId: string | null };
      sourceSegmentPolicy: "preserve" | "preserve_block_only";
      affectedChunkIds: string[];
      affectedContentGroupIds: string[];
    }
  | {
      scope: "document_preview";
      identity: { chunkId: null; replacedChunkId: string };
      sourceSegmentPolicy: "rebuild_from_parsed_document";
      affectedChunkIds: string[];
      affectedContentGroupIds: string[];
      invalidation: { draft: true; context: true };
    };

export type RecomputeHistory<T> = {
  past: T[];
  present: T;
  future: T[];
  sequence: number;
};

export type RecomputeAutosave<T> = {
  contractVersion: "2.1";
  documentId: string;
  savedAt: string;
  history: RecomputeHistory<T>;
};

export type ReviewAction =
  | "view"
  | "locate"
  | "text_repair"
  | "typed_structure_edit"
  | "boundary_edit"
  | "group_edit"
  | "document_recompute"
  | "pixel_annotation";

const HISTORY_LIMIT = 50;

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function planRecompute(input: {
  documentId: string;
  draftVersion: string;
  chunkId: string;
  change: { kind: ChangeKind; fingerprint: string };
  affectedChunkIds: string[];
  affectedContentGroupIds: string[];
}): RecomputePlan {
  if (
    input.change.kind === "reading_order" ||
    input.change.kind === "product_identity" ||
    input.change.kind === "cross_chunk_boundary"
  ) {
    return {
      scope: "document_preview",
      identity: { chunkId: null, replacedChunkId: input.chunkId },
      sourceSegmentPolicy: "rebuild_from_parsed_document",
      affectedChunkIds: [...input.affectedChunkIds],
      affectedContentGroupIds: [...input.affectedContentGroupIds],
      invalidation: { draft: true, context: true },
    };
  }
  const preservesIdentity = input.change.kind === "content";
  const replacementId = `${input.draftVersion}:chunk:${createHash("sha256")
    .update(JSON.stringify({
      documentId: input.documentId,
      draftVersion: input.draftVersion,
      chunkId: input.chunkId,
      change: input.change,
      affectedChunkIds: input.affectedChunkIds,
      affectedContentGroupIds: input.affectedContentGroupIds,
    }))
    .digest("hex")
    .slice(0, 16)}`;
  return {
    scope: "local",
    identity: {
      chunkId: preservesIdentity ? input.chunkId : replacementId,
      replacedChunkId: preservesIdentity ? null : input.chunkId,
    },
    sourceSegmentPolicy: preservesIdentity ? "preserve" : "preserve_block_only",
    affectedChunkIds: [...input.affectedChunkIds],
    affectedContentGroupIds: [...input.affectedContentGroupIds],
  };
}

export function createRecomputeHistory<T>(initial: T): RecomputeHistory<T> {
  return { past: [], present: clone(initial), future: [], sequence: 0 };
}

export function commitRecomputeState<T>(
  history: RecomputeHistory<T>,
  next: T,
): RecomputeHistory<T> {
  return {
    past: [...history.past.map(clone), clone(history.present)].slice(
      -HISTORY_LIMIT,
    ),
    present: clone(next),
    future: [],
    sequence: history.sequence + 1,
  };
}

export function undoRecomputeState<T>(
  history: RecomputeHistory<T>,
): RecomputeHistory<T> {
  if (!history.past.length) return clone(history);
  const past = history.past.map(clone);
  const present = past.pop()!;
  return {
    past,
    present,
    future: [clone(history.present), ...history.future.map(clone)].slice(
      0,
      HISTORY_LIMIT,
    ),
    sequence: history.sequence,
  };
}

export function redoRecomputeState<T>(
  history: RecomputeHistory<T>,
): RecomputeHistory<T> {
  if (!history.future.length) return clone(history);
  const future = history.future.map(clone);
  const present = future.shift()!;
  return {
    past: [...history.past.map(clone), clone(history.present)].slice(
      -HISTORY_LIMIT,
    ),
    present,
    future,
    sequence: history.sequence,
  };
}

export function buildRecomputeAutosave<T>(
  documentId: string,
  history: RecomputeHistory<T>,
  savedAt: string,
): RecomputeAutosave<T> {
  if (!documentId) throw new Error("documentId is required");
  if (!Number.isFinite(Date.parse(savedAt)))
    throw new Error("savedAt must be an ISO timestamp");
  return {
    contractVersion: "2.1",
    documentId,
    savedAt,
    history: clone(history),
  };
}

export function restoreRecomputeAutosave<T>(
  value: unknown,
  documentId: string,
  isState: (value: unknown) => value is T,
): RecomputeHistory<T> {
  if (!value || typeof value !== "object") throw new Error("Invalid recompute autosave");
  const record = value as Record<string, unknown>;
  if (record.contractVersion !== "2.1") throw new Error("Invalid recompute autosave");
  if (record.documentId !== documentId) throw new Error("Autosave document does not match");
  if (
    typeof record.savedAt !== "string" ||
    !Number.isFinite(Date.parse(record.savedAt))
  ) throw new Error("Invalid recompute autosave");
  if (!record.history || typeof record.history !== "object")
    throw new Error("Invalid recompute autosave");
  const history = record.history as Record<string, unknown>;
  if (
    !Array.isArray(history.past) ||
    !Array.isArray(history.future) ||
    !isState(history.present) ||
    !history.past.every(isState) ||
    !history.future.every(isState) ||
    !Number.isSafeInteger(history.sequence) ||
    Number(history.sequence) < 0
  ) throw new Error("Invalid recompute autosave");
  return clone(history as RecomputeHistory<T>);
}

export function reviewCapability(
  viewport: "desktop" | "mobile",
  action: ReviewAction,
): { allowed: boolean; reason: "desktop_required" | "not_supported" | null } {
  if (action === "pixel_annotation")
    return { allowed: false, reason: "not_supported" };
  if (
    viewport === "mobile" &&
    action !== "view" &&
    action !== "locate" &&
    action !== "text_repair"
  ) return { allowed: false, reason: "desktop_required" };
  return { allowed: true, reason: null };
}
