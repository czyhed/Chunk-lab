import type { Chunk } from "./chunking.js";

export type ContextSourceBlock = {
  contentBlockId: string;
  searchText: string;
  contentType?: string;
  contentGroupId?: string;
  parentContentBlockId?: string | null;
};

export type ContextPackage = {
  chunkId: string;
  productIdentity?: string;
  parentSectionId?: string;
  sourceText: string;
  referenceText: string;
  scope: string[];
  skippedNeighborReasons: Array<{ chunkId: string; reasons: string[] }>;
};

export type ContextGenerationInput = {
  chunkId: string;
  finalText: string;
  contextPackage: ContextPackage;
};

export type ContextGenerator = (
  input: ContextGenerationInput,
) => Promise<string>;

export type ContextGenerationOptions = {
  model: string;
  promptVersion: string;
  allowHumanContextOverwrite?: boolean;
};

const genericHeading = /^(安装方法|注意事项|使用方法|操作步骤|产品参数|技术参数)[：:]?$/;
const crossReference = /本产品|该模式|上述参数|如下图|下图|以上步骤|此功能/;
const modelCode = /\b[A-Z][A-Z0-9-]{1,}\b/g;

function cloneChunks<T extends Chunk>(chunks: T[]): T[] {
  return structuredClone(chunks);
}

function candidateReasons(chunk: Chunk): string[] {
  const reasons: string[] = [];
  const text = chunk.finalText.trim();
  if (!chunk.productIdentity)
    reasons.push("缺少商品名称、型号或适用版本");
  if (genericHeading.test(text) || /(?:^|\n)(安装方法|注意事项)(?:[：:]|\n|$)/.test(text))
    reasons.push("包含通用标题，脱离文档后含义可能不完整");
  if (crossReference.test(text))
    reasons.push("包含跨段指代，需要补充被省略的上下文");
  if (
    (chunk.type === "table" || chunk.type === "image") &&
    (!chunk.productIdentity || !chunk.parentSectionId)
  )
    reasons.push("独立参数表或图片摘要缺少所属商品或功能");
  if (chunk.parentSectionId && !/^(#|第.+章|.+说明|.+方法|.+事项)/.test(text))
    reasons.push("从章节中间开始，依赖父标题");
  if (new Set(text.match(modelCode) ?? []).size > 1 && !chunk.productIdentity)
    reasons.push("包含多个型号，适用对象不明确");
  return reasons;
}

export function markContextCandidates<T extends Chunk>(chunks: T[]): T[] {
  return cloneChunks(chunks).map((chunk) => ({
    ...chunk,
    contextCandidateReasons: candidateReasons(chunk),
  }));
}

function blockText(block: ContextSourceBlock): string {
  return `[${block.contentBlockId}]\n${block.searchText}`;
}

export function buildContextPackage(
  chunk: Chunk,
  documentChunks: Chunk[],
  documentBlocks: ContextSourceBlock[],
): ContextPackage {
  const blockById = new Map(
    documentBlocks.map((block) => [block.contentBlockId, block]),
  );
  const sourceBlocks = chunk.sourceBlockIds
    .map((id) => blockById.get(id))
    .filter((block): block is ContextSourceBlock => Boolean(block));
  const sourceGroupIds = new Set(
    sourceBlocks.map((block) => block.contentGroupId).filter(Boolean),
  );
  const sameGroupBlocks = documentBlocks.filter(
    (block) =>
      block.contentGroupId && sourceGroupIds.has(block.contentGroupId),
  );
  const index = documentChunks.findIndex((candidate) => candidate.id === chunk.id);
  const adjacentCandidates = [
    documentChunks[index - 1],
    documentChunks[index + 1],
  ].filter(
    (candidate): candidate is Chunk => Boolean(candidate),
  );
  const skippedNeighborReasons = adjacentCandidates
    .filter((candidate) => !isEmbeddingEligible(candidate))
    .map((candidate) => ({
      chunkId: candidate.id,
      reasons: candidate.excluded
        ? ["excluded_from_draft"]
        : [
            ...((candidate as Chunk & {
              embeddingExclusionReasons?: string[];
            }).embeddingExclusionReasons ?? ["eligibility_missing"]),
          ],
    }));
  const adjacent = adjacentCandidates.filter(isEmbeddingEligible);
  const skippedSourceBlockIds = new Set(
    adjacentCandidates
      .filter((candidate) => !isEmbeddingEligible(candidate))
      .flatMap((candidate) => candidate.sourceBlockIds),
  );
  const safeReferenceBlocks = documentBlocks.filter(
    (block) => !skippedSourceBlockIds.has(block.contentBlockId),
  );
  const headings = documentBlocks.filter(
    (block) =>
      block.contentType === "heading" &&
      (block.contentBlockId === chunk.parentSectionId ||
        block.contentBlockId === sourceBlocks[0]?.parentContentBlockId),
  );
  const documentText = documentBlocks
    .map((block) => block.searchText)
    .join("\n\n");
  const isShortDocument = documentText.length <= 12_000;
  const selectedBlocks = isShortDocument
    ? safeReferenceBlocks
    : [...sourceBlocks, ...sameGroupBlocks, ...headings];
  const uniqueBlocks = [
    ...new Map(
      selectedBlocks.map((block) => [block.contentBlockId, block]),
    ).values(),
  ];
  const scope = [
    ...sourceBlocks.map((block) => `当前来源 ${block.contentBlockId}`),
    ...sameGroupBlocks
      .filter(
        (block) => !chunk.sourceBlockIds.includes(block.contentBlockId),
      )
      .map((block) => `同组 ${block.contentBlockId}`),
    ...headings.map((block) => `父标题 ${block.contentBlockId}`),
    ...adjacent.map((candidate) => `相邻 Chunk ${candidate.id}`),
    ...(isShortDocument ? ["完整 Parsed Document"] : []),
  ];
  return {
    chunkId: chunk.id,
    ...(chunk.productIdentity ? { productIdentity: chunk.productIdentity } : {}),
    ...(chunk.parentSectionId ? { parentSectionId: chunk.parentSectionId } : {}),
    sourceText: sourceBlocks.map(blockText).join("\n\n") || chunk.finalText,
    referenceText: [
      ...uniqueBlocks.map(blockText),
      ...adjacent.map((candidate) => `[相邻 Chunk ${candidate.id}]\n${candidate.finalText}`),
    ].join("\n\n"),
    scope: [...new Set(scope)],
    skippedNeighborReasons,
  };
}

function isEmbeddingEligible(chunk: Chunk): boolean {
  const candidate = chunk as Chunk & {
    embeddingEligible?: boolean;
    embeddingExclusionReasons?: string[];
  };
  return (
    !chunk.excluded &&
    candidate.embeddingEligible === true &&
    (candidate.embeddingExclusionReasons?.length ?? 0) === 0
  );
}

function validGeneratedContext(value: string): string {
  const text = value.trim();
  if (!text) throw new Error("模型返回了空 Context");
  if (text === "上下文不足") return text;
  const sentenceCount = text
    .split(/[。！？!?]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean).length;
  if (sentenceCount < 2 || sentenceCount > 4)
    throw new Error("Context 必须为 2-4 句，或返回“上下文不足”");
  return text;
}

export async function generateSelectedContexts(
  chunks: Chunk[],
  selectedChunkIds: string[],
  documentBlocks: ContextSourceBlock[],
  generate: ContextGenerator,
  options: ContextGenerationOptions,
): Promise<Chunk[]> {
  const selectedIds = new Set(selectedChunkIds);
  const knownIds = new Set(chunks.map((chunk) => chunk.id));
  const unknownId = [...selectedIds].find((id) => !knownIds.has(id));
  if (unknownId) throw new Error(`Chunk ${unknownId} 不存在`);
  const selected = chunks.filter((chunk) => selectedIds.has(chunk.id));
  const ineligible = selected.find(
    (chunk) =>
      (chunk as Chunk & { embeddingEligible?: boolean }).embeddingEligible !==
        true ||
      ((chunk as Chunk & { embeddingExclusionReasons?: string[] })
        .embeddingExclusionReasons?.length ?? 0) > 0,
  ) as (Chunk & { embeddingExclusionReasons?: string[] }) | undefined;
  if (ineligible)
    throw new Error(
      `Chunk ${ineligible.id} 不允许生成 Context：${
        ineligible.embeddingExclusionReasons?.join(", ") ||
        "embedding eligibility missing"
      }`,
    );
  const protectedChunk = selected.find(
    (chunk) =>
      chunk.contextReviewState === "human_modified" &&
      !options.allowHumanContextOverwrite,
  );
  if (protectedChunk)
    throw new Error(`Chunk ${protectedChunk.id} 的 Context 已人工修改，重新生成需要明确确认覆盖`);

  const result = cloneChunks(chunks);
  await Promise.all(
    result
      .filter((chunk) => selectedIds.has(chunk.id))
      .map(async (chunk) => {
        const contextPackage = buildContextPackage(chunk, result, documentBlocks);
        chunk.contextReviewState = "generating";
        chunk.contextError = undefined;
        try {
          chunk.contextText = validGeneratedContext(
            await generate({
              chunkId: chunk.id,
              finalText: chunk.finalText,
              contextPackage,
            }),
          );
          chunk.contextReviewState = "awaiting_review";
          chunk.contextModel = options.model;
          chunk.contextPromptVersion = options.promptVersion;
          chunk.contextGeneratedAt = new Date().toISOString();
          chunk.contextScope = contextPackage.scope;
          chunk.skippedNeighborReasons =
            contextPackage.skippedNeighborReasons;
        } catch (error) {
          chunk.contextReviewState = "failed";
          chunk.contextError =
            error instanceof Error ? error.message : "Context 生成失败";
        }
      }),
  );
  return result;
}

export function confirmContext(chunks: Chunk[], chunkId: string): Chunk[] {
  const result = cloneChunks(chunks);
  const chunk = result.find((candidate) => candidate.id === chunkId);
  if (!chunk) throw new Error(`Chunk ${chunkId} does not exist`);
  if (!chunk.contextText.trim()) throw new Error("没有可确认的 Context");
  if (chunk.contextReviewState !== "awaiting_review")
    throw new Error("只有待审核 Context 可以确认");
  chunk.contextReviewState = "confirmed";
  chunk.contextError = undefined;
  return result;
}

export function applyManualContext(
  chunks: Chunk[],
  chunkId: string,
  contextText: string,
): Chunk[] {
  const text = contextText.trim();
  if (!text) throw new Error("人工 Context 不能为空");
  const result = cloneChunks(chunks);
  const chunk = result.find((candidate) => candidate.id === chunkId);
  if (!chunk) throw new Error(`Chunk ${chunkId} does not exist`);
  chunk.contextText = text;
  chunk.contextReviewState = "human_modified";
  chunk.contextError = undefined;
  chunk.contextGeneratedAt = new Date().toISOString();
  return result;
}

export function invalidateContext(chunk: Chunk): Chunk {
  const result = structuredClone(chunk);
  if (result.contextReviewState !== "not_generated")
    result.contextReviewState = "stale";
  return result;
}

export function embeddingTextFor(chunk: Chunk): string | null {
  if (!isEmbeddingEligible(chunk)) return null;
  return ["confirmed", "human_modified"].includes(chunk.contextReviewState) &&
    chunk.contextText.trim()
    ? `${chunk.contextText.trim()}\n\n${chunk.finalText}`
    : chunk.finalText;
}
