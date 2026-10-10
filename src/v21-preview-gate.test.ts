import assert from "node:assert/strict";
import { buildChunkPreview, type ChunkRequest, type ParsedBlock } from "./chunking.js";
import { GenerationGate } from "./generation-gate.js";
import {
  adoptPreview,
  completePreviewGeneration,
  configurationFingerprint,
  createPreviewGateState,
  previewMetricDelta,
  startPreviewGeneration,
  updateConfigurationDraft,
} from "./v21-preview-gate.js";

const blocks: ParsedBlock[] = [
  {
    id: "b1",
    type: "text",
    role: "paragraph",
    text: "安装前请切断电源。确认额定电压后再连接设备。",
    page: 1,
    bbox: [10, 10, 200, 60],
    readingOrder: 0,
    productIdentity: "A1",
  },
];

const configuration: ChunkRequest = {
  strategy: "structure",
  chunkSize: 128,
  chunkOverlap: 16,
  bufferSize: 1,
  breakpointPercentile: 90,
  semanticMaxChunkSize: 768,
  imagePolicy: "summary",
};

const generationGate = new GenerationGate();
let state = createPreviewGateState(configuration);
assert.equal(state.configurationDraft.fingerprint, configurationFingerprint(configuration));
assert.equal(state.preview, null);
assert.equal(state.draft, null);

const ticketA = generationGate.begin("doc-1", "preview");
const startedA = startPreviewGeneration(state, ticketA);
state = startedA.state;
const previewA = await buildChunkPreview(blocks, startedA.request.configuration);
const completedA = completePreviewGeneration(state, startedA.request, previewA);
if (!completedA.ok) throw new Error(completedA.message);
assert.equal(completedA.ok, true);
state = completedA.state;
assert.equal(state.preview?.expired, false);

const changedConfiguration = { ...configuration, chunkSize: 48 };
state = updateConfigurationDraft(state, changedConfiguration);
assert.equal(state.preview?.expired, true, "changing configuration expires the old Preview");
assert.notEqual(
  state.configurationDraft.fingerprint,
  state.preview?.configurationFingerprint,
  "Configuration Draft and Preview fingerprints are persisted separately",
);

const expiredAdoption = adoptPreview(state);
if (expiredAdoption.ok) throw new Error("expired Preview was adopted");
assert.deepEqual(
  { ok: expiredAdoption.ok, status: expiredAdoption.status, code: expiredAdoption.code },
  { ok: false, status: 409, code: "PREVIEW_EXPIRED" },
);

const ticketB = generationGate.begin("doc-1", "preview");
const startedB = startPreviewGeneration(state, ticketB);
state = startedB.state;
const previewB = await buildChunkPreview(blocks, startedB.request.configuration);

const staleCompletion = completePreviewGeneration(state, startedA.request, previewA);
if (staleCompletion.ok) throw new Error("stale generation result was accepted");
assert.deepEqual(
  { ok: staleCompletion.ok, status: staleCompletion.status, code: staleCompletion.code },
  { ok: false, status: 409, code: "STALE_GENERATION_TICKET" },
  "an older generation result cannot overwrite a newer request",
);

const completedB = completePreviewGeneration(state, startedB.request, previewB);
if (!completedB.ok) throw new Error(completedB.message);
assert.equal(completedB.ok, true);
state = completedB.state;

const ticketC = generationGate.begin("doc-1", "preview");
state = startPreviewGeneration(state, ticketC).state;
const staleAdoption = adoptPreview(state);
if (staleAdoption.ok) throw new Error("Preview with stale ticket was adopted");
assert.deepEqual(
  { ok: staleAdoption.ok, status: staleAdoption.status, code: staleAdoption.code },
  { ok: false, status: 409, code: "STALE_GENERATION_TICKET" },
  "a Preview cannot be adopted after a newer generation starts",
);

// Complete the current request, then the first adoption is a single step.
const startedC = startPreviewGeneration(completedB.state, ticketC);
const completedC = completePreviewGeneration(startedC.state, startedC.request, previewB);
if (!completedC.ok) throw new Error(completedC.message);
assert.equal(completedC.ok, true);
const firstAdoption = adoptPreview(completedC.state, { now: "2026-08-13T00:00:00.000Z" });
if (!firstAdoption.ok) throw new Error(firstAdoption.message);
assert.equal(firstAdoption.ok, true);
state = firstAdoption.state;
assert.equal(state.preview, null);
assert.equal(state.draft?.configurationFingerprint, configurationFingerprint(changedConfiguration));
assert.equal(state.draft?.snapshot.confirmedAt, "2026-08-13T00:00:00.000Z");

// Replacing a manually reviewed Draft reports the destructive impact first.
state.draft!.snapshot.chunks[0].revisions.push({
  type: "text",
  at: "2026-08-13T00:01:00.000Z",
  before: "before",
  after: "after",
});
state.draft!.snapshot.chunks[0].contextReviewState = "human_modified";
state.draft!.snapshot.chunks[0].contextText = "人工上下文";

const replacementTicket = generationGate.begin("doc-1", "preview");
const replacementStart = startPreviewGeneration(state, replacementTicket);
const replacementPreview = await buildChunkPreview(blocks, replacementStart.request.configuration);
const replacementComplete = completePreviewGeneration(
  replacementStart.state,
  replacementStart.request,
  replacementPreview,
);
if (!replacementComplete.ok) throw new Error(replacementComplete.message);
assert.equal(replacementComplete.ok, true);

const confirmationRequired = adoptPreview(replacementComplete.state);
if (confirmationRequired.ok) throw new Error("reviewed Draft was replaced without confirmation");
assert.equal(confirmationRequired.ok, false);
assert.deepEqual(
  confirmationRequired.impact,
  { humanRevisionCount: 1, contextCount: 1, affectedChunkCount: 1 },
);
assert.equal(confirmationRequired.code, "REPLACEMENT_CONFIRMATION_REQUIRED");

const replacementAdoption = adoptPreview(replacementComplete.state, {
  confirmReplacement: true,
  now: "2026-08-13T00:02:00.000Z",
});
if (!replacementAdoption.ok) throw new Error(replacementAdoption.message);
assert.equal(replacementAdoption.ok, true);
assert.equal(replacementAdoption.impact.humanRevisionCount, 1);
assert.equal(replacementAdoption.impact.contextCount, 1);

assert.deepEqual(
  previewMetricDelta(
    {
      ...previewA.metrics,
      chunkCount: 2,
      oversizedCount: 1,
      token: { minimum: 10, average: 20, maximum: 30 },
    },
    {
      ...previewA.metrics,
      chunkCount: 3,
      oversizedCount: 0,
      token: { minimum: 8, average: 24, maximum: 40 },
    },
  ),
  {
    chunkCount: 1,
    tokenMinimum: -2,
    tokenAverage: 4,
    tokenMaximum: 10,
    oversizedCount: -1,
    undersizedCount: 0,
    actualOverlapRatio: 0,
    crossPageCount: 0,
    missingProductIdentityCount: 0,
    contextCandidateCount: 0,
  },
);

console.log("V2.1 Preview gate tests passed");
