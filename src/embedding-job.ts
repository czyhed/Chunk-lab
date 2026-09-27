import { createHash, randomUUID } from "node:crypto";
import type { Chunk } from "./chunking.js";
import { countTokens } from "./chunking.js";
import {
  createDeterministicEmbeddingClient,
  createEmbeddingClient,
  type EmbedTexts,
} from "./embedding.js";
import { embeddingTextFor } from "./contextual.js";

export type EmbeddingProfile = {
  id: string;
  name: string;
  model: string;
  dimensions: number;
  maxTokens: number;
  timeoutMs: number;
  embed: EmbedTexts;
  fakeFailureMode?: "second-once";
};

export type PublicEmbeddingProfile = Pick<
  EmbeddingProfile,
  "id" | "name" | "dimensions" | "maxTokens"
>;

export type EmbeddingJobItem = {
  chunkId: string;
  status: "succeeded" | "failed" | "skipped";
  attempts: number;
  reason?: string;
  errorCode?: "TOKEN_LIMIT_EXCEEDED" | "VECTOR_DIMENSION_MISMATCH" |
    "EMBEDDING_RATE_LIMITED" | "EMBEDDING_TIMEOUT" | "EMBEDDING_REQUEST_FAILED";
  vectorRecord?: {
    schemaVersion: "1.0";
    chunkId: string;
    profileId: string;
    model: string;
    dimensions: number;
    embeddingTextHash: string;
    vector: number[];
  };
};

export type EmbeddingJob = {
  id: string;
  idempotencyKey: string;
  documentId: string;
  profileId: string;
  profileName: string;
  model: string;
  dimensions: number;
  status: "completed" | "partial_failure" | "failed";
  createdAt: string;
  updatedAt: string;
  items: EmbeddingJobItem[];
  summary: { total: number; succeeded: number; failed: number; skipped: number };
  spuId?: string;
  targetSpuIds?: string[];
  sourceDocumentVersion?: string;
  documentType?: string;
  embeddingRevision?: string;
  stale?: boolean;
  staleReasons?: string[];
};

export function embeddingJobStaleReasons(
  job: EmbeddingJob,
  currentIdempotencyKey: string,
): string[] {
  return job.idempotencyKey === currentIdempotencyKey
    ? []
    : ["embedding_input_changed"];
}

export function parseEmbeddingProfiles(
  environment: NodeJS.ProcessEnv,
): EmbeddingProfile[] {
  const value = environment.EMBEDDING_PROFILES_JSON?.trim();
  if (!value) return environment.NODE_ENV === "production" ? [] : fakeProfiles();
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("EMBEDDING_PROFILES_JSON 必须是数组");
  const ids = new Set<string>();
  return parsed.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Embedding profile 必须是对象");
    const profile = item as Record<string, unknown>;
    const id = requiredString(profile.id, "Embedding profile id");
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id))
      throw new Error("Embedding profile id 无效或重复");
    ids.add(id);
    const dimensions = positiveInteger(profile.dimensions, "Embedding dimensions");
    const maxTokens = positiveInteger(profile.maxTokens, "Embedding maxTokens");
    const timeoutMs = profile.timeoutMs === undefined
      ? 30_000
      : positiveInteger(profile.timeoutMs, "Embedding timeoutMs");
    const baseUrl = requiredString(profile.baseUrl, "Embedding baseUrl");
    const apiKey = resolveSecret(profile.apiKey, environment);
    const model = requiredString(profile.model, "Embedding model");
    return {
      id,
      name: requiredString(profile.name, "Embedding profile name"),
      model,
      dimensions,
      maxTokens,
      timeoutMs,
      embed: createEmbeddingClient({ baseUrl, apiKey, model, timeoutMs }),
    };
  });
}

export function publicEmbeddingProfiles(
  profiles: readonly EmbeddingProfile[],
): PublicEmbeddingProfile[] {
  return profiles.map(({ id, name, dimensions, maxTokens }) => ({
    id,
    name,
    dimensions,
    maxTokens,
  }));
}

export function embeddingIdempotencyKey(
  documentId: string,
  profile: EmbeddingProfile,
  chunks: readonly Chunk[],
  metadata?: { spuId?: string; targetSpuIds?: readonly string[]; sourceDocumentVersion?: string; documentType?: string; embeddingRevision?: string },
): string {
  const normalizedMetadata = metadata
    ? {
        ...metadata,
        ...(metadata.targetSpuIds
          ? { targetSpuIds: [...new Set(metadata.targetSpuIds.map((id) => id.trim()).filter(Boolean))].sort() }
          : {}),
      }
    : null;
  return createHash("sha256").update(JSON.stringify({
    documentId,
    metadata: normalizedMetadata,
    profileId: profile.id,
    model: profile.model,
    chunks: chunks.map((chunk) => ({
      id: chunk.id,
      finalText: chunk.finalText,
      excluded: chunk.excluded,
      targetSpuIds: [...new Set(((chunk as Chunk & { targetSpuIds?: string[] }).targetSpuIds ?? [])
        .map((id) => id.trim()).filter(Boolean))].sort(),
      embeddingEligible: (chunk as Chunk & { embeddingEligible?: boolean })
        .embeddingEligible,
      embeddingExclusionReasons:
        (chunk as Chunk & { embeddingExclusionReasons?: string[] })
          .embeddingExclusionReasons ?? [],
      contextText: chunk.contextText,
      contextReviewState: chunk.contextReviewState,
    })),
  })).digest("hex");
}

export async function runEmbeddingJob(input: {
  documentId: string;
  chunks: readonly Chunk[];
  profile: EmbeddingProfile;
  previous?: EmbeddingJob;
  at: string;
  metadata?: { spuId?: string; targetSpuIds?: readonly string[]; sourceDocumentVersion?: string; documentType?: string; embeddingRevision?: string };
}): Promise<EmbeddingJob> {
  const currentIdempotencyKey = embeddingIdempotencyKey(
    input.documentId,
    input.profile,
    input.chunks,
    input.metadata,
  );
  const sameInput = input.previous?.idempotencyKey === currentIdempotencyKey;
  const retry = sameInput;
  const previousItems = new Map(
    (sameInput ? input.previous?.items : undefined)?.map((item) => [item.chunkId, item]) ?? [],
  );
  let eligibleIndex = 0;
  const items: EmbeddingJobItem[] = [];
  for (const chunk of input.chunks) {
    const previous = previousItems.get(chunk.id);
    if (retry && previous?.status !== "failed") {
      items.push(structuredClone(previous!));
      continue;
    }
    const text = embeddingTextFor(chunk);
    if (!text) {
      items.push({
        chunkId: chunk.id,
        status: "skipped",
        attempts: previous?.attempts ?? 0,
        reason: chunk.excluded
          ? "Chunk 已排除"
          : "Chunk 不具备 Embedding 资格",
      });
      continue;
    }
    const currentEligibleIndex = eligibleIndex++;
    const attempts = (previous?.attempts ?? 0) + 1;
    if (countTokens(text) > input.profile.maxTokens) {
      items.push({
        chunkId: chunk.id,
        status: "failed",
        attempts,
        errorCode: "TOKEN_LIMIT_EXCEEDED",
        reason: "Embedding 文本超过模型 Token 上限",
      });
      continue;
    }
    try {
      if (
        input.profile.fakeFailureMode === "second-once" &&
        currentEligibleIndex === 1 &&
        attempts === 1
      ) throw Object.assign(new Error("deterministic fake failure"), {
        code: "FAKE_PARTIAL_FAILURE",
      });
      const vectors = await input.profile.embed([text]);
      const vector = vectors[0];
      if (!vector || vector.length !== input.profile.dimensions)
        throw Object.assign(new Error("vector dimension mismatch"), {
          code: "VECTOR_DIMENSION_MISMATCH",
        });
      items.push({
        chunkId: chunk.id,
        status: "succeeded",
        attempts,
        vectorRecord: {
          schemaVersion: "1.0",
          chunkId: chunk.id,
          profileId: input.profile.id,
          model: input.profile.model,
          dimensions: input.profile.dimensions,
          embeddingTextHash: createHash("sha256").update(text).digest("hex"),
          vector,
        },
      });
    } catch (error) {
      const errorCode = classifyError(error);
      items.push({
        chunkId: chunk.id,
        status: "failed",
        attempts,
        errorCode,
        reason: errorMessage(errorCode),
      });
    }
  }
  const summary = {
    total: items.length,
    succeeded: items.filter((item) => item.status === "succeeded").length,
    failed: items.filter((item) => item.status === "failed").length,
    skipped: items.filter((item) => item.status === "skipped").length,
  };
  return {
    id: sameInput ? input.previous!.id : randomUUID(),
    idempotencyKey: currentIdempotencyKey,
    documentId: input.documentId,
    profileId: input.profile.id,
    profileName: input.profile.name,
    model: input.profile.model,
    dimensions: input.profile.dimensions,
    status: summary.failed === 0
      ? "completed"
      : summary.succeeded > 0 || summary.skipped > 0
        ? "partial_failure"
        : "failed",
    createdAt: sameInput ? input.previous!.createdAt : input.at,
    updatedAt: input.at,
    items,
    summary,
    ...(input.metadata?.spuId ? { spuId: input.metadata.spuId } : {}),
    ...(input.metadata?.targetSpuIds ? { targetSpuIds: [...new Set(input.metadata.targetSpuIds)] } : {}),
    ...(input.metadata?.sourceDocumentVersion ? { sourceDocumentVersion: input.metadata.sourceDocumentVersion } : {}),
    ...(input.metadata?.documentType ? { documentType: input.metadata.documentType } : {}),
    ...(input.metadata?.embeddingRevision ? { embeddingRevision: input.metadata.embeddingRevision } : {}),
  };
}

function fakeProfiles(): EmbeddingProfile[] {
  return [
    {
      id: "deterministic-fake",
      name: "Deterministic Fake Embedding",
      model: "deterministic-fake-v1",
      dimensions: 16,
      maxTokens: 4096,
      timeoutMs: 1_000,
      embed: createDeterministicEmbeddingClient(16),
    },
    {
      id: "deterministic-partial",
      name: "Deterministic Partial Failure",
      model: "deterministic-fake-v1",
      dimensions: 16,
      maxTokens: 4096,
      timeoutMs: 1_000,
      embed: createDeterministicEmbeddingClient(16),
      fakeFailureMode: "second-once",
    },
  ];
}

function classifyError(error: unknown): EmbeddingJobItem["errorCode"] {
  const candidate = error as { code?: string; name?: string; message?: string };
  if (candidate?.code === "VECTOR_DIMENSION_MISMATCH")
    return "VECTOR_DIMENSION_MISMATCH";
  if (candidate?.name === "TimeoutError" || candidate?.name === "AbortError")
    return "EMBEDDING_TIMEOUT";
  if (/\b429\b|rate limit/i.test(candidate?.message ?? ""))
    return "EMBEDDING_RATE_LIMITED";
  return "EMBEDDING_REQUEST_FAILED";
}

function errorMessage(code: EmbeddingJobItem["errorCode"]): string {
  return ({
    VECTOR_DIMENSION_MISMATCH: "Embedding 服务返回的向量维度不匹配",
    EMBEDDING_TIMEOUT: "Embedding 服务响应超时",
    EMBEDDING_RATE_LIMITED: "Embedding 服务触发限流",
    EMBEDDING_REQUEST_FAILED: "Embedding 服务未返回可用向量",
    TOKEN_LIMIT_EXCEEDED: "Embedding 文本超过模型 Token 上限",
  })[code!];
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 不能为空`);
  return value.trim();
}

function positiveInteger(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} 无效`);
  return number;
}

function resolveSecret(value: unknown, environment: NodeJS.ProcessEnv): string {
  const secret = requiredString(value, "Embedding apiKey");
  const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(secret);
  return reference
    ? requiredString(environment[reference[1]], `Embedding apiKey env ${reference[1]}`)
    : secret;
}
