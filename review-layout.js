export function resolveConfigurationDisclosure({
  mode,
  pinnedOpen = false,
  hasGenerated = false,
  dirty = false,
  generating = false,
  generationFailed = false,
  userExpanded = false,
}) {
  return pinnedOpen || !hasGenerated || dirty || generating || generationFailed || userExpanded;
}

export function configurationUserExpandedAfterModeChange({
  previousMode,
  nextMode,
  userExpanded = false,
}) {
  return previousMode !== nextMode && nextMode === "draft" ? false : userExpanded;
}

export function resolveMetricsDisclosure({ mode, userExpanded = false }) {
  return mode !== "draft" || userExpanded;
}

export function configurationDigest({ strategy, imagePolicy, parameters = {}, status }) {
  const strategyLabel = {
    manual: "人工框选",
    structure: "Structure-Aware",
    sentence: "SentenceSplitter",
    token: "TokenTextSplitter",
    semantic: "Semantic Boundary",
  }[strategy] ?? strategy;
  const imageLabel = { summary: "摘要 + 引用", reference: "仅引用", exclude: "排除" }[imagePolicy] ?? imagePolicy;
  const parameterLabels = strategy === "semantic"
    ? [`Buffer ${parameters.buffer}`, `断点 ${parameters.threshold}%`, `最大 ${parameters.max}`]
    : strategy === "manual"
      ? []
      : [`最大 ${parameters.size}`, `Overlap ${parameters.overlap}`];
  return [strategyLabel, ...parameterLabels, imageLabel, status].filter(Boolean).join(" · ");
}
