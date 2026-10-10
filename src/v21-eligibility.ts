import { createHash } from "node:crypto";
import type { ContentBlock } from "./v21-contract.js";

export type LocationQuality = "exact" | "page_only" | "parsed_only" | "unavailable";

export type EmbeddingExclusionReason =
  | "unsupported_content"
  | "normalization_failed"
  | "partial_content_unconfirmed"
  | "manual_fix_unvalidated"
  | "missing_reliable_search_text"
  | "image_only_without_reliable_text"
  | "reference_requires_related_text"
  | "image_reference_uses_related_text";

export type EligibilityQualityFlag =
  | "source_location_page_only"
  | "source_location_parsed_only"
  | "source_location_unavailable"
  | "image_asset_unavailable";

export type EligibilityResult = {
  embeddingEligible: boolean;
  embeddingExclusionReasons: EmbeddingExclusionReason[];
  qualityFlags: EligibilityQualityFlag[];
  embeddingText: null;
};

export type ManualValidation = {
  reviewedModelValid: boolean;
  sourceValid: boolean;
  searchTextValid: boolean;
};

export function reliableSearchText(block: Pick<ContentBlock, "searchText" | "finalText" | "automaticText">): string {
  return [block.searchText, block.finalText, block.automaticText]
    .map((value) => value?.trim() ?? "")
    .find(Boolean) ?? "";
}

export function evaluateEmbeddingEligibility(input: {
  block: ContentBlock;
  locationQuality: LocationQuality;
  imageAssetAvailable?: boolean;
  partialSemanticsConfirmed?: boolean;
  manualValidation?: ManualValidation;
}): EligibilityResult {
  const reasons: EmbeddingExclusionReason[] = [];
  const qualityFlags: EligibilityQualityFlag[] = [];
  const searchText = reliableSearchText(input.block);

  if (input.locationQuality !== "exact")
    qualityFlags.push(`source_location_${input.locationQuality}` as EligibilityQualityFlag);
  if (input.imageAssetAvailable === false) qualityFlags.push("image_asset_unavailable");

  if (input.block.normalizationStatus === "unsupported" && !searchText)
    reasons.push("unsupported_content");
  if (input.block.normalizationStatus === "failed") reasons.push("normalization_failed");
  if (input.block.normalizationStatus === "partial" && !input.partialSemanticsConfirmed)
    reasons.push("partial_content_unconfirmed");
  if (
    input.block.normalizationStatus === "manual_fixed" &&
    (!input.manualValidation || Object.values(input.manualValidation).some((valid) => !valid))
  )
    reasons.push("manual_fix_unvalidated");
  if (!searchText) reasons.push("missing_reliable_search_text");
  if (
    input.block.contentType === "image" &&
    !searchText &&
    input.imageAssetAvailable !== true
  )
    reasons.push("image_only_without_reliable_text");

  return {
    embeddingEligible: reasons.length === 0,
    embeddingExclusionReasons: reasons,
    qualityFlags,
    embeddingText: null,
  };
}

export type NormalizedVersionInput = {
  sourceDocumentVersion: string;
  parsedDocumentVersion: string;
  normalizerVersion: string;
  normalizedModelVersion: string;
  normalizedModelInput: unknown;
};

export function deriveNormalizedVersion(input: NormalizedVersionInput): Readonly<{
  normalizedContentVersion: string;
  fingerprint: string;
}> {
  const fingerprint = createHash("sha256").update(stableJson(input)).digest("hex");
  return Object.freeze({
    normalizedContentVersion: `normalized-${fingerprint.slice(0, 16)}`,
    fingerprint,
  });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}
