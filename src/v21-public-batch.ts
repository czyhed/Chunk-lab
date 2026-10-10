type PublicBatchInput = {
  id: string;
  documents: Array<{
    [key: string]: unknown;
    id: string;
    name: string;
    state: string;
    error?: string;
    progress?: { extractedPages: number; totalPages: number };
    diagnosticCategories?: Array<
      | "parse_failed"
      | "mineru_result_anomaly"
      | "bbox_page_anomaly"
      | "visual_conversion_failed"
    >;
    blocks?: unknown[];
    sourceAsset?: unknown;
    visualCopyAsset?: unknown;
      sourceContract?: {
        sourceDocumentVersion: string;
        sourceViewKind: string;
        parseJobId?: string | null;
      visualCopy: {
        state: string;
        qualityFlag?: string;
        error?: string;
        [key: string]: unknown;
      };
    };
    reviewState: {
      preview?: { chunks: PublicChunk[] } | null;
      draft?: { chunks: PublicChunk[] } | null;
    };
    embeddingJobs?: unknown[];
    databaseJobs?: unknown[];
    contentSha256?: string;
    parserConfigFingerprint?: string;
    parseCacheStatus?: string;
    parseCacheReused?: boolean;
    parsedDocumentAsset?: { uri: string; checksumSha256: string; assetClass: string };
    trustedResultAsset?: { uri: string; checksumSha256: string; assetClass: string };
  }>;
};

type PublicChunk = {
  qualityFlags: readonly string[];
  embeddingEligible?: boolean;
};

export function buildPublicBatch(batch: PublicBatchInput) {
  return {
    id: batch.id,
    documents: batch.documents.map((document) => {
      const chunks =
        document.reviewState.draft?.chunks ??
        document.reviewState.preview?.chunks ??
        [];
      const diagnosticCategories = [...new Set([
        ...(document.diagnosticCategories ?? []),
        ...(document.sourceContract?.visualCopy.state === "failed"
          ? (["visual_conversion_failed"] as const)
          : []),
      ])];
      return {
        id: document.id,
        name: document.name,
        state: document.state,
        ...(document.error ? { error: document.error } : {}),
        ...(document.progress ? { progress: { ...document.progress } } : {}),
        blockCount: document.blocks?.length ?? 0,
        chunkCount: chunks.length,
        qualityFlagCount: chunks.reduce(
          (count, chunk) => count + chunk.qualityFlags.length,
          0,
        ),
        embeddingIneligibleCount: chunks.filter(
          (chunk) => chunk.embeddingEligible === false,
        ).length,
        sourceAvailable: Boolean(document.sourceAsset),
        visualCopyAvailable: Boolean(document.visualCopyAsset),
        ...(Array.isArray(document.pendingSpuIds) ? { pendingSpuIds: [...document.pendingSpuIds] } : {}),
        ...(Array.isArray(document.targetSpuIds) ? { targetSpuIds: [...document.targetSpuIds] } : {}),
        ...(typeof document.spuDocumentType === "string" ? { spuDocumentType: document.spuDocumentType } : {}),
        ...(typeof document.spuScopeStatus === "string" ? { spuScopeStatus: document.spuScopeStatus } : {}),
        ...(document.embeddingJobs?.length
          ? { embeddingJob: publicEmbeddingJob(document.embeddingJobs.at(-1)) }
          : {}),
        ...(document.databaseJobs?.length
          ? { databaseJob: structuredClone(document.databaseJobs.at(-1)) }
          : {}),
        ...(document.contentSha256 ? { contentSha256: document.contentSha256 } : {}),
        ...(document.parserConfigFingerprint ? { parserConfigFingerprint: document.parserConfigFingerprint } : {}),
        ...(document.parseCacheStatus ? { parseCacheStatus: document.parseCacheStatus } : {}),
        ...(document.parseCacheReused ? { parseCacheReused: true } : {}),
        ...(document.parsedDocumentAsset ? { parsedDocumentAssetRef: publicAssetRef(document.parsedDocumentAsset) } : {}),
        ...(document.trustedResultAsset ? { mineruResultAssetRef: publicAssetRef(document.trustedResultAsset) } : {}),
        ...(diagnosticCategories.length
          ? { diagnostic: { categories: diagnosticCategories } }
          : {}),
        ...(document.sourceContract
          ? {
              sourceContract: {
                sourceDocumentVersion:
                  document.sourceContract.sourceDocumentVersion,
                sourceViewKind: document.sourceContract.sourceViewKind,
                ...(document.sourceContract.parseJobId !== undefined
                  ? { parseJobId: document.sourceContract.parseJobId }
                  : {}),
                visualCopy: {
                  state: document.sourceContract.visualCopy.state,
                  qualityFlag:
                    document.sourceContract.visualCopy.qualityFlag,
                },
              },
            }
          : {}),
      };
    }),
  };
}

function publicEmbeddingJob(value: unknown): unknown {
  const job = structuredClone(value) as {
    items?: Array<{ vectorRecord?: Record<string, unknown> }>;
  };
  for (const item of job.items ?? []) {
    if (item.vectorRecord) delete item.vectorRecord.vector;
  }
  return job;
}

function publicAssetRef(value: { uri: string; checksumSha256: string; assetClass: string }) {
  return { uri: value.uri, checksumSha256: value.checksumSha256, assetClass: value.assetClass };
}
