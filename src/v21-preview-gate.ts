import { createHash } from "node:crypto";
import type {
  ChunkPreview,
  ChunkPreviewMetrics,
  ChunkRequest,
} from "./chunking.js";
import type { GenerationTicket } from "./generation-gate.js";
import type { DraftSnapshot } from "./review-state.js";

export type ConfigurationSnapshot = {
  configuration: ChunkRequest;
  fingerprint: string;
};

export type PreviewSnapshot = {
  snapshot: ChunkPreview;
  configuration: ChunkRequest;
  configurationFingerprint: string;
  generationTicket: GenerationTicket;
  expired: boolean;
};

export type PersistedDraft = {
  snapshot: DraftSnapshot;
  configurationFingerprint: string;
};

export type PreviewGateState = {
  configurationDraft: ConfigurationSnapshot;
  preview: PreviewSnapshot | null;
  draft: PersistedDraft | null;
  latestGenerationTicket: GenerationTicket | null;
};

export type PreviewGenerationRequest = ConfigurationSnapshot & {
  ticket: GenerationTicket;
};

export type ReplacementImpact = {
  humanRevisionCount: number;
  contextCount: number;
  affectedChunkCount: number;
};

type ConflictCode =
  | "PREVIEW_EXPIRED"
  | "STALE_GENERATION_TICKET"
  | "NO_PREVIEW"
  | "REPLACEMENT_CONFIRMATION_REQUIRED";

type Conflict = {
  ok: false;
  status: 409;
  code: ConflictCode;
  message: string;
  impact?: ReplacementImpact;
};

type CompletionResult =
  | { ok: true; state: PreviewGateState }
  | Conflict;

export type AdoptionResult =
  | {
      ok: true;
      state: PreviewGateState;
      impact: ReplacementImpact;
    }
  | Conflict;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameTicket(
  left: GenerationTicket | null,
  right: GenerationTicket,
): boolean {
  return left?.key === right.key && left.revision === right.revision;
}

function conflict(
  code: ConflictCode,
  message: string,
  impact?: ReplacementImpact,
): Conflict {
  return { ok: false, status: 409, code, message, ...(impact ? { impact } : {}) };
}

export function configurationFingerprint(configuration: ChunkRequest): string {
  return createHash("sha256").update(stableJson(configuration)).digest("hex");
}

export function createPreviewGateState(
  configuration: ChunkRequest,
): PreviewGateState {
  return {
    configurationDraft: {
      configuration: clone(configuration),
      fingerprint: configurationFingerprint(configuration),
    },
    preview: null,
    draft: null,
    latestGenerationTicket: null,
  };
}

export function updateConfigurationDraft(
  state: PreviewGateState,
  configuration: ChunkRequest,
): PreviewGateState {
  const fingerprint = configurationFingerprint(configuration);
  const next = clone(state);
  next.configurationDraft = { configuration: clone(configuration), fingerprint };
  if (next.preview)
    next.preview.expired = next.preview.configurationFingerprint !== fingerprint;
  return next;
}

export function startPreviewGeneration(
  state: PreviewGateState,
  ticket: GenerationTicket,
): { state: PreviewGateState; request: PreviewGenerationRequest } {
  const next = clone(state);
  next.latestGenerationTicket = clone(ticket);
  return {
    state: next,
    request: {
      ...clone(state.configurationDraft),
      ticket: clone(ticket),
    },
  };
}

export function completePreviewGeneration(
  state: PreviewGateState,
  request: PreviewGenerationRequest,
  preview: ChunkPreview,
): CompletionResult {
  if (!sameTicket(state.latestGenerationTicket, request.ticket))
    return conflict(
      "STALE_GENERATION_TICKET",
      "A newer Preview generation request already exists",
    );
  if (request.fingerprint !== state.configurationDraft.fingerprint)
    return conflict(
      "PREVIEW_EXPIRED",
      "Configuration changed while this Preview was generating",
    );
  const next = clone(state);
  next.preview = {
    snapshot: clone(preview),
    configuration: clone(request.configuration),
    configurationFingerprint: request.fingerprint,
    generationTicket: clone(request.ticket),
    expired: false,
  };
  return { ok: true, state: next };
}

export function replacementImpact(
  draft: PersistedDraft | null,
): ReplacementImpact {
  if (!draft)
    return { humanRevisionCount: 0, contextCount: 0, affectedChunkCount: 0 };
  let humanRevisionCount = 0;
  let contextCount = 0;
  let affectedChunkCount = 0;
  for (const chunk of draft.snapshot.chunks) {
    const revisions = chunk.revisions.length;
    const hasContext =
      chunk.contextReviewState !== "not_generated" || Boolean(chunk.contextText);
    humanRevisionCount += revisions;
    contextCount += hasContext ? 1 : 0;
    if (revisions || hasContext) affectedChunkCount += 1;
  }
  return { humanRevisionCount, contextCount, affectedChunkCount };
}

export function adoptPreview(
  state: PreviewGateState,
  options: { confirmReplacement?: boolean; now?: string } = {},
): AdoptionResult {
  if (!state.preview) return conflict("NO_PREVIEW", "No Chunk Preview to adopt");
  if (!sameTicket(state.latestGenerationTicket, state.preview.generationTicket))
    return conflict(
      "STALE_GENERATION_TICKET",
      "A newer Preview generation request must finish before adoption",
    );
  if (
    state.preview.expired ||
    state.preview.configurationFingerprint !== state.configurationDraft.fingerprint
  )
    return conflict(
      "PREVIEW_EXPIRED",
      "Generate a new Preview for the current Configuration Draft",
    );

  const impact = replacementImpact(state.draft);
  if (
    impact.affectedChunkCount > 0 &&
    options.confirmReplacement !== true
  )
    return conflict(
      "REPLACEMENT_CONFIRMATION_REQUIRED",
      "Replacing this Draft clears human revisions and Context",
      impact,
    );

  const next = clone(state);
  next.draft = {
    snapshot: {
      chunks: clone(state.preview.snapshot.chunks),
      metrics: clone(state.preview.snapshot.metrics),
      configuration: clone(state.preview.configuration),
      confirmedAt: options.now ?? new Date().toISOString(),
    },
    configurationFingerprint: state.preview.configurationFingerprint,
  };
  next.preview = null;
  return { ok: true, state: next, impact };
}

export function previewMetricDelta(
  before: ChunkPreviewMetrics,
  after: ChunkPreviewMetrics,
) {
  return {
    chunkCount: after.chunkCount - before.chunkCount,
    tokenMinimum: after.token.minimum - before.token.minimum,
    tokenAverage: after.token.average - before.token.average,
    tokenMaximum: after.token.maximum - before.token.maximum,
    oversizedCount: after.oversizedCount - before.oversizedCount,
    undersizedCount: after.undersizedCount - before.undersizedCount,
    actualOverlapRatio: after.actualOverlapRatio - before.actualOverlapRatio,
    crossPageCount: after.crossPageCount - before.crossPageCount,
    missingProductIdentityCount:
      after.missingProductIdentityCount - before.missingProductIdentityCount,
    contextCandidateCount:
      after.contextCandidateCount - before.contextCandidateCount,
  };
}
