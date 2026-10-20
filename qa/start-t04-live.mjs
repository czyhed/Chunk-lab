import { spawn } from "node:child_process";
import { resolve } from "node:path";

const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
  cwd: resolve("."),
  env: {
    ...process.env,
    PORT: "4187",
    WORKSPACE_ROOT: resolve(".workspace/t04-live"),
  },
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});
child.unref();

const deadline = Date.now() + 20_000;
while (Date.now() < deadline) {
  try {
    if ((await fetch("http://127.0.0.1:4187/api/health")).ok) {
      console.log(JSON.stringify({ url: "http://127.0.0.1:4187", pid: child.pid }));
      process.exit(0);
    }
  } catch {}
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
}
throw new Error("T04 live server did not become ready");
