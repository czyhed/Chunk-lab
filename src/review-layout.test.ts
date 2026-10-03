import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  configurationUserExpandedAfterModeChange,
  configurationDigest,
  resolveConfigurationDisclosure,
  resolveMetricsDisclosure,
} from "../review-layout.js";

assert.equal(
  configurationUserExpandedAfterModeChange({
    previousMode: "preview",
    nextMode: "draft",
    userExpanded: true,
  }),
  false,
  "entering Draft clears the transient Preview/failure expansion",
);
assert.equal(
  configurationUserExpandedAfterModeChange({
    previousMode: "draft",
    nextMode: "draft",
    userExpanded: true,
  }),
  true,
  "rerendering Draft preserves an explicit Draft expansion",
);

assert.equal(
  resolveConfigurationDisclosure({ mode: "preview", hasGenerated: false }),
  true,
  "an ungenerated configuration stays expanded",
);
assert.equal(
  resolveConfigurationDisclosure({ mode: "preview", hasGenerated: true }),
  false,
  "a clean successful Preview defaults Configuration Draft to collapsed",
);
assert.equal(
  resolveConfigurationDisclosure({ mode: "draft", hasGenerated: true }),
  false,
  "Draft defaults Configuration Draft to one summary row",
);
assert.equal(
  resolveConfigurationDisclosure({ mode: "draft", hasGenerated: true, pinnedOpen: true }),
  true,
  "the locally remembered pin keeps Draft configuration expanded",
);
for (const state of [
  { dirty: true },
  { generating: true },
  { generationFailed: true },
  { userExpanded: true },
]) {
  assert.equal(
    resolveConfigurationDisclosure({ mode: "draft", hasGenerated: true, ...state }),
    true,
    "dirty, generating, failed, or explicit user review exposes the configuration",
  );
}
assert.equal(resolveMetricsDisclosure({ mode: "preview" }), true);
assert.equal(resolveMetricsDisclosure({ mode: "draft" }), false);
assert.equal(
  resolveMetricsDisclosure({ mode: "draft", userExpanded: true }),
  true,
);
assert.equal(
  configurationDigest({
    strategy: "semantic",
    imagePolicy: "summary",
    parameters: { buffer: 2, threshold: 88, max: 768 },
    status: "Draft 已确认",
  }),
  "Semantic Boundary · Buffer 2 · 断点 88% · 最大 768 · 摘要 + 引用 · Draft 已确认",
);

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
assert.match(html, /id="configDisclosureToggle"[^>]*aria-expanded="true"/);
assert.match(html, /id="configDisclosureContent"/);
assert.match(html, /id="pinConfigOpen"[^>]*type="checkbox"/);
assert.match(html, /id="configDigest"/);
assert.match(html, /id="metricsDisclosureToggle"[^>]*aria-expanded="true"/);
assert.match(html, /id="metricsDisclosureContent"/);

const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
assert.match(
  css,
  /@media\(min-width:1101px\) and \(max-width:1279px\)\{body\{overflow:auto\}\.workspace\{min-width:1280px\}/,
  "the 1280px desktop canvas must not apply to 1024px and mobile viewports",
);
assert.match(
  css,
  /@media\(max-width:1100px\)\{\.workspace,\.app-shell\.rail-collapsed \.workspace\{grid-template-columns:190px minmax\(360px,1fr\);min-width:0\}/,
  "the final narrow-workspace rule must override the desktop minimum width",
);

console.log("Review layout disclosure tests passed");
