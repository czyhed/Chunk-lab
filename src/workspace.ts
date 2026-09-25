import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

export class WorkspaceStore {
  readonly root: string;
  readonly maxAgeMs: number;
  private readonly batchWrites = new Map<string, Promise<void>>();
  private catalogWrite = Promise.resolve();

  constructor(root = resolve(".workspace"), maxAgeMs = 24 * 60 * 60 * 1000) {
    this.root = resolve(root);
    this.maxAgeMs = maxAgeMs;
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.root, "batches"), { recursive: true });
    await mkdir(join(this.root, "assets"), { recursive: true });
    await mkdir(join(this.root, "diagnostics"), { recursive: true });
  }

  async writeBatch<T>(batchId: string, value: T): Promise<void> {
    const id = safeId(batchId);
    const previous = this.batchWrites.get(id) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      await this.initialize();
      const target = join(this.root, "batches", `${id}.json`);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(value), "utf8");
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.batchWrites.set(id, write);
    try {
      await write;
    } finally {
      if (this.batchWrites.get(id) === write) this.batchWrites.delete(id);
    }
  }

  async readBatch<T>(batchId: string): Promise<T | null> {
    try {
      const path = join(this.root, "batches", `${safeId(batchId)}.json`);
      if (Date.now() - (await stat(path)).mtimeMs > this.maxAgeMs) return null;
      return JSON.parse(
        await readFile(path, "utf8"),
      ) as T;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return null;
      throw error;
    }
  }

  async readBatchForMaintenance<T>(batchId: string): Promise<T | null> {
    try {
      return JSON.parse(
        await readFile(join(this.root, "batches", `${safeId(batchId)}.json`), "utf8"),
      ) as T;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return null;
      throw error;
    }
  }

  async writeSpuCatalog<T>(value: T): Promise<void> {
    const write = this.catalogWrite.catch(() => undefined).then(async () => {
      await this.initialize();
      const target = join(this.root, "spu-catalog.json");
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(value), "utf8");
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.catalogWrite = write;
    await write;
  }

  async readSpuCatalog<T>(): Promise<T | null> {
    try {
      return JSON.parse(await readFile(join(this.root, "spu-catalog.json"), "utf8")) as T;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async writeDiagnostic<T extends { expiresAt: string }>(
    packageId: string,
    value: T,
  ): Promise<void> {
    await this.initialize();
    const target = join(
      this.root,
      "diagnostics",
      `${safeId(packageId)}.json`,
    );
    const temporary = `${target}.tmp`;
    await writeFile(temporary, JSON.stringify(value), "utf8");
    await rename(temporary, target);
  }

  async readDiagnostic<T extends { expiresAt: string }>(
    packageId: string,
  ): Promise<T | null> {
    const result = await this.readDiagnosticState<T>(packageId);
    return result.status === "available" ? result.value : null;
  }

  async readDiagnosticState<T extends { expiresAt: string }>(
    packageId: string,
  ): Promise<
    | { status: "available"; value: T }
    | { status: "expired" }
    | { status: "missing" }
  > {
    try {
      const path = join(
        this.root,
        "diagnostics",
        `${safeId(packageId)}.json`,
      );
      const value = JSON.parse(await readFile(path, "utf8")) as T;
      return Date.parse(value.expiresAt) > Date.now()
        ? { status: "available", value }
        : { status: "expired" };
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return { status: "missing" };
      throw error;
    }
  }

  async saveAsset(
    batchId: string,
    documentId: string,
    originalName: string,
    sourcePath: string,
  ): Promise<string> {
    await this.initialize();
    const directory = join(this.root, "assets", safeId(batchId));
    await mkdir(directory, { recursive: true });
    const fileName = `${safeId(documentId)}${extname(basename(originalName)).toLowerCase()}`;
    const target = join(directory, fileName);
    await copyFile(sourcePath, target);
    return target;
  }
}

function safeId(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid workspace id");
  return value;
}
