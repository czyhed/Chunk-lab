import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const directory = resolve("output/evidence/object-storage-real-suppliers-production-readiness");
const read = async (name) => JSON.parse(await readFile(resolve(directory, name), "utf8"));
const [
  classes,
  mineru,
  chain,
  lifecycle,
  minio,
  minioRestore,
  postgresInit,
  postgresRestore,
  postgresRestart,
  browser,
  secrets,
  finalValidation,
] = await Promise.all([
  read("object-class-coverage.json"),
  read("real-mineru-matrix.json"),
  read("real-context-embedding-full-chain.json"),
  read("lifecycle-sweep.json"),
  read("minio-production-like.json"),
  read("minio-backup-restore.json"),
  read("postgres-empty-init.json"),
  read("postgres-backup-restore.json"),
  read("postgres-restart-http.json"),
  read("browser-current-validation.json"),
  read("secret-scan.json"),
  read("final-validation.json"),
]);

assert.equal(classes.verifiedClassCount, 12);
assert.equal(mineru.materialCount, 7);
assert.equal(mineru.mineruSubmissionCount, 7);
assert.equal(mineru.mineruAutomaticRetryCount, 0);
assert.equal(mineru.entries.every((entry) => entry.terminalState === "done"), true);
assert.equal(chain.context.finalReviewState, "confirmed");
assert.equal(chain.context.staleObservedAfterTextRevision, true);
assert.equal(chain.embedding.observedDimensions, 1024);
assert.equal(chain.database.schemaVersion, "2.0");
assert.equal(chain.contract21.forbiddenPayloadsAbsent, true);
assert.equal(lifecycle.activeReferenceProtected, true);
assert.equal(lifecycle.lifecycleAuditVerified, true);
assert.equal(minio.minioRestartRecovered, true);
assert.equal(minio.diagnosticPackageHeadPassed, true);
assert.equal(minioRestore.restoredApplicationListAndHead, true);
assert.equal(postgresInit.vectorType, "vector(1024)");
assert.equal(postgresRestore.status, "succeeded");
assert.equal(postgresRestore.vectorDimensions, 1024);
assert.equal(postgresRestore.vectorIndexValid, true);
assert.equal(postgresRestart.publicRecordsOmitVector, true);
assert.equal(browser.desktop.rootHorizontalOverflow, false);
assert.equal(browser.mobile.rootHorizontalOverflow, false);
assert.equal(browser.desktop.consoleErrorsOrWarnings, 0);
assert.equal(browser.mobile.consoleErrorsOrWarnings, 0);
assert.equal(secrets.actualSecretValueMatches, 0);
assert.equal(secrets.publicHttpForbiddenPatterns, 0);
assert.equal(finalValidation.commands.npmTest, "passed");
assert.equal(finalValidation.commands.npmRunTypecheck, "passed");
assert.equal(finalValidation.commands.npmRunBuild, "passed");

const profileResponse = await fetch(
  `${process.env.ACCEPTANCE_BASE_URL || "http://127.0.0.1:43120"}/api/model-profiles`,
);
assert.equal(profileResponse.status, 200);
const profiles = (await profileResponse.json()).profiles;
const vlmProfiles = profiles.filter((profile) => profile.capabilities.includes("vlm"));
assert.equal(vlmProfiles.length, 0);

const requirements = [
  { id: 1, status: "passed", evidence: ["object-class-coverage.json", "docs/adr/0006-object-storage-and-lifecycle.md"] },
  { id: 2, status: "passed_local", evidence: ["real-mineru-matrix.json", "page-render-minio.json", "browser-current-validation.json"] },
  { id: 3, status: "passed_local", evidence: ["lifecycle-sweep.json", "minio-audit.json"] },
  { id: 4, status: "passed", evidence: ["real-mineru-matrix.json"] },
  { id: 5, status: "passed", evidence: ["real-mineru-matrix.json"] },
  { id: 6, status: "partial_external_vlm_profile_missing", evidence: ["real-context-embedding-full-chain.json", "page-render-minio.json"] },
  { id: 7, status: "passed_local", evidence: ["postgres-empty-init.json", "postgres-backup-restore.json", "postgres-restart-http.json"] },
  { id: 8, status: "passed_local_production_like", evidence: ["minio-backup-restore.json", "docs/runbooks/storage-production.md", "docs/deployment/storage-checklist.md"] },
  { id: 9, status: "pending_external_deployment_authorization", evidence: ["docs/deployment/storage-checklist.md"] },
];

const result = {
  status: "local_production_like_complete_external_vlm_and_remote_pending",
  requirements,
  verifiedLocalRequirements: requirements.filter((item) => item.status.startsWith("passed")).map((item) => item.id),
  incompleteRequirements: requirements.filter((item) => !item.status.startsWith("passed")).map((item) => item.id),
  realSupplierCalls: {
    mineruSubmissions: mineru.mineruSubmissionCount,
    vlm: chain.vlmPaidCallsThisRun,
    context: chain.context.paidCallsThisRun,
    embeddingBatches: finalValidation.paidCalls.embeddingBatches,
  },
  currentServerProfiles: profiles.map((profile) => ({
    id: profile.id,
    capabilities: profile.capabilities,
  })),
  blockers: [
    "confirmed server-side VLM profile, visual model ID, and secret environment reference",
    "remote host/account/inventory, DNS/TLS, backup destination, maintenance window, and rollback owner",
  ],
  productionClaimAllowed: false,
};
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, "completion-audit.json"), JSON.stringify(result, null, 2), "utf8");
console.log(JSON.stringify({
  status: result.status,
  verifiedLocalRequirements: result.verifiedLocalRequirements,
  incompleteRequirements: result.incompleteRequirements,
  productionClaimAllowed: result.productionClaimAllowed,
}));
