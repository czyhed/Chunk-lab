import type { ParsedBlock } from "./chunking.js";
import { createReviewState, type ReviewState } from "./review-state.js";
import type { MineruResult } from "./mineru.js";
import type { DiagnosticCategory } from "./v21-diagnostic-package.js";

export type ParseLifecycleDocument = {
  id: string;
  name: string;
  state: "pending" | "running" | "done" | "failed";
  error?: string;
  progress?: { extractedPages: number; totalPages: number };
  markdown?: string;
  blocks?: ParsedBlock[];
  rawContentList?: unknown[];
  parsedDocumentV21?: unknown;
  diagnosticCategories?: DiagnosticCategory[];
  reviewState: ReviewState;
};

type DownloadResult = (
  url: string,
  document: ParseLifecycleDocument,
  result: MineruResult,
) => Promise<{
  markdown: string;
  blocks: ParsedBlock[];
  rawContentList?: unknown[];
}>;

export async function applyMineruResults(
  documents: ParseLifecycleDocument[],
  results: MineruResult[],
  downloadResult: DownloadResult,
): Promise<void> {
  for (const result of results) {
    const document =
      documents.find((item) => item.id === result.data_id) ??
      documents.find((item) => item.name === result.file_name);
    if (!document) continue;
    if (
      document.state === "done" &&
      document.blocks &&
      result.state !== "done"
    )
      continue;
    if (result.extract_progress)
      document.progress = {
        extractedPages: result.extract_progress.extracted_pages,
        totalPages: result.extract_progress.total_pages,
      };
    if (result.state === "failed") {
      document.state = "failed";
      document.error = result.err_msg || "MinerU 解析失败";
      document.diagnosticCategories = ["parse_failed"];
      continue;
    }
    if (result.state === "waiting-file" || result.state === "pending") {
      document.state = "pending";
      document.error = undefined;
      continue;
    }
    if (result.state === "running" || result.state === "converting") {
      document.state = "running";
      document.error = undefined;
      continue;
    }
    if (document.blocks) {
      document.state = "done";
      document.error = undefined;
      continue;
    }
    if (!result.full_zip_url) {
      document.state = "failed";
      document.error = "MinerU 完成但未提供结果 ZIP";
      document.diagnosticCategories = ["mineru_result_anomaly"];
      continue;
    }
    document.state = "running";
    document.error = undefined;
    try {
      const parsed = await downloadResult(result.full_zip_url, document, result);
      document.markdown = parsed.markdown;
      document.blocks = parsed.blocks;
      document.rawContentList = parsed.rawContentList;
      document.state = "done";
      delete document.diagnosticCategories;
    } catch (error) {
      document.state = "failed";
      document.error =
        error instanceof Error ? error.message : "解析结果下载失败";
      document.diagnosticCategories = ["mineru_result_anomaly"];
    }
  }
}

export function resetDocumentForReparse(
  document: ParseLifecycleDocument,
): void {
  document.state = "pending";
  delete document.error;
  delete document.progress;
  delete document.markdown;
  delete document.blocks;
  delete document.rawContentList;
  delete document.parsedDocumentV21;
  delete document.diagnosticCategories;
  document.reviewState = createReviewState();
}

export function mineruBatchIdsFor(
  batch: { mineruBatchIds?: string[]; mineruBatchId?: string },
  additionalId?: string,
): string[] {
  return [
    ...new Set([
      ...(batch.mineruBatchIds ?? []),
      ...(batch.mineruBatchId ? [batch.mineruBatchId] : []),
      ...(additionalId ? [additionalId] : []),
    ]),
  ];
}
