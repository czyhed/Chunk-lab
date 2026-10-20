import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(".");
const output = resolve("output/playwright/t02-source-view");
await mkdir(output, { recursive: true });
const fakePort = 4192;
const appPort = 4182;
const session = "t02-source-view-final";
const fakeLog = resolve("output/t02-source-view/fake-mineru-calls.jsonl");
const appLogPath = resolve("output/t02-source-view/app-service.log");
const fake = spawn(process.execPath, ["qa/fake-mineru-server.mjs"], {
  cwd: root,
  env: { ...process.env, FAKE_MINERU_PORT: String(fakePort), FAKE_MINERU_LOG: fakeLog },
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
const app = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(appPort),
    WORKSPACE_ROOT: resolve(".workspace/t02-source-view"),
    MINERU_API_TOKEN: "fake-t02-token",
    MINERU_BASE_URL: `http://127.0.0.1:${fakePort}/api/v4`,
    MINERU_PARSE_TIMEOUT_MS: "30000",
    EMBEDDING_BASE_URL: "http://127.0.0.1:9/v1",
    EMBEDDING_API_KEY: "fake-embedding-key",
    EMBEDDING_MODEL: "fake-embedding-model",
    T02_FAKE_VISUAL_COPY_FAILURE: "1",
  },
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
let serviceLog = "";
for (const child of [fake, app]) {
  child.stdout.setEncoding("utf8").on("data", (chunk) => { serviceLog += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { serviceLog += chunk; });
}
async function waitFor(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
function refFor(snapshot, text) {
  const line = snapshot.split("\n").find((candidate) => candidate.includes(text) && candidate.includes("[ref="));
  const ref = line?.match(/\[ref=(e\d+)\]/)?.[1];
  if (!ref) throw new Error(`No snapshot ref for ${text}`);
  return ref;
}
const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
async function cli(...args) {
  const cliArgs = ["--yes", "--package", "@playwright/cli", "playwright-cli", "--session", session, ...args];
  const child = spawn(process.platform === "win32" ? process.env.ComSpec : "npx", process.platform === "win32" ? ["/d", "/s", "/c", "npx", ...cliArgs] : cliArgs, { cwd: output, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let result = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { result += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { result += chunk; });
  const code = await new Promise((resolveExit, reject) => { child.once("error", reject); child.once("exit", (value) => resolveExit(value ?? 1)); });
  if (code !== 0) throw new Error(`playwright-cli ${args[0]} exited with ${code}: ${result}`);
  transcript.push(`$ playwright-cli ${args.join(" ")}\n${result}`);
  return result;
}
const transcript = [];
const screenshot = (name) => cli("screenshot", "--filename", resolve(output, name));
try {
  await Promise.all([waitFor(`http://127.0.0.1:${fakePort}/health`), waitFor(`http://127.0.0.1:${appPort}/api/health`)]);
  await cli("open", `http://127.0.0.1:${appPort}`, "--headed");
  await cli("resize", "1440", "1000");
  const initial = await cli("snapshot");
  await cli("click", refFor(initial, 'button "载入演示"'));
  await wait(2500);
  const demo = await cli("snapshot");
  assert.match(demo, /P\.1|来源第 1 页/);
  const fitMetrics = await cli("eval", "JSON.stringify({pages:document.querySelectorAll('.pdf-page-canvas').length, rendered:[...document.querySelectorAll('.pdf-page-canvas')].map(c=>c.dataset.rendered), overlay:document.querySelector('.exact-source-block')?.getBoundingClientRect().toJSON(), page:document.querySelector('#page-1')?.getBoundingClientRect().toJSON()})");
  await writeFile(resolve(output, "fit-metrics.json"), fitMetrics, "utf8");
  assert.match(fitMetrics, /rendered.*true.*true/);
  const pixels = await cli("eval", "JSON.stringify((()=>{const c=document.querySelector('.pdf-page-canvas');const x=c?.getContext('2d');if(!c||!x)return {nonBlank:0};const d=x.getImageData(0,0,c.width,c.height).data;let nonBlank=0;for(let i=0;i<d.length;i+=16)if(d[i]||d[i+1]||d[i+2])nonBlank++;return {width:c.width,height:c.height,nonBlank}})())");
  assert.match(pixels, /nonBlank\\\":([1-9][0-9]*)/);
  await writeFile(resolve(output, "pixel-measurements.json"), pixels, "utf8");
  await screenshot("01-fit-width.png");

  const controls = await cli("snapshot");
  await cli("click", refFor(controls, 'button "实际大小"'));
  await wait(800);
  const actualMetrics = await cli("eval", "JSON.stringify({zoom:getComputedStyle(document.querySelector('#pageScroll')).getPropertyValue('--source-zoom').trim(),page:document.querySelector('#page-1')?.getBoundingClientRect().toJSON(),overlay:document.querySelector('.exact-source-block')?.getBoundingClientRect().toJSON()})");
  await writeFile(resolve(output, "actual-metrics.json"), actualMetrics, "utf8");
  await screenshot("02-actual-size.png");
  const zoomedControls = await cli("snapshot");
  await cli("click", refFor(zoomedControls, 'button "放大"'));
  await cli("click", refFor(await cli("snapshot"), 'button "放大"'));
  await wait(600);
  await screenshot("03-multi-zoom.png");

  const jump = await cli("snapshot");
  await cli("fill", refFor(jump, 'spinbutton "页码"'), "2");
  await cli("press", "Enter");
  await wait(700);
  assert.match(await cli("snapshot"), /P\.2/);
  await screenshot("04-page-two-jump.png");
  await cli("eval", "document.querySelector('#pageScroll').scrollTo({top:document.querySelector('#pageScroll').scrollHeight,behavior:'instant'})");
  await cli("eval", "(()=>{const source=document.querySelector('#pageScroll');source.scrollTo({top:0,behavior:'instant'});for(let index=0;index<8;index+=1)source.scrollBy(0,180);return source.scrollTop})()");
  await screenshot("05-continuous-scroll.png");

  const resizer = await cli("snapshot");
  refFor(resizer, 'separator "调整原文和分块区域宽度"');
  const resizerBox = await cli("eval", "JSON.stringify(document.querySelector('#workspaceResizer').getBoundingClientRect().toJSON())");
  const resizerX = Number(resizerBox.match(/\\\"x\\\":([0-9.]+)/)?.[1]);
  const resizerY = Number(resizerBox.match(/\\\"y\\\":([0-9.]+)/)?.[1]);
  assert.ok(Number.isFinite(resizerX) && Number.isFinite(resizerY));
  await cli("mousemove", String(Math.round(resizerX + 3)), String(Math.round(resizerY + 30)));
  await cli("mousedown");
  await cli("mousemove", String(Math.round(resizerX + 93)), String(Math.round(resizerY + 30)));
  await cli("mouseup");
  await screenshot("06-divider-dragged.png");
  const dividerMetrics = await cli("eval", "JSON.stringify({value:document.querySelector('#workspaceResizer').getAttribute('aria-valuenow'),source:document.querySelector('.document-stage').getBoundingClientRect().width})");
  assert.doesNotMatch(dividerMetrics, /value\\\":null/);
  await writeFile(resolve(output, "divider-metrics.json"), dividerMetrics, "utf8");

  const add = await cli("snapshot");
  await cli("click", refFor(add, 'button "添加文档"'));
  await cli("upload", resolve(root, "materials/docx/营销文案.docx"));
  const staged = await cli("snapshot");
  await cli("click", refFor(staged, 'button "开始解析"'));
  await wait(9000);
  const office = await cli("snapshot");
  assert.match(office, /营销文案\.docx/);
  assert.match(office, /Visual Copy失败/);
  assert.match(office, /已就绪/);
  await screenshot("07-visual-copy-failure-degraded.png");
  await cli("console", "error");
  await cli("requests");
  await writeFile(resolve(output, "browser-console-and-requests.log"), transcript.join("\n\n"), "utf8");
} finally {
  await writeFile(resolve(output, "browser-transcript.log"), transcript.join("\n\n"), "utf8");
  await writeFile(appLogPath, serviceLog, "utf8");
  for (const child of [app, fake]) if (child.exitCode === null) child.kill("SIGKILL");
  for (const child of [app, fake]) { child.stdout.destroy(); child.stderr.destroy(); }
}
