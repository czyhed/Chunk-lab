import assert from "node:assert/strict";
import { MemoryParseCacheRepository, ParseCacheService, contentSha256, parserConfigFingerprint } from "./parse-cache.js";
import type { ParseConfig } from "./mineru.js";
import type { AssetDescriptor } from "./asset-contract.js";

const config: ParseConfig = { modelVersion: "vlm", language: "ch", enableTable: true, enableFormula: true, isOcr: false };
const changedConfig: ParseConfig = { ...config, enableTable: false };
const parsedAsset = { key: "parsed", uri: "s3://bucket/parsed" } as AssetDescriptor;

const service = new ParseCacheService(new MemoryParseCacheRepository());
const first = await service.decide(new TextEncoder().encode("same bytes"), config);
assert.equal(first.kind, "owner");
const renamed = await service.decide(new TextEncoder().encode("same bytes"), config);
assert.equal(renamed.kind, "in_flight");
assert.equal(first.contentSha256, renamed.contentSha256);
assert.notEqual(first.contentSha256, contentSha256(new TextEncoder().encode("different")));
assert.notEqual(first.parserConfigFingerprint, parserConfigFingerprint(changedConfig));

await service.setProcessing(first, "mineru-batch", "mineru-document");
const processing = await service.decide(new TextEncoder().encode("same bytes"), config);
assert.equal(processing.kind, "in_flight");
await service.succeed(first, parsedAsset, null);
const hit = await service.decide(new TextEncoder().encode("same bytes"), config);
assert.equal(hit.kind, "succeeded");
assert.equal(hit.record.parsedDocumentAssetRef?.uri, parsedAsset.uri);
assert.equal((await service.decide(new TextEncoder().encode("same bytes"), changedConfig)).kind, "owner");

const concurrent = new ParseCacheService(new MemoryParseCacheRepository());
const claims = await Promise.all(Array.from({ length: 12 }, () => concurrent.decide(new TextEncoder().encode("parallel"), config)));
assert.equal(claims.filter((claim) => claim.kind === "owner").length, 1);

const failedRepo = new MemoryParseCacheRepository();
const failedService = new ParseCacheService(failedRepo);
const failed = await failedService.decide(new TextEncoder().encode("failure"), config);
await failedService.succeed(failed, parsedAsset, null);
await failedService.fail(failed, "late failure");
assert.equal((await failedService.get(failed))!.status, "succeeded");

console.log("Parse cache focused tests passed");
