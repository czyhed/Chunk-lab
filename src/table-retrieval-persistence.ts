import { Pool } from "pg";
import {
  tableBundleTableName,
  tableRetrievalMigrationStatements,
} from "./database-schema.js";
import type {
  PublicTableRetrievalHit,
  TableRetrievalBundle,
  TableRetrievalRepository,
  TableVersion,
} from "./table-retrieval.js";

export type PgTableRetrievalConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  dimensions: number;
};

export type ConfiguredTableRetrievalTarget = {
  profileId: string;
  repository: PgTableRetrievalRepository;
};

/** Builds the Issue 14 adapter from the existing single-target PG profile. */
export function createConfiguredTableRetrievalTarget(
  environment: NodeJS.ProcessEnv,
  dimensions: number,
): ConfiguredTableRetrievalTarget | null {
  const raw = environment.DATABASE_PROFILES_JSON?.trim();
  if (!raw) return null;
  const profiles = JSON.parse(raw) as unknown;
  if (!Array.isArray(profiles) || profiles.length !== 1)
    throw new Error("Table Retrieval requires exactly one database profile");
  const profile = profiles[0];
  if (!profile || typeof profile !== "object" || Array.isArray(profile))
    throw new Error("Database profile must be an object");
  const config = profile as Record<string, unknown>;
  if (config.kind !== "pgvector") throw new Error("Table Retrieval database must use pgvector");
  const profileId = requiredConfigString(config.id, "database profile id");
  const host = requiredConfigString(config.host, "database host");
  const port = Number(config.port);
  if (!Number.isInteger(port) || port <= 0) throw new Error("database port must be a positive integer");
  return {
    profileId,
    repository: new PgTableRetrievalRepository({
      host,
      port,
      database: environmentValue(environment, config.databaseEnv, "database"),
      user: environmentValue(environment, config.userEnv, "database user"),
      password: environmentValue(environment, config.passwordEnv, "database password"),
      dimensions,
    }),
  };
}

export class PgTableRetrievalRepository implements TableRetrievalRepository {
  private readonly pool: Pool;
  private readonly table: string;
  private initialized?: Promise<void>;

  constructor(private readonly config: PgTableRetrievalConfig) {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      max: 4,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
    });
    this.table = tableBundleTableName(config.dimensions);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async saveVersion(version: TableVersion): Promise<void> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO rag.table_artifacts(
          logical_table_id, table_version_id, artifact, final_summary,
          query_ready, query_ready_at, state, created_at, deleted_at
        ) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9)`,
        [
          version.logicalTableId,
          version.tableVersionId,
          JSON.stringify(version.artifact),
          version.finalSummary,
          version.queryReady,
          version.queryReadyAt ?? null,
          version.state,
          version.createdAt,
          version.deletedAt ?? null,
        ],
      );
      for (const source of version.sourceChunks) {
        await client.query(
          `INSERT INTO rag.table_version_source_chunks(
            table_version_id, source_chunk_id, source_chunk_version, ordinal, final_text
          ) VALUES ($1,$2,$3,$4,$5)`,
          [
            version.tableVersionId,
            source.sourceChunkId,
            source.sourceChunkVersion,
            source.order,
            source.finalText,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async saveBundle(bundle: TableRetrievalBundle): Promise<void> {
    await this.initialize();
    await this.pool.query(
      `INSERT INTO rag.${this.table}(
        bundle_id, table_version_id, source_chunk_ids, embedding_input_text,
        embedding_input_hash, embedding_profile_id, embedding_model,
        vector_dimensions, embedding, vector_ready, created_at, deleted_at
      ) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9::vector,$10,$11,$12)`,
      [
        bundle.bundleId,
        bundle.tableVersionId,
        JSON.stringify(bundle.sourceChunkIds),
        bundle.embeddingInputText,
        bundle.embeddingInputHash,
        bundle.embeddingProfileId,
        bundle.embeddingModel,
        bundle.vectorDimensions,
        vectorLiteral(bundle.vector),
        bundle.vectorReady,
        bundle.createdAt,
        bundle.deletedAt ?? null,
      ],
    );
  }

  async findActive(logicalTableId: string): Promise<TableVersion | null> {
    await this.initialize();
    const result = await this.pool.query(
      `SELECT table_version_id FROM rag.table_artifacts
       WHERE logical_table_id=$1 AND state='active' AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [logicalTableId],
    );
    const id = result.rows[0]?.table_version_id;
    return typeof id === "string" ? this.getVersion(id) : null;
  }

  async activateVersion(tableVersionId: string, previousTableVersionId?: string, at = new Date().toISOString()): Promise<void> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (previousTableVersionId) {
        await client.query(
          `UPDATE rag.table_artifacts
           SET state='soft_deleted', deleted_at=$2
           WHERE table_version_id=$1 AND state='active'`,
          [previousTableVersionId, at],
        );
        await client.query(
          `UPDATE rag.${this.table} SET deleted_at=$2
           WHERE table_version_id=$1 AND deleted_at IS NULL`,
          [previousTableVersionId, at],
        );
      }
      await client.query(
        `UPDATE rag.table_artifacts SET state='active'
         WHERE table_version_id=$1 AND state='staged'`,
        [tableVersionId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getVersion(tableVersionId: string): Promise<TableVersion | null> {
    await this.initialize();
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT logical_table_id, table_version_id, artifact, final_summary,
              query_ready, query_ready_at, state, created_at, deleted_at
       FROM rag.table_artifacts WHERE table_version_id=$1`,
      [tableVersionId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const sources = await this.pool.query<Record<string, unknown>>(
      `SELECT source_chunk_id, source_chunk_version, ordinal, final_text
       FROM rag.table_version_source_chunks
       WHERE table_version_id=$1 ORDER BY ordinal, source_chunk_id`,
      [tableVersionId],
    );
    return {
      logicalTableId: String(row.logical_table_id),
      tableVersionId: String(row.table_version_id),
      artifact: row.artifact as TableVersion["artifact"],
      finalSummary: String(row.final_summary),
      sourceChunks: sources.rows.map((source) => ({
        sourceChunkId: String(source.source_chunk_id),
        sourceChunkVersion: String(source.source_chunk_version),
        order: Number(source.ordinal),
        finalText: String(source.final_text),
      })),
      queryReady: Boolean(row.query_ready),
      ...(row.query_ready_at ? { queryReadyAt: new Date(String(row.query_ready_at)).toISOString() } : {}),
      state: row.state as TableVersion["state"],
      createdAt: new Date(String(row.created_at)).toISOString(),
      ...(row.deleted_at ? { deletedAt: new Date(String(row.deleted_at)).toISOString() } : {}),
    };
  }

  async confirmQueryReady(tableVersionId: string, at: string): Promise<TableVersion> {
    await this.initialize();
    await this.pool.query(
      `UPDATE rag.table_artifacts SET query_ready=true, query_ready_at=$2
       WHERE table_version_id=$1`,
      [tableVersionId, at],
    );
    const version = await this.getVersion(tableVersionId);
    if (!version) throw new Error("Table Version 不存在");
    return version;
  }

  async search(queryVector: number[], profileId: string): Promise<PublicTableRetrievalHit[]> {
    await this.initialize();
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT b.table_version_id, a.logical_table_id, a.artifact,
              a.final_summary, 1 - (b.embedding <=> $1::vector) AS score
       FROM rag.${this.table} b
       JOIN rag.table_artifacts a ON a.table_version_id=b.table_version_id
       WHERE b.embedding_profile_id=$2 AND b.vector_ready=true
         AND b.deleted_at IS NULL AND a.state='active' AND a.deleted_at IS NULL
       ORDER BY b.embedding <=> $1::vector`,
      [vectorLiteral(queryVector), profileId],
    );
    const hits: PublicTableRetrievalHit[] = [];
    for (const row of result.rows) {
      const version = await this.getVersion(String(row.table_version_id));
      if (!version) continue;
      hits.push({
        tableVersionId: version.tableVersionId,
        logicalTableId: version.logicalTableId,
        tableId: version.artifact.tableId,
        ...(version.artifact.title ? { title: version.artifact.title } : {}),
        finalSummary: version.finalSummary,
        sourceChunks: version.sourceChunks,
        score: Number(row.score),
      });
    }
    return hits;
  }

  private async initialize(): Promise<void> {
    this.initialized ??= (async () => {
      for (const statement of tableRetrievalMigrationStatements(this.config.dimensions))
        await this.pool.query(statement);
    })();
    await this.initialized;
  }
}

function vectorLiteral(vector: number[]): string {
  if (!vector.length || vector.some((value) => !Number.isFinite(value)))
    throw new Error("向量不能为空且必须为有限数");
  return `[${vector.join(",")}]`;
}

function requiredConfigString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  variable: unknown,
  name: string,
): string {
  const variableName = requiredConfigString(variable, `${name}Env`);
  return requiredConfigString(environment[variableName], name);
}
