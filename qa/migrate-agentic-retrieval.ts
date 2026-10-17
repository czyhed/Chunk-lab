import { Pool } from "pg";
import { agenticRetrievalMigrationStatements } from "../src/agentic-retrieval-migration.js";

const argument = process.argv.find((value) => value.startsWith("--dimension="));
const dimensions = Number(argument?.split("=", 2)[1]);
if (!Number.isSafeInteger(dimensions) || dimensions <= 0) throw new Error("Use --dimension=<observed real embedding dimension>");
const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const pool = new Pool({
  host: process.env.RAG_PG_HOST?.trim() || "127.0.0.1",
  port: Number(process.env.RAG_PG_PORT) || 5432,
  database: required("RAG_PG_DATABASE"),
  user: required("RAG_PG_USER"),
  password: required("RAG_PG_PASSWORD"),
  max: 1,
});

try {
  await pool.query("BEGIN");
  for (const statement of agenticRetrievalMigrationStatements(dimensions)) await pool.query(statement);
  await pool.query("COMMIT");
  const table = `vector_records_v2_d${dimensions}`;
  const result = await pool.query<{ migration_count: string; active_documents: string; active_chunks: string; bm25_exists: boolean }>(
    `SELECT
       (SELECT count(*)::text FROM rag.schema_migrations WHERE version=$1) AS migration_count,
       (SELECT count(*)::text FROM rag.documents WHERE target_id='chunk-lab' AND deleted_at IS NULL) AS active_documents,
       (SELECT count(*)::text FROM rag.${table} WHERE target_id='chunk-lab' AND deleted_at IS NULL) AS active_chunks,
       to_regclass($2) IS NOT NULL AS bm25_exists`,
    [`agentic-retrieval-${dimensions}-v1`, `rag.${table}_bm25_idx`],
  );
  console.log(JSON.stringify({ dimensions, migrationAppliedOnce: result.rows[0]?.migration_count === "1", activeDocuments: Number(result.rows[0]?.active_documents ?? 0), activeChunks: Number(result.rows[0]?.active_chunks ?? 0), bm25Index: Boolean(result.rows[0]?.bm25_exists) }));
} catch (error) {
  await pool.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await pool.end();
}
