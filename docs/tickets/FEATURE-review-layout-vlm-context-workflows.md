# Feature Ticket: 审核区布局优化、图片 VLM 摘要与 Context 模型工作流

- 状态：complete
- 日期：2026-08-16
- 阻塞：已解除。T08 于 2026-08-16 完成窄/宽窗口重新验收并实际标记为 `complete`。
- 证据目录：`output/evidence/review-layout-vlm-context-workflows/`

## 目标

在不改变 Parsed Document、Source Segment、Preview/Draft、Embedding 与数据库既有契约的前提下，让 Draft 审核获得稳定的纵向空间，并将图片摘要与 Context 分别接入服务端可配置的 OpenAI-compatible 模型 profile。图片摘要、人工审核、Context 审核及其派生资格都必须由服务端权威持久化并可在刷新、重新打开和导出后恢复。

## 既有能力与边界

- 复用 ADR 0003 的 Configuration Draft -> Preview -> Chunk Draft 三阶段，不允许配置控件自行触发生成。
- 复用 ADR 0005 的精确 Source Segment 和 T08 双向定位，不改写不可变 Parsed Document。
- 复用 T08.5 的中文“原因 + 影响 + 下一步”展示；内部原因码、路径和原始模型异常只允许进入受控诊断，不进入主界面或 evidence。
- 复用现有 Context prompt、生成包、确认、人工修改、失败隔离及 stale 生命周期；图片摘要与 Context 是两个独立职责、独立选择和独立状态。
- 不修改 T06、T07、T08、T08.5、T10、T11 Ticket、PRD 或历史证据；本 Ticket 的完成不代表 T09/T10/T11 历史 Ticket 自动完成。
- 不调用付费服务，不硬编码供应商或密钥，不迁移或删除已有数据，不做无关重构。

## 已确认测试边界

测试只通过公开接口观察行为：浏览器可见 DOM 与键盘交互、Fastify HTTP API、通过同一 API 的保存后读取/恢复/导出，以及本地 fake OpenAI-compatible HTTP 服务收到的请求。不得测试私有辅助函数，不得绕过 API 直接读取工作区来证明持久化；工作区文件仅用于脱敏与泄密扫描。

## 切片 A：审核区布局

1. 将 Configuration Draft 实现为原生或等价可访问 disclosure。Preview/未生成默认展开；Draft 默认折叠为固定的一行摘要，显示策略、关键参数和状态。
2. 标题/箭头支持点击、Enter 和 Space。提供“固定展开”复选或图钉按钮；选择按浏览器本地偏好保存，作用于后续文档/刷新。
3. 配置 dirty、生成失败或用户主动修改配置时自动展开并给出清晰状态；悬停/聚焦只显示摘要提示，不改变布局尺寸。
4. Chunk Quality Metric 在 Draft 中默认压缩为摘要，可显式展开；Preview 中保留完整指标。主要审核命令始终可见。
5. Context 工具栏只在 Draft 且存在相关 Context 操作时显示。布局不得产生文字/控件重叠。
6. 视觉方向沿用当前安静、工具化的工作台色彩和字体；唯一新增的识别性元素是一行稳定的 Configuration Digest（策略、关键参数、状态、固定控件），不引入装饰性卡片或无关动效。

## 切片 B：服务端图片摘要持久化

1. 图片 Chunk 编辑区依次提供图片策略、图片理解模型、明确的“发送图片并生成摘要”、只读 VLM 原始摘要、人工摘要、人工补充与“保存图片摘要”。模型控件不得进入顶部 Embedding/数据库配置。
2. 保存使用独立服务端权威 API，不接受客户端提交 token、finalText、Embedding/Context eligibility 或 stale 等派生字段。
3. 服务端分别保存机器原始摘要、人工摘要和人工补充，重算有效摘要、finalText、token、Embedding/Context eligibility 与 stale；保存后只解锁 Context，不自动生成 Context，也不触发第二次模型请求。
4. 保存结果通过 review API、刷新、重新打开与导出保持一致，并记录 profileId/profileName、promptVersion、generatedAt 和 `unconfigured|generating|awaiting_review|failed` 状态。

## 切片 C：VLM profile 与多模态调用

1. 模型列表来自服务端配置。公开响应只含 profile `id`、`name` 和可用职责，不返回 API Key、Base URL、Authorization、底层异常或服务器路径。
2. VLM 与 Context 可引用同一服务端 profile，但浏览器分别选择，服务端分别校验 capability。
3. VLM 使用 OpenAI-compatible Chat Completions 多模态消息，至少包含一个服务端解析的可信图片 data URL，以及商品、章节、图注和附近文本中的可用内容。
4. 可信图片只允许来自：原始 Source Document 本身为图片；或服务端从版本匹配的 Source PDF 按精确/可信页码与 bbox 生成的裁剪。`demo://`、MinerU `img_path` 字符串、CSS 占位图和浏览器自报 data URL 均不可信，必须拒绝且不得调用模型。
5. 若实际实现证明现有 Source/Parsed Document 无法生成上述真实输入，立即暂停 VLM 切片并记录缺失的资产持久化或裁剪前置能力，不得伪造成功。
6. 本地确定性 fake 覆盖成功、超时、空响应、HTTP 失败和服务未配置；失败沿用中文“原因 + 影响 + 下一步”，不泄露原始响应或凭证。

## 切片 D：独立 Context 模型工作流

1. Context Enhancement 区域单独提供 Context 模型选择和显式“生成 Context”，继续复用现有生成包、prompt、确认、人工修改、重试与 stale 契约。
2. 图片 Chunk 没有有效图片摘要时显示“建议增强 · 待补充图片摘要”和进入图片摘要编辑的直接动作，不再同时显示“CONTEXT 推荐”和“不可生成”。
3. 图片摘要保存完成后 Context 变为可选择；只有用户显式点击生成时才调用 Context profile。
4. Context 的 profileId/profileName、promptVersion、generatedAt、状态和审核结果独立于 VLM 元数据并可恢复、导出。

## 测试顺序与验收

每个切片严格执行一个可复现失败测试 -> 最小实现 -> 聚焦通过，再进入下一切片；同一失败连续两次必须改用新的 DOM、HTTP、持久化或模型请求证据重新判断。

- 布局：阶段默认值、固定偏好恢复、键盘可用性、dirty/失败自动展开、质量指标摘要、Context 工具栏显隐、主要审核命令可见和无重叠。
- 图片摘要 API：拒绝客户端派生字段、服务端重算、保存/刷新/重新打开/导出恢复、Context 解锁，以及保存不产生模型调用。
- profile 与 VLM：安全列表响应、多模态请求结构、可信资产校验、成功/超时/空响应/HTTP 失败/未配置、单图片失败隔离和脱敏。
- Context：独立 profile 选择、显式生成、图片摘要前置中文状态、确认/人工修改/stale、保存图片摘要不自动生成。
- 回归：T07/T08/T08.5 聚焦测试、`npm test`、`npm run typecheck`、`npm run build` 和每个变更 JavaScript 的 `node --check` 全部退出 0。

## 真实浏览器证据

- 在 `1440x1100`、`1024x768` 和移动宽度验证 Preview、Draft 折叠/展开、固定偏好、键盘操作、无重叠，以及折叠后 Chunk 列表与详情获得明显更大纵向空间；记录折叠前后元素矩形和可用高度。
- 使用本地 fake profile 和真实可信测试图片或 PDF 裁剪，完成 VLM 生成、人工审核、保存、刷新恢复、Context 显式生成/确认与导出一致性。
- 保存三档截图、脱敏模型请求/响应摘要、刷新恢复 JSON、导出断言、浏览器 console、网络失败状态和精确命令输出。
- 对页面、API 响应、日志和 evidence 扫描 API Key、Authorization、Base URL、绝对敏感路径、原始模型异常及未翻译内部原因码。

## 完成条件

四个切片均满足聚焦测试和真实浏览器验收；可信图片输入可审计但不在 evidence 中复制敏感原图；保存/刷新/重新打开/导出一致；所有门禁退出 0；Ticket 标记完成并列出残余风险。

## Completion evidence（2026-08-16）

- 布局：Configuration Draft 与质量指标 disclosure 的阶段默认值、固定展开、键盘交互、dirty/失败展开均由聚焦测试覆盖。`1440x1100` 下折叠后审核区可用高度由 701px 增至 873px；`1024x768` 与 `390x844` 无页面横向溢出或控件内容溢出。
- 图片摘要：公开 profile 响应只有 `id/name/capabilities`。本地 fake 收到可信 PDF 精确裁剪的多模态图片；图片摘要保存后服务端重算 53 tokens、`finalText`、Embedding/Context eligibility，并在刷新、重新打开和 2.1 导出中恢复。
- Context：图片摘要保存没有触发模型；用户显式点击“生成 Context”后 fake 收到独立的纯文本 Context 请求，确认后刷新与导出均恢复 `confirmed`、profile 和 prompt 元数据。
- 前端回归：VLM 响应期间未保存的图片策略、人工摘要和人工补充保持在本地编辑态；刷新证明未点击保存的测试值没有越权持久化。
- 安全：最终 18 个 evidence 文件、当前页面正文和公开 profile API 均完成脱敏扫描；无凭证值、原始鉴权头、私有模型端点、敏感绝对路径、未翻译内部原因码或原始传输错误。
- 门禁：新增聚焦测试、T07/T08/T08.5 回归、`npm test`、`npm run typecheck`、`npm run build` 及 `app.js`、`review-layout.js`、`user-facing-errors.js`、`qa/fake-model-server.mjs` 的 `node --check` 全部退出 0。
- 证据：`output/evidence/review-layout-vlm-context-workflows/`。

## 残余风险

- PDF.js 在可信 PDF 裁剪测试中输出缺少 `standardFontDataUrl` 的警告，但裁剪和全部断言通过；当前 demo 图片区域不依赖标准字体。若后续裁剪区域需要渲染内嵌文本，应配置标准字体资源并增加像素级回归。
- 模型验收使用本地确定性 OpenAI-compatible fake，不代表任何具体供应商的生产配额、限流、视觉输入上限或响应差异；接入真实供应商仍需单独产品决策和不泄密连通性验收。
