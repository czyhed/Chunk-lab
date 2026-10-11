import type { Chunk, ChunkRequest } from "./chunking.js";
import { embeddingTextFor } from "./contextual.js";
import { parentContextFor } from "./parent-context.js";

export type DocumentExportInput = {
  documentId: string;
  name: string;
  chunks: Chunk[];
  configuration: ChunkRequest;
  parserVersion: string | null;
  embeddingModel: string | null;
};

export function buildDocumentExport(input: DocumentExportInput) {
  return {
    documentId: input.documentId,
    name: input.name,
    chunks: input.chunks.map((chunk) => ({
      chunkId: chunk.id,
      type: chunk.type,
      automaticText: chunk.automaticText,
      finalText: chunk.finalText,
      contextText: chunk.contextText,
      contextReviewState: chunk.contextReviewState,
      embeddingText: embeddingTextFor(chunk),
      sourceSegments: structuredClone(chunk.sourceSegments),
      productIdentity: chunk.productIdentity ?? null,
      parentSectionId: chunk.parentSectionId ?? null,
      ...(chunk.parentChunk ? { parentChunk: parentContextFor(chunk, input.chunks) } : {}),
      relatedChunkIds: [...chunk.relatedChunkIds],
      qualityFlags: [...chunk.qualityFlags],
      revisions: structuredClone(chunk.revisions),
      chunkingStrategy: input.configuration.strategy,
      chunkingParameters: structuredClone(input.configuration),
      parserVersion: input.parserVersion,
      embeddingModel: input.embeddingModel,
      contextModel: chunk.contextModel ?? null,
      contextPromptVersion: chunk.contextPromptVersion ?? null,
      contextScope: [...(chunk.contextScope ?? [])],
      excluded: chunk.excluded,
    })),
  };
}
