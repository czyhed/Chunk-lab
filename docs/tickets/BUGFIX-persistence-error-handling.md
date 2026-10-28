# Bugfix Ticket: 持久化与错误处理

- 状态：已完成
- 日期：2026-08-16
- 范围：同一 Batch 的并发持久化、服务端安全错误响应、前端中文错误与不可用原因、人工框问题定位。
- 不在范围：T08 窄窗口滚动、配置区折叠、VLM、图片摘要工作流及其他功能。

## 问题

`WorkspaceStore.writeBatch` 对同一 Batch 固定使用同一个 `.tmp` 文件。并发调用会互相覆盖或移动该文件，可能导致调用以 `ENOENT` 失败、正式 JSON 落入错误版本，或较旧状态覆盖较新状态。服务端和前端还可能直接展示系统异常或内部原因码，用户无法判断影响和处理方法。

## 决策

同一 `WorkspaceStore` 实例内，同一 Batch 的写入按调用顺序串行执行；不同 Batch 仍可并发。每次物理写入使用独立临时文件并在 `finally` 中清理。后发调用完成后，正式 JSON 必须对应后发状态。

服务端意外错误只返回稳定错误码、中文用户消息和可选恢复建议；系统异常详情只进入不含请求头、Cookie、密钥或正文的服务端错误日志。前端主视图只显示中文“原因 + 影响 + 下一步”，原始内部码仅进入可展开诊断详情。

## 验收标准

1. 修复前并发回归测试稳定失败并保存红测输出。
2. 修复后多个同 Batch 并发写入全部成功，正式 JSON 可解析且为最后调用状态，无冲突临时文件残留。
3. 意外错误响应不含 `ENOENT`、绝对路径、堆栈或原始系统异常。
4. 并发保存失败、人工框未命中可信 Source Block、Context/Embedding 不可用均显示中文原因、影响和下一步。
5. 人工框失败尽可能提供页码、框类型，并能定位或高亮问题框。
6. 聚焦测试、`npm test`、`npm run typecheck`、`npm run build` 和所有变更 JavaScript 的 `node --check` 均退出 0。
7. 真实浏览器截图和文本扫描不出现系统详情或未翻译内部原因码。

## 证据目录

`output/evidence/persistence-error-handling/`

## 完成证据

- 修复前红测：固定 `.tmp` 并发写入 16 次仅 4 次成功；红测见 `01-concurrent-write-red.txt`。
- 修复后：16/16 成功，最终序号 15，正式 JSON 可解析，临时文件 0；见 `08-concurrent-write-evidence.json`。
- 意外错误响应：502、`INTERNAL_SERVER_ERROR`、中文消息与恢复建议；见 `09-error-responses.json`。
- 人工框失败响应含页码、框类型和 bbox；前端可定位/高亮并提示调整、排除或删除后重试。
- `npm test`、`npm run typecheck`、`npm run build`、`node --check app.js`、`node --check user-facing-errors.js`、`node --check qa/user-facing-errors.test.mjs` 均退出 0。
- 浏览器地址：`http://127.0.0.1:4319/?demoPages=8`；截图与禁词扫描见 `10-browser-verification.json`。验证完成后服务已停止。

## 残余风险

写入顺序保证覆盖同一 `WorkspaceStore` 实例内的并发调用；跨多个 Node 进程/实例的分布式锁与产品级写入排序不在本次范围内。诊断详情仍可由用户主动展开查看内部码，这是受控诊断入口。
