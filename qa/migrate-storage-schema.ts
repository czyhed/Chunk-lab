import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { Pool } from "pg";
import {
  migrationStatements,
  vectorIndexName,
  vectorTableName,
} from "../src/database-schema.js";

try {
  loadEnvFile(resolve(".env"));
} catch {}

const dimensionArgument = process.argv.find((value) => value.startsWith("--dimension="));
const dimensions = Number(dimensionArgument?.split("=", 2)[1]);
if (!Number.isSafeInteger(dimensions) || dimensions <= 0)
  throw new Error("Use --dimension=<observed real embedding dimension>");

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const pool = new Pool({
  host: process.env.RAG_PG_HOST?.trim() || "127.0.0.1",
  port: Number(process.env.RAG_PG_PORT) || 54329,
  database: required("RAG_PG_DATABASE"),
  user: required("RAG_PG_USER"),
  password: required("RAG_PG_PASSWORD"),
  max: 1,
});

try {
  for (const statement of migrationStatements(dimensions)) await pool.query(statement);
  const table = vectorTableName(dimensions);
  const index = vectorIndexName(dimensions);
  const result = await pool.query<{
    migration_count: string;
    table_exists: boolean;
    index_valid: boolean;
  }>(`SELECT
    (SELECT count(*)::text FROM rag.schema_migrations WHERE version=$1) AS migration_count,
    to_regclass($2) IS NOT NULL AS table_exists,
    COALESCE((SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass($3)), false) AS index_valid`,
    [`2.0-d${dimensions}`, `rag.${table}`, `rag.${index}`]);
  const row = result.rows[0];
  if (row.migration_count !== "1" || !row.table_exists || !row.index_valid)
    throw new Error("schema verification failed");
  console.log(JSON.stringify({
    schemaVersion: "2.0",
    dimensions,
    migrationAppliedOnce: true,
    table,
    index,
    indexValid: true,
  }));
} finally {
  await pool.end();
}
