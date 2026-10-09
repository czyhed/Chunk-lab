export type ModelCapability = "vlm" | "context";

export type ModelProfile = {
  id: string;
  name: string;
  capabilities: ModelCapability[];
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
};

export type PublicModelProfile = Pick<
  ModelProfile,
  "id" | "name" | "capabilities"
>;

export function parseModelProfiles(
  value: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): ModelProfile[] {
  if (!value?.trim()) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("MODEL_PROFILES_JSON 必须是数组");
  const ids = new Set<string>();
  return parsed.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("模型 profile 必须是对象");
    const profile = item as Record<string, unknown>;
    const id = requiredString(profile.id, "profile id");
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("profile id 格式无效");
    if (ids.has(id)) throw new Error("profile id 不能重复");
    ids.add(id);
    const capabilities = profile.capabilities;
    if (
      !Array.isArray(capabilities) ||
      !capabilities.length ||
      capabilities.some((value) => value !== "vlm" && value !== "context")
    ) throw new Error("profile capabilities 无效");
    const baseUrl = requiredString(profile.baseUrl, "profile baseUrl");
    const protocol = new URL(baseUrl).protocol;
    if (protocol !== "http:" && protocol !== "https:")
      throw new Error("profile baseUrl 协议无效");
    const timeoutMs = profile.timeoutMs === undefined
      ? 30_000
      : Number(profile.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new Error("profile timeoutMs 无效");
    return {
      id,
      name: requiredString(profile.name, "profile name"),
      capabilities: [...new Set(capabilities)] as ModelCapability[],
      baseUrl,
      apiKey: resolveApiKey(profile.apiKey, environment),
      model: requiredString(profile.model, "profile model"),
      timeoutMs,
    };
  });
}

function resolveApiKey(value: unknown, environment: NodeJS.ProcessEnv): string {
  const apiKey = requiredString(value, "profile apiKey");
  const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(apiKey);
  if (!reference) return apiKey;
  return requiredString(environment[reference[1]], `profile apiKey env ${reference[1]}`);
}

export function publicModelProfiles(
  profiles: readonly ModelProfile[],
): PublicModelProfile[] {
  return profiles.map(({ id, name, capabilities }) => ({
    id,
    name,
    capabilities: [...capabilities],
  }));
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} 不能为空`);
  return value.trim();
}
