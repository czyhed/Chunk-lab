import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(".");
const output = resolve("output/playwright/t02-source-view-matrix");
await mkdir(output, { recursive: true });
const fakePort = 4193, appPort = 4183, session = `t02-view-matrix-${Date.now()}`;
const fake = spawn(process.execPath, ["qa/fake-mineru-server.mjs"], { cwd: root, env: { ...process.env, FAKE_MINERU_PORT: String(fakePort), FAKE_MINERU_LOG: resolve("output/t02-source-view/fake-mineru-matrix.jsonl") }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
const app = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(appPort), WORKSPACE_ROOT: resolve(".workspace/t02-source-view-matrix"), MINERU_API_TOKEN: "fake-t02-matrix-token", MINERU_BASE_URL: `http://127.0.0.1:${fakePort}/api/v4`, MINERU_PARSE_TIMEOUT_MS: "60000", EMBEDDING_BASE_URL: "http://127.0.0.1:9/v1", EMBEDDING_API_KEY: "fake-embedding-key", EMBEDDING_MODEL: "fake-embedding-model" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let serviceLog = "", transcript = [];
for (const child of [fake, app]) { child.stdout.setEncoding("utf8").on("data", (chunk) => { serviceLog += chunk; }); child.stderr.setEncoding("utf8").on("data", (chunk) => { serviceLog += chunk; }); }
const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
async function waitFor(url) { const deadline=Date.now()+20000; while(Date.now()<deadline){try{if((await fetch(url)).ok)return}catch{} await wait(100)} throw new Error(`Timed out waiting for ${url}`); }
function refFor(snapshot, text) { const line=snapshot.split("\n").find((candidate)=>candidate.includes(text)&&candidate.includes("[ref=")); const ref=line?.match(/\[ref=(e\d+)\]/)?.[1]; if(!ref)throw new Error(`No snapshot ref for ${text}`); return ref; }
async function cli(...args) { const cliArgs=["--yes","--package","@playwright/cli","playwright-cli","--session",session,...args]; const child=spawn(process.platform==="win32"?process.env.ComSpec:"npx",process.platform==="win32"?["/d","/s","/c","npx",...cliArgs]:cliArgs,{cwd:output,stdio:["ignore","pipe","pipe"],windowsHide:true});let result="";child.stdout.setEncoding("utf8").on("data",(chunk)=>{result+=chunk});child.stderr.setEncoding("utf8").on("data",(chunk)=>{result+=chunk});const code=await new Promise((resolveExit,reject)=>{child.once("error",reject);child.once("exit",(value)=>resolveExit(value??1))});if(code!==0)throw new Error(`playwright-cli ${args[0]} exited with ${code}: ${result}`);transcript.push(`$ playwright-cli ${args.join(" ")}\n${result}`);return result; }
const screenshot = (name) => cli("screenshot", "--filename", resolve(output, name));

try {
  await Promise.all([waitFor(`http://127.0.0.1:${fakePort}/health`),waitFor(`http://127.0.0.1:${appPort}/api/health`)]);
  await cli("open",`http://127.0.0.1:${appPort}`,"--headed"); await cli("resize","1440","1000");
  const initial=await cli("snapshot"); await cli("click",refFor(initial,'button "添加文档"'));
  await cli("upload",resolve(root,"materials/pdf/产品规格表.pdf"),resolve(root,"materials/pptx/images_launch/image-product_4x3.jpg"),resolve(root,"materials/docx/营销文案.docx"),resolve(root,"qa/ecommerce-upload-sample.md"));
  const staged=await cli("snapshot"); await cli("click",refFor(staged,'button "开始解析"')); await wait(15000);
  const ready=await cli("snapshot");
  for(const name of ["产品规格表.pdf","image-product_4x3.jpg","营销文案.docx","ecommerce-upload-sample.md"]){assert.match(ready,new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")))}
  assert.doesNotMatch(ready,/Visual Copy失败/);
  await cli("click",refFor(ready,'button "产品规格表.pdf')); await wait(1000);
  const pdfView=await cli("snapshot"); assert.match(pdfView,/原始文件/); assert.match(pdfView,/P\.10/);
  await screenshot("01-pdf-original.png");

  await cli("click",refFor(await cli("snapshot"),'button "image-product_4x3.jpg'));
  await wait(800); assert.match(await cli("snapshot"),/原始图片/);
  await cli("click",refFor(await cli("snapshot"),'button "放大"')); await wait(300);
  await screenshot("02-image-zoom.png");

  await cli("click",refFor(await cli("snapshot"),'button "营销文案.docx'));
  await wait(1200); const office=await cli("snapshot"); assert.match(office,/Visual Copy/);
  await screenshot("03-office-visual-copy.png");

  await cli("click",refFor(await cli("snapshot"),'button "ecommerce-upload-sample.md'));
  await wait(500); const source=await cli("snapshot"); assert.match(source,/Markdown 源码/); assert.match(source,/渲染结果/); assert.match(source,/解析结果/); await screenshot("04-markdown-source.png");
  await cli("click",refFor(source,'tab "渲染结果"')); await screenshot("05-markdown-rendered.png");
  await cli("console","error"); await cli("requests");
} finally {
  await writeFile(resolve(output,"browser-transcript.log"),transcript.join("\n\n"),"utf8"); await writeFile(resolve("output/t02-source-view/app-service-matrix.log"),serviceLog,"utf8");
  for(const child of [app,fake])if(child.exitCode===null)child.kill("SIGKILL"); for(const child of [app,fake]){child.stdout.destroy();child.stderr.destroy()}
}
