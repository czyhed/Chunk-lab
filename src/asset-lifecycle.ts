import { assetPolicy, type AssetDescriptor } from "./asset-contract.js";
import type { AssetObjectStore } from "./object-store.js";

const ORPHAN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type AssetLifecycleReference = {
  key: string;
  state: "active" | "failed";
};

export type AssetLifecycleSweepResult = {
  examined: number;
  softDeleted: number;
  retained: number;
  alreadyDeleted: number;
  failed: number;
  reasons: { expired: number; orphan: number };
  failures: Array<{ key: string; code: "SOFT_DELETE_FAILED" }>;
};

export async function sweepAssetLifecycle(
  store: AssetObjectStore,
  input: {
    now: string;
    allowedPrefix: string;
    references: readonly AssetLifecycleReference[];
    deleteGraceMs: number;
  },
): Promise<AssetLifecycleSweepResult> {
  validateScope(input.allowedPrefix);
  const now = isoTimestamp(input.now, "now");
  if (!Number.isSafeInteger(input.deleteGraceMs) || input.deleteGraceMs < 0)
    throw new Error("deleteGraceMs is invalid");
  const objects = await store.list({
    prefix: input.allowedPrefix,
    includeDeleted: true,
  });
  const statesByKey = new Map<string, Array<AssetLifecycleReference["state"]>>();
  for (const reference of input.references) {
    const states = statesByKey.get(reference.key) ?? [];
    states.push(reference.state);
    statesByKey.set(reference.key, states);
  }

  const result: AssetLifecycleSweepResult = {
    examined: objects.length,
    softDeleted: 0,
    retained: 0,
    alreadyDeleted: 0,
    failed: 0,
    reasons: { expired: 0, orphan: 0 },
    failures: [],
  };
  for (const object of objects) {
    if (object.deletedAt) {
      result.alreadyDeleted += 1;
      continue;
    }
    const reason = deletionReason(object, statesByKey.get(object.key) ?? [], now);
    if (!reason) {
      result.retained += 1;
      continue;
    }
    try {
      await store.softDelete(object.key, {
        at: input.now,
        deleteAfter: new Date(now + input.deleteGraceMs).toISOString(),
        activeReferenceCount: 0,
        reason,
      });
      result.softDeleted += 1;
      result.reasons[reason] += 1;
    } catch {
      result.failed += 1;
      result.failures.push({ key: object.key, code: "SOFT_DELETE_FAILED" });
    }
  }
  return result;
}

function deletionReason(
  object: AssetDescriptor,
  referenceStates: readonly AssetLifecycleReference["state"][],
  now: number,
): "expired" | "orphan" | null {
  const hasActiveReference = referenceStates.includes("active");
  const orphaned = referenceStates.length === 0 || !hasActiveReference;
  if (orphaned && Date.parse(object.createdAt) + ORPHAN_RETENTION_MS <= now)
    return "orphan";

  const policy = assetPolicy(object.assetClass);
  if (policy.retention.kind === "document_delete") return null;
  if (object.expiresAt && Date.parse(object.expiresAt) <= now) return "expired";
  return null;
}

function validateScope(prefix: string): void {
  const parts = prefix.split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "v1" || prefix === "v1/")
    throw new Error(
      "Lifecycle sweep requires a dedicated prefix containing asset class and batch",
    );
}

function isoTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
    throw new Error(`${label} must be an ISO timestamp`);
  return parsed;
}
