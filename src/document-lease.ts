import { randomUUID } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

export type DocumentLeaseIdentity = {
  userId: string;
  sessionId: string;
};

export type DocumentLease = DocumentLeaseIdentity & {
  leaseId: string;
  acquiredAt: string;
  lastHeartbeatAt: string;
};

export type DocumentLeaseResult =
  | { ok: true; lease: DocumentLease; ttlSeconds: number }
  | { ok: false; lease: DocumentLease | null; ttlSeconds: number };

export interface DocumentLeaseStore {
  acquire(contentSha256: string, identity: DocumentLeaseIdentity): Promise<DocumentLeaseResult>;
  renew(contentSha256: string, leaseId: string): Promise<DocumentLeaseResult>;
  release(contentSha256: string, leaseId: string): Promise<boolean>;
  get(contentSha256: string): Promise<{ lease: DocumentLease | null; ttlSeconds: number }>;
  close?(): Promise<void>;
}

const RELEASE_SCRIPT = `
local value = redis.call('get', KEYS[1])
if value and string.match(value, '^[^|]+') == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

const RENEW_SCRIPT = `
local value = redis.call('get', KEYS[1])
if value and string.match(value, '^[^|]+') == ARGV[1] then
  redis.call('set', KEYS[1], ARGV[3], 'EX', ARGV[2])
  return ARGV[3]
end
return false
`;

function leaseKey(contentSha256: string): string {
  return `rag:document-lease:${contentSha256}`;
}

function encodeLease(lease: DocumentLease): string {
  return `${lease.leaseId}|${JSON.stringify(lease)}`;
}

function parseLease(value: string | null): DocumentLease | null {
  if (!value) return null;
  try {
    const candidate = JSON.parse(value.slice(value.indexOf("|") + 1)) as Partial<DocumentLease>;
    if (
      typeof candidate.leaseId !== "string" ||
      typeof candidate.userId !== "string" ||
      typeof candidate.sessionId !== "string" ||
      typeof candidate.acquiredAt !== "string" ||
      typeof candidate.lastHeartbeatAt !== "string"
    ) return null;
    return candidate as DocumentLease;
  } catch {
    return null;
  }
}

export function createMemoryDocumentLeaseStore(ttlSeconds = 60): DocumentLeaseStore {
  const records = new Map<string, { lease: DocumentLease; expiresAt: number }>();
  const active = (key: string) => {
    const record = records.get(key);
    if (!record || record.expiresAt <= Date.now()) {
      records.delete(key);
      return null;
    }
    return record;
  };
  return {
    async acquire(contentSha256, identity) {
      const key = leaseKey(contentSha256);
      const current = active(key);
      if (current) return { ok: false, lease: current.lease, ttlSeconds: Math.ceil((current.expiresAt - Date.now()) / 1000) };
      const now = new Date().toISOString();
      const lease = { ...identity, leaseId: randomUUID(), acquiredAt: now, lastHeartbeatAt: now };
      records.set(key, { lease, expiresAt: Date.now() + ttlSeconds * 1000 });
      return { ok: true, lease, ttlSeconds };
    },
    async renew(contentSha256, leaseId) {
      const key = leaseKey(contentSha256);
      const current = active(key);
      if (!current || current.lease.leaseId !== leaseId) return { ok: false, lease: current?.lease ?? null, ttlSeconds: current ? Math.ceil((current.expiresAt - Date.now()) / 1000) : -2 };
      current.lease.lastHeartbeatAt = new Date().toISOString();
      current.expiresAt = Date.now() + ttlSeconds * 1000;
      return { ok: true, lease: current.lease, ttlSeconds };
    },
    async release(contentSha256, leaseId) {
      const key = leaseKey(contentSha256);
      const current = active(key);
      if (!current || current.lease.leaseId !== leaseId) return false;
      records.delete(key);
      return true;
    },
    async get(contentSha256) {
      const current = active(leaseKey(contentSha256));
      return { lease: current?.lease ?? null, ttlSeconds: current ? Math.ceil((current.expiresAt - Date.now()) / 1000) : -2 };
    },
  };
}

export function createRedisDocumentLeaseStore(options: {
  url?: string;
  ttlSeconds?: number;
  client?: RedisClientType;
  connectionTimeoutMs?: number;
} = {}): DocumentLeaseStore {
  const ttlSeconds = options.ttlSeconds ?? 60;
  const connectionTimeoutMs = options.connectionTimeoutMs ?? 3_000;
  const client = options.client ?? createClient({ url: options.url ?? "redis://127.0.0.1:6379" });
  let connected: Promise<unknown> | null = null;
  const ensureConnected = async () => {
    if (client.isOpen) return;
    if (!connected) {
      connected = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Redis connection timed out")), connectionTimeoutMs);
        client.connect().then(() => { clearTimeout(timer); resolve(); }, (error) => { clearTimeout(timer); reject(error); });
      }).finally(() => { connected = null; });
    }
    await connected;
  };
  const read = async (key: string) => {
    await ensureConnected();
    const [value, ttl] = await Promise.all([client.get(key), client.ttl(key)]);
    return { lease: parseLease(value), ttlSeconds: ttl };
  };
  return {
    async acquire(contentSha256, identity) {
      await ensureConnected();
      const now = new Date().toISOString();
      const lease: DocumentLease = { ...identity, leaseId: randomUUID(), acquiredAt: now, lastHeartbeatAt: now };
      const ok = await client.set(leaseKey(contentSha256), encodeLease(lease), { NX: true, EX: ttlSeconds });
      if (ok === "OK") return { ok: true, lease, ttlSeconds };
      const current = await read(leaseKey(contentSha256));
      return { ok: false, lease: current.lease, ttlSeconds: current.ttlSeconds };
    },
    async renew(contentSha256, leaseId) {
      await ensureConnected();
      const current = await read(leaseKey(contentSha256));
      if (!current.lease || current.lease.leaseId !== leaseId) return { ok: false, lease: current.lease, ttlSeconds: current.ttlSeconds };
      const renewed = { ...current.lease, lastHeartbeatAt: new Date().toISOString() };
      const result = await client.eval(RENEW_SCRIPT, { keys: [leaseKey(contentSha256)], arguments: [leaseId, String(ttlSeconds), encodeLease(renewed)] });
      if (result === false || result === null) return { ok: false, lease: null, ttlSeconds: -2 };
      return { ok: true, lease: renewed, ttlSeconds };
    },
    async release(contentSha256, leaseId) {
      await ensureConnected();
      return Number(await client.eval(RELEASE_SCRIPT, { keys: [leaseKey(contentSha256)], arguments: [leaseId] })) === 1;
    },
    get: (contentSha256) => read(leaseKey(contentSha256)),
    async close() {
      if (client.isOpen) await client.quit();
    },
  };
}
