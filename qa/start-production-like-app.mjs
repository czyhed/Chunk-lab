import { execFileSync, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { resolve } from "node:path";

const containerEnvironment = execFileSync(
  "docker",
  ["inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", "rag-postgres"],
  { encoding: "utf8", windowsHide: true },
);
const values = new Map(containerEnvironment.trim().split(/\r?\n/).map((line) => {
  const separator = line.indexOf("=");
  return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
}));
for (const name of ["POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"])
  if (!values.get(name)) throw new Error(`Acceptance container is missing ${name}`);

const workspaceRoot = resolve(".workspace/real-mineru-matrix-v1");
mkdirSync(workspaceRoot, { recursive: true });
const stdout = openSync(resolve(workspaceRoot, "server-4180.stdout.log"), "a");
const stderr = openSync(resolve(workspaceRoot, "server-4180.stderr.log"), "a");
const child = spawn(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "src/server.ts"],
  {
    cwd: resolve("."),
    detached: true,
    windowsHide: true,
    stdio: ["ignore", stdout, stderr],
    env: {
      ...process.env,
      PORT: "4180",
      WORKSPACE_ROOT: workspaceRoot,
      RAG_PG_DATABASE: values.get("POSTGRES_DB"),
      RAG_PG_USER: values.get("POSTGRES_USER"),
      RAG_PG_PASSWORD: values.get("POSTGRES_PASSWORD"),
      DATABASE_PROFILES_JSON: JSON.stringify([{
        id: "local-pgvector-v2-1024",
        name: "Local pgvector schema 2.0 (1024)",
        kind: "pgvector",
        schemaVersion: "2.0",
        host: "127.0.0.1",
        port: 54329,
        databaseEnv: "RAG_PG_DATABASE",
        userEnv: "RAG_PG_USER",
        passwordEnv: "RAG_PG_PASSWORD",
      }]),
    },
  },
);
closeSync(stdout);
closeSync(stderr);
child.unref();
console.log(JSON.stringify({ processId: child.pid, port: 4180, workspace: ".workspace/real-mineru-matrix-v1" }));
