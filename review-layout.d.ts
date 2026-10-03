export type ConfigurationDisclosureInput = {
  mode: "preview" | "draft";
  pinnedOpen?: boolean;
  hasGenerated?: boolean;
  dirty?: boolean;
  generating?: boolean;
  generationFailed?: boolean;
  userExpanded?: boolean;
};

export function resolveConfigurationDisclosure(input: ConfigurationDisclosureInput): boolean;
export function configurationUserExpandedAfterModeChange(input: {
  previousMode: "preview" | "draft";
  nextMode: "preview" | "draft";
  userExpanded?: boolean;
}): boolean;
export function resolveMetricsDisclosure(input: { mode: "preview" | "draft"; userExpanded?: boolean }): boolean;
export function configurationDigest(input: {
  strategy: string;
  imagePolicy: string;
  parameters?: Record<string, string | number>;
  status: string;
}): string;
