import { classifySource } from "./v21-input.js";

export function planUpload(name: string) {
  const classification = classifySource(name);
  return {
    parseRoute: classification.parseRoute,
    createVisualCopy: classification.requiresVisualCopy,
    preferredSourceViewKind: classification.preferredSourceViewKind,
  };
}
