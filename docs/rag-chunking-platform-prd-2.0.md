# 电商文档切分工作台 PRD 2.0

## 1. 文档状态

- 版本：PRD 2.0（反馈修订版）
- 实施标识：V2.1（仅用于后续实现 Plan、接口和导出契约；不代表当前代码已完成）
- 状态：已确认（2026-08-13）
- 基线：[V2 PRD](./rag-chunking-platform-v2.md)
- 历史基线保留：V2 的完成状态和验收证据不被本文件改写
- 适用对象：单一 Data Annotator（数据标注工作人员）
- 产品事实：本文件是后续 V2.1 实现的产品事实；当前仓库尚未实现本文件新增契约

本版本解决 V2 反馈中的四类问题：

1. 原始文件查看器不能用解析文本模拟原文，也不能伪造 bbox。
2. MinerU 的 HTML/内部结构不能直接污染 Chunk、Context 或 embedding 输入。
3. 所有内容类型都需要可追踪的规范模型，而不是只为表格建立特殊分支。
4. 不可向量化、视觉定位不足、解析失败和旧工作区必须有明确且相互独立的状态。

## 2. 目标与非目标

### 2.1 产品目标

1. 工作人员可以在真实来源视图中连续查看文档，并可靠定位 Chunk 来源。
2. Office 原文件直接交给 MinerU；左侧视觉副本独立生成，不替代 MinerU 输入。
3. MinerU、Markdown 和 TXT 的结果统一为可切分、可修订、可导出的规范内容模型。
4. 原始结果、规范模型、阅读表示、检索文本和 embedding 输入彼此分离且可审计。
5. 表格、图片、公式、代码、警告和未知内容不会被普通文本策略静默破坏。
6. 工作人员可以修复规范化失败内容，并只重算受影响的派生状态。
7. 只有通过内容资格校验的 Chunk 才能生成 Context 或进入 embedding 输入。

### 2.2 非目标

本版本不包含：

- 账号、多用户协作、审核发布和权限流转；
- 正式文档库、长期历史版本树或任意版本浏览；
- 向量数据库、检索评测、召回评测和生产索引；
- 重新 OCR、字符级 PDF 重标注、像素级任意框选；
- 用视觉副本替代 MinerU 输入；
- 用 LLM 改写普通正文、表格或公式；
- 将原始 HTML、诊断 JSON、图片地址或请求信息当作检索文本；
- 把定位质量问题自动等同为 embedding 资格失败。

## 3. 领域术语与边界

本版本继续使用 [CONTEXT.md](../CONTEXT.md) 中的术语，并新增以下精确定义：

**PRD 2.0 / V2.1**：`PRD 2.0` 是本产品文档版本；`V2.1` 是后续实现和 Chunk Contract 2.1 的内部实施标识。导出 Manifest 使用 `contractVersion=2.1` 表示本契约，不能把它理解为当前代码已经完成了 V2.1。

**Source Document**：工作人员上传的不可变原始文件。它是事实来源，不因解析、视觉转换或人工修订而改变。

**Parsed Document Version**：对一个 Source Document 执行一次 MinerU 或本地 Markdown/TXT 解析得到的不可变版本。

**Visual Copy**：供左侧连续查看的只读 PDF 或页面图片资产。Office 的 Visual Copy 与 MinerU 输入并行生成，不能替代原文件上传给 MinerU。

**Content Block**：Parsed Document 中一个有顺序、有来源的内容单位。每个 Block 有类型化规范模型和来源定位。

**Content Group**：由多个 Block 组成的语义组，例如图片与图注、表格与表注、警告标题与正文。

**Normalized Content**：由原始解析结果转换得到的类型化规范模型。它是切分和人工结构化修订的输入。

**Search Text**：从规范模型确定性生成的无标签纯文本。它不是原始 HTML，也不是 LLM 改写。

**Embedding Eligibility**：一个 Chunk 是否允许生成 Context 或进入 embedding 输入的内容资格。它与来源定位质量独立。

**Location Quality**：一个来源在当前 Source View 中可定位的质量：`exact`、`page_only`、`parsed_only`、`unavailable`。

**Mapping Quality**：Chunk 与 Content Block 内部内容的映射粒度：`exact`、`cell`、`row`、`block-only`。它与 Location Quality 正交，例如一个表格 Segment 可以是 `mappingQuality=cell` 且 `locationQuality=page_only`。

**Legacy Contract**：缺少本版本规范模型、资格字段或 Source View 信息的旧 V2 工作区数据。Legacy 数据不能被猜测迁移为本版本。

## 4. 支持格式与解析链路

### 4.1 格式白名单

首期支持：

`PDF、PNG、JPG、JPEG、DOCX、PPTX、XLSX、MD、TXT`

旧版 Office 格式和其他格式明确拒绝，并显示原因。

### 4.2 解析输入规则

| 输入 | MinerU 输入 | 左侧主要来源 | 备注 |
| --- | --- | --- | --- |
| PDF | 原始 PDF | 原始 PDF | PDF 页面尺寸以原文件为准 |
| PNG/JPG/JPEG | 原始图片 | 原始图片 | 单页，像素尺寸以原文件为准 |
| DOCX/PPTX/XLSX | 原始 Office 文件 | 独立 Visual Copy | 原文件直接发送 MinerU；Visual Copy 不替代 MinerU 输入 |
| MD | 不发送 MinerU | Markdown 源码/渲染结果/解析结构 | 使用 CommonMark AST |
| TXT | 不发送 MinerU | TXT 源码/解析结构 | 保留纯文本字符范围 |

Office 的流程必须明确分叉：

```text
Office 原文件
  ├─ 直接提交 MinerU，得到 Parsed Document Version
  └─ 独立生成 Visual Copy，供左侧查看
```

Visual Copy 生成失败不阻塞 MinerU、切分、人工修订或导出；文档持续显示 `visual_copy_unavailable` Quality Flag。

### 4.3 Parse Batch 与文档独立性

- 一个 Parse Batch 可包含多个文件。
- 每个 Source Document 独立经历 `pending -> running -> done/failed`。
- 一个文档失败不阻塞同批成功文档。
- MinerU 下载失败、Visual Copy 失败和 Context 单项失败分别隔离。
- Temporary Workspace 默认保留 24 小时，过期后不保证恢复。

## 5. Source View 原文查看器

### 5.1 可用 Source View

每个文档声明实际可用的 Source View，不再统一称为“PDF 原文”。PDF/图片使用原始文件画面；Office 使用独立 Visual Copy；MD/TXT 使用真实源码或解析视图：

| `sourceViewKind` | 适用格式 | 内容 |
| --- | --- | --- |
| `original_file` | PDF、图片 | 不可变原始文件画面 |
| `visual_copy` | DOCX、PPTX、XLSX | 独立只读 PDF 或页面图片 |
| `parsed_document` | 所有已解析格式 | Content Block、阅读顺序和规范结构 |
| `markdown_source` | MD | 源码、行号和字符范围 |
| `markdown_rendered` | MD | CommonMark 渲染结果和 AST Block |
| `txt_source` | TXT | 源码、行号和字符范围 |

用户可以切换可用视图。视图切换只改变展示，不改变 Chunk、Source Segment、Revision 或 Context。

### 5.2 桌面交互

桌面原文查看器必须支持：

- PDF/Visual Copy 连续滚轮滚动；
- 缩放、适宽、实际大小；
- 页码输入、上一页/下一页和缩略页导航；
- 点击 Chunk 滚动到第一个来源；
- 多页 Chunk 在缩略导航中同时标记；
- 当前视口附近页面和 bbox 延迟加载或虚拟化；
- 来源与 Chunk 双向高亮、锁定和 Esc 清除。

PDF 使用真实 MediaBox 页面尺寸，图片使用真实像素尺寸，Visual Copy 使用转换产物的页面尺寸。不得用固定 1000x1414 或 readingOrder 推算 bbox。

### 5.3 Mobile 交互

移动端只要求查看、定位和文本修复，不承诺高效多页圈定。使用分段或 Tab：

`来源文件 / Visual Copy / 解析结果 / Chunk / Context`

移动端不得增加字符级或像素级标注功能。

### 5.4 坐标映射与定位质量

只有以下条件全部满足时，才允许在 `original_file` 或 `visual_copy` 来源画面上绘制 bbox：

1. 来源页面和展示页面一一对应。
2. 页面宽高、单位和方向已记录。
3. 坐标变换矩阵或等价的可验证变换已记录。
4. bbox 范围通过页面边界校验。
5. 对 `original_file`，映射版本与当前 `sourceDocumentVersion` 匹配；对 `visual_copy`，映射版本与当前 `visualCopyVersion` 匹配。

定位质量必须按实际证据声明：

- `exact`：上述条件全部满足，允许精确框覆盖；
- `page_only`：只能证明页码，显示页码但不画框；
- `parsed_only`：只能在 Parsed Document 中定位 Block；
- `unavailable`：没有可用的来源定位。

`parsed_document` 只能使用 `parsed_only`，在 Parsed Document 中定位 Content Block，不画页面 bbox。Markdown/TXT 使用 UTF-16 字符偏移和行号（以解析时保存的源文件版本为准）定位；满足源码版本和范围校验时使用 `locationQuality=exact`，否则降级为 `unavailable`。它们不强制转换为页面 bbox，也不为了得到 bbox 而生成 Visual Copy。

系统绝不近似绘制、不推算缺失坐标、不把解析文本覆盖在原始文件上冒充原文。

## 6. Visual Copy 生命周期

每个 Office Source Document 独立保存：

```text
not_requested -> generating -> ready
                              -> failed
```

Visual Copy 元数据至少包括：

`visualCopyVersion、converter、converterVersion、generatedAt、pageCount、pageDimensions、coordinateMapping、mappingVersion、error`

规则：

- Visual Copy 可单独重试。
- 同一不可变文件内容的重新解析复用现有 Visual Copy。
- 原文件内容变化、Visual Copy 损坏或明确升级转换器时才重建。
- Visual Copy 重建不自动清除 Chunk、Revision 或 Context。
- 若映射质量变化，只更新定位质量和 Quality Flag，不改写文本。
- Visual Copy 失败时默认打开 Parsed Document 视图。

## 7. Parsed Document 与规范化模型

### 7.1 四层表示

每个 Content Block 必须分开保存：

```text
raw                  原始 MinerU/解析器值，只读诊断
normalized           类型化规范模型
display              安全的工作人员阅读表示
searchText           确定性生成的无标签检索文本
normalizationStatus  normalized | partial | unsupported | failed | manual_fixed
```

`display` 只用于工作人员阅读和安全渲染，`displayHtml` 也只属于展示层。初次切分消费 `normalized` 和由其确定性生成的 `searchText`；人工修订后，Context 消费 `reviewedModel` 及其派生 `searchText/finalText`；embedding 只消费最终 `embeddingText`。任何阶段都不得直接消费 `raw`，也不得把 HTML 展示层当作语义输入。每个版本记录 `normalizerVersion` 和 `normalizedModelVersion`。

文本不变量：`automaticText` 是由 `normalized/searchText` 确定性序列化的初始纯文本，首次生成时 `finalText=automaticText`；工作人员保存 `reviewedModel` 后，服务端重算纯文本 `finalText`、展示层和资格字段。`raw`、`display`、`displayHtml` 永远不进入 `automaticText`、`finalText` 或 `embeddingText`。

### 7.2 Content Type

首期一等类型：

`heading、paragraph、list、table、image、formula、code、warning、caption、footnote`

页眉、页脚、页码和解析噪声保留来源记录，但默认 `excludedFromContentFlow=true`。未知类型使用 `unsupported`，不得静默转为 paragraph。

### 7.3 确定性 Search Text 规则

| 类型 | Search Text |
| --- | --- |
| heading/paragraph/list | 保留层级、列表顺序和正文纯文本 |
| warning | 警告级别、标题和正文 |
| image | 图注、商品/型号、已审核 VLM 摘要；图片地址只进元数据 |
| formula | LaTeX，加邻近标题或定义 |
| code | 语言、标题和原始源码，不改写源码 |
| table | 标题、商品/型号范围、表头、逐行字段值、单位和注释 |
| caption/footnote | 附着到所属图片或表格的 Search Text |

除可选的 VLM/Table Enrichment 外，Search Text 不调用 LLM 改写。

### 7.4 原始诊断结果

MinerU 结果只保留诊断所需 allowlist：

- `content_list.json`；
- `full.md`；
- 解析器版本、批次元数据和必要的原始图片/表格结构。

不得保存或导出请求 URL、Authorization、请求头、API Key 或其他运行时秘密。诊断数据与 Temporary Workspace 同期 24 小时过期，不能被切分、Context 或 embedding 流程读取。

## 8. 表格、图片和其他受保护内容

### 8.1 Table Model

`tableModel` 至少包含：

`tableId、title、applicableProduct、columns、headerRows、rows、cellIds、cellText、rowSpan、colSpan、units、notes、footnotes、pageGroups`

每个 Cell/Row 保存原始来源范围。跨页表格共享 `tableId`，按有序 row group 处理，每组重复必要表头，不重复无关行。

表格必须同时保存：

```text
rawTableHtml   原始结构，只读诊断
tableModel     规范化结构
displayHtml    清理后的安全渲染结果
searchText     无 HTML 标签的确定性文本
```

`<tr>`、`<td>` 等标签不得进入普通 Chunk 正文、Context 或 embedding。

`rawTableHtml` 只允许留在诊断存储中，不属于 `normalizedModel` 或 `reviewedModel`，也不得进入普通 Chunk 导出；诊断包可按 allowlist 单独携带它。`displayHtml` 可用于卡片渲染，但不属于语义输入。

默认使用确定性 `tableModel -> searchText`。Table Model Enrichment 是可选策略，必须工作人员明确选择并审核；失败不影响确定性表格文本。

### 8.2 Image Model

Image Chunk 保存稳定 `imageId`、资产引用、图注、所属商品/章节、来源位置和可选 Model Enrichment。图片地址不作为 Search Text。资产不可用时：

- 有可靠图注、商品身份或已审核摘要：仍可 embedding，增加 `image_asset_unavailable` Quality Flag；
- 只有图片且没有可靠文本：`embeddingEligible=false`。

### 8.3 Warning、Formula、Code

- Warning Group 保留级别、标题和正文，普通文本策略不得穿透其结构。
- Formula 保留 LaTeX 和来源；规范化失败时不可 embedding。
- Code 保留语言、标题和源码，禁止自动改写。

### 8.4 Content Group 边界

普通正文、图片/图注、表格/表注和警告相邻时，仍按类型保持独立 Chunk，通过 `relatedChunkIds`、`parentSectionId` 和阅读顺序关联。未知或失败 Block 单独成为受保护 Chunk，不悄悄混入有效正文。

## 9. ID、版本与来源模型

### 9.1 文档版本

系统分别记录：

`sourceDocumentVersion、parsedDocumentVersion、visualCopyVersion、normalizedContentVersion、previewVersion、draftVersion`

重新解析生成新的 Parsed Document Version 和新的 `contentBlockId` 命名空间；不复用旧来源 ID。

### 9.2 Block ID

每个 Block 同时保留：

- `rawBlockId`：MinerU 原始 ID；无原始 ID 时明确标记为位置型、不稳定；
- `contentBlockId`：平台在 Parsed Document Version 内生成的稳定 ID。

人工修订不能改变来源 ID，不能为人工新增事实创建新坐标。

### 9.3 Source Segment

每个 Chunk 保存有序 Source Segment，至少包括：

`sourceDocumentVersion、parsedDocumentVersion、contentBlockId、rawBlockId、sourceViewKind、page、bbox、sourceStart、sourceEnd、chunkStart、chunkEnd、isOverlap、mappingQuality、locationQuality`

字段适用范围必须明确：`rawBlockId` 在原始解析结果没有 ID 时为 `null`；`page`、`bbox` 在非分页来源或无法证明时为 `null`；`sourceStart/sourceEnd` 是对应 Content Block `searchText` 的 UTF-16 半开区间，无法可靠映射时为 `null`；`chunkStart/chunkEnd` 是 Chunk `automaticText` 的 UTF-16 半开区间。任何 `null` 都必须由 `locationQuality`/`mappingQuality` 说明，禁止猜测补齐。Source Segment 是来源事实的权威记录。

人工修改 `finalText` 后，Source Segment 仍锚定不可变的 `automaticText/searchText` 来源；如果人工文本无法保持字符级对应，只降低 `mappingQuality` 或保留 Block 级来源，不伪造新的字符范围或 bbox。

映射质量：

- `exact`：普通正文字符范围精确映射；
- `cell`/`row`：表格按单元格或行组映射；
- `block-only`：只能证明来自某个 Block，不能声称字符级精确。

Chunk 顶层的 `sourceViewKinds[]` 和 `locationQualitySummary` 仅为汇总；跨页面、跨视图或多种定位质量时，以 `sourceSegments` 为准。`locationQualitySummary` 取所有 Segment 的最差等级（`unavailable` > `parsed_only` > `page_only` > `exact`）。

## 10. Chunking Strategy 与 Preview/Draft

继续支持四种策略：

1. Structure-Aware：按 Product Identity、标题、阅读顺序和 Content Group，再对可切文本应用 token 预算。
2. SentenceSplitter：LlamaIndex 句子和段落边界。
3. TokenTextSplitter：LlamaIndex token 预算，项目层维护可追踪 Overlap。
4. Semantic Boundary：项目自有句窗 embedding 距离和百分位边界，不称为 `SemanticSplitterNodeParser`。

参数仍以 token 计量，显示固定 tokenizer 名称和版本。`chunkOverlap < chunkSize`。Protected Content Group 不被普通策略任意跨越或截断。

### 10.1 明确的应用流程

```text
修改参数
  -> 生成新 Preview
  -> 对比质量指标
  -> 采用 Preview
  -> 进入人工修订
```

参数变脏时：

- 旧 Preview 标记为过期；
- 禁止采用旧 Preview；
- 主按钮显示“生成新 Preview”；
- 生成成功后自动切换到新 Preview。

Preview 只读，只允许来源高亮、质量检查和参数比较。只有采用 Preview 后才产生可持久化 Revision。

首次采用 Preview 一次点击完成。替换已有人工 Draft 时，必须二次确认并列出将清除的 Revision 和 Context 数量。

### 10.2 Overlap

Overlap 只发生在同一连续文本流的相邻文本 Chunk。重复来源必须标记 `isOverlap=true`，并保留 Source Segment 定位；不复制图片资产、整张表格或跨保护组内容。

## 11. 人工修订与资格恢复

### 11.1 类型化编辑器

- 普通文本：文本编辑器；
- 表格：单元格、表头、合并关系和注释编辑器；
- 图片：图注和 VLM 摘要编辑器；
- 公式：LaTeX 编辑器；
- 代码：语言和源码编辑器；
- Warning：级别、标题和正文编辑器；
- 未知类型：先选择明确类型，再填写规范字段；
- 无法结构化的内容：可靠纯文本修复入口。

### 11.2 服务端保存边界

保存规范模型时，服务端一次完成：

```text
校验 reviewed model
  -> 生成 display
  -> 生成 searchText/finalText
  -> 重算 token、Quality Flag 和 embedding 资格
  -> 写入 Revision
  -> 使相关 Context stale
```

不允许只改 display HTML 绕过资格校验。`automaticText`、raw 和原始模型不可变。

### 11.3 局部与文档级重算

- 边界和类型不变、只改内容模型：保留 Chunk ID，增加 Revision。
- 类型、来源边界或分组改变：生成新 Chunk ID，记录 `replacedChunkId`。
- 默认只重算受影响 Content Group、Chunk 和相邻关系。
- 若阅读顺序、Product Identity 或跨 Chunk 边界改变：升级为文档级 Preview，按影响范围清除旧 Draft/Context。
- 支持撤销/重做，不建立任意历史版本树。

## 12. Embedding Eligibility 与 Context

### 12.1 资格判断

`locationQuality` 与 `embeddingEligible` 独立判断：

- 缺失 bbox、视觉副本不可用或页码不确定：降低定位质量，不自动阻断 embedding；
- `unsupported`、`failed`、没有可靠 Search Text：阻断 embedding；
- 图片资产缺失但有可靠图注/摘要：允许 embedding；
- 只有图片且无可靠文本：阻断 embedding。

Chunk 至少保存：

`embeddingEligible、embeddingExclusionReasons、qualityFlags`

`qualityFlags` 是提醒集合；`embeddingExclusionReasons` 是硬阻断集合，两者不能混用。

资格矩阵：`normalizationStatus=normalized` 且存在可靠 `searchText` 时可合格；`partial` 只有在人工确认所有缺失字段不影响语义、并生成可靠 `searchText` 后才可合格；`manual_fixed` 只有服务端校验 reviewed model、来源和 Search Text 后才可合格；`unsupported`、`failed` 或没有可靠 Search Text 必须不合格。合格时 `embeddingExclusionReasons=[]`，不合格时至少有一个可解释原因。

### 12.2 Context 生成门禁

- 目标 Chunk 不合格：可以显示 Candidate 推荐，但生成按钮禁用。
- 目标 Chunk 合格、邻居不合格：跳过不合格邻居，继续生成并记录 `contextScope` 和跳过原因。
- Context package 只能读取 normalized/reviewed model、Search Text 和已审核 Enrichment；不读取 raw/diagnostics。
- reviewedModel/finalText、Source Segment 或来源范围、Product Identity、父章节/分组、已审核图片或表格 Enrichment 改变后，相关 Context 变为 `stale`；仅排序、质量标记或展示设置变化不会使其 stale。
- 只有 `confirmed` 或 `human_modified`、且未 stale 的 Context 与合格 Chunk 才可进入 embeddingText。

### 12.3 Embedding 文本

```text
embeddingEligible=false -> embeddingText=null
embeddingEligible=true 且 Context 为 not_generated/generating/awaiting_review/failed/stale
  -> embeddingText=finalText
embeddingEligible=true 且 Context 为 confirmed/human_modified 且非 stale
  -> embeddingText=contextText + finalText
```

Context 永远不覆盖 `finalText`。`contextText` 在未生成、失败或 stale 时可保留供审阅，但必须被忽略（或置为 `null`）且不进入 `embeddingText`；`embeddingText` 是下游 embedding 的输入文本，不等于向量本身。

## 13. Source Document 替换与 Legacy

### 13.1 新文件

同一商品说明书上传新文件时建立新的 Source Document。旧 Source Document 在当前 Temporary Workspace 内标记 `superseded`、只读；不提供正式历史版本树。只有 active Source Document 能生成新 Preview、Context 和 `contractVersion=2.1` 导出；已完成的 superseded 快照可只读导出，但不能生成新派生结果。

### 13.2 Legacy Contract

旧 V2 工作区若缺少规范模型、资格字段或 Source View 状态：

- 标记 `legacy-contract`；
- 允许只读查看和 `contractVersion=legacy` 格式导出；
- 禁止生成新的 Context、embedding 或结构化修订；
- 提供“按 V2.1 重新解析”；
- 重新解析成功后才进入本版本契约；
- 不猜测补齐旧 bbox、规范模型或资格状态。

Legacy 和 V2.1 不允许混合格式导出。批次同时包含两种契约时，导出器必须要求工作人员选择一种格式并生成独立 Manifest；不得把另一种文档静默丢弃。Manifest 必须包含 `contractVersion`、格式和文档状态。

## 14. 导出与诊断包

### 14.1 部分批次导出

一个批次可以导出已完成的 `contractVersion=2.1` 文档。解析和切分已完成但 Visual Copy 失败的文档仍算 `completed`，并保留 `visual_copy_unavailable` Quality Flag；Manifest 必须列出：

Manifest 的 `completed`、`pending`、`failed` 是解析/切分交付状态，不是 Visual Copy 状态；Visual Copy 失败作为文档 Quality Flag 单独记录。每个文档条目同时记录 `contractVersion` 和 `format`。

```text
completed/exported
pending
failed + reason
```

正式 Chunk 数据只包含 completed 文档；pending/failed 不能静默省略，也不能伪造空成功文档。

### 14.2 V2.1 Chunk 导出字段

每个 Chunk 至少包含：

```text
contractVersion
parsedDocumentVersion
normalizationStatus
chunkId
contentType
normalizedModel
reviewedModel
automaticText
finalText
contextText
contextReviewState
embeddingText
embeddingEligible
embeddingExclusionReasons
sourceSegments
sourceViewKinds
locationQualitySummary
mappingQualitySummary
productIdentity
parentSectionId
relatedChunkIds
qualityFlags
revisions
chunkingStrategy
chunkingParameters
parserVersion
normalizerVersion
normalizedModelVersion
embeddingModel
contextModel
contextCandidateReasons
contextScope
skippedNeighborReasons
```

`embeddingText` 对不合格 Chunk 必须为 `null`。导出仍允许存在不合格 Chunk，但页面显著显示数量和原因。
`rawTableHtml`、其他原始 MinerU HTML/JSON 和运行时诊断字段不在普通导出中；`sourceSegments` 是来源与定位的权威字段，顶层数组/汇总字段不得替代它。

### 14.3 诊断包

普通 Chunk 导出默认不包含原始 MinerU HTML/JSON。单独的“下载诊断包”只包含 allowlist 原始内容和版本元数据，24 小时过期，不包含任何请求凭据或运行时秘密，也不能被 Context 或 embedding 使用。

## 15. UI 信息架构

### 15.1 桌面

- 文件栏：Source Document、解析状态、Visual Copy 状态、Chunk 数、Quality Flag 和不合格数量；
- 来源区：动态 Source View 标签、连续查看器、缩放、页码和定位状态；
- Chunk 区：策略配置、Preview/Draft、指标、类型卡片和详情；
- Context 区：Candidate 原因、资格阻断、范围和审核状态；
- 导出区：完成/待处理/失败清单、不合格数量和诊断包入口。

### 15.2 类型卡片

- 表格显示小型规范表格；
- 图片显示缩略图、图注和摘要；
- Warning 显示级别；
- Formula 显示排版结果；
- Code 显示代码预览；
- 所有类型提供“规范文本”查看入口。

### 15.3 交互安全

- 旧 Preview 在参数变脏后不可采用；
- Preview 不可编辑；
- 结构化保存必须服务端校验；
- 不合格 Chunk 的 Context 按钮禁用并显示原因；
- Source View 不可用时不显示伪造框；
- API Key、Authorization 和诊断凭据永不进入浏览器或导出。

## 16. V2.1 验收样本

在 V2 原有八类样本之外，新增固定契约样本：

1. Office 原文件直传 MinerU，Visual Copy 成功；
2. Office Visual Copy 失败但 MinerU 解析可用；
3. MinerU HTML 表格规范化；
4. 公式、代码、Warning 和未知类型；
5. 缺失 bbox、错误坐标和 page-only/parsed-only 定位；
6. Markdown 源字符范围、源码/渲染/解析结构视图；
7. 图片资产缺失与 VLM 摘要恢复；
8. Legacy 批次重新解析迁移；
9. 规范化失败后人工修复并恢复资格；
10. 部分批次 completed/pending/failed 导出。

每个样本记录预期：

`contractVersion、normalizationStatus、embeddingEligible、embeddingExclusionReasons、locationQualitySummary、sourceViewKinds、sourceSegments、export result`

## 17. 功能验收标准

除继承 V2 PRD 第 16 节十二项标准外，V2.1 必须满足：

1. DOCX/PPTX/XLSX 原文件确实直接发送 MinerU，Visual Copy 是独立资产。
2. Visual Copy 失败不阻塞解析、切分、修订或导出，并可单独重试。
3. PDF/图片使用原始文件画面；Office 使用 Visual Copy；MD/TXT 使用真实源码/渲染视图。
4. 连续查看器使用真实页面尺寸，不以解析文本或固定尺寸伪造原文。
5. 只有 §5.4 的五项映射条件全部满足且 `locationQuality=exact` 才绘制 bbox；其他情况正确显示定位降级状态。
6. MinerU HTML 表格不会出现在普通正文、Context 或 embeddingText。
7. 所有首期内容类型都有 normalized/display/searchText，未知类型不会默认变成 paragraph。
8. 规范化失败显示明确状态，不能进入 embedding，且可通过类型化人工修复恢复资格。
9. `qualityFlags` 与 `embeddingExclusionReasons` 独立展示和导出。
10. `embeddingEligible=false` 时 `embeddingText=null`，Context 生成按钮禁用。
11. Context 跳过不合格邻居并记录实际 scope；不读取 raw/diagnostics。
12. 结构化编辑由服务端统一重算 display、Search Text、finalText、指标、资格和 stale Context。
13. 局部修复保留 Chunk ID；边界/类型变化生成新 ID 并记录替换关系。
14. 旧 V2 批次标记 Legacy，不猜测迁移；V2.1 重新解析后才获得新能力。
15. Legacy 与 V2.1 不混合导出；部分批次导出显式列出 pending/failed。
16. 普通导出不含诊断原始结果；诊断包独立、脱敏且 24 小时过期。
17. 新规则或 normalizerVersion 不静默改写旧 Parsed Document。
18. 同一 Content Group 的图片/表格 enrichment 可缓存，源内容变化后正确 stale。
19. 移动端可查看和修复文本，桌面端完成连续来源定位和类型化审阅。
20. 页面、导出和日志不暴露 API Key、Authorization、请求 URL 或诊断秘密。

## 18. 非功能要求

- 桌面端为主要标注环境；移动端不出现横向溢出或不可操作控件。
- 页面和 bbox 按需加载，不能一次渲染所有页面。
- Preview 请求支持取消或忽略过期响应。
- 视觉副本、解析、Chunk、Context 和导出状态自动保存到 Temporary Workspace。
- parser、normalizer、visual converter、tokenizer、embedding、Context 和 prompt 版本可审计。
- 单项失败隔离，不能静默降级为伪造结果。
- 所有导出字段与页面当前状态一致。

## 19. 实施边界与门禁

本文件只确认产品需求，不授权把当前 V2 代码直接标记为 V2.1 完成。实施前必须另立 V2.1 Plan，至少依次通过：

1. 输入与 Visual Copy：Office 直传、视觉副本生命周期、Source View 和坐标映射。
2. 规范化内核：四层表示、类型模型、表格/图片/公式/代码/Warning 和资格门禁。
3. Chunk 与修订：新版本字段、局部重算、ID 关系、Preview/Draft 过期规则。
4. Context 与导出：资格门禁、scope、stale、部分批次 manifest 和诊断包。
5. UI 与迁移：Source View、类型化编辑、Legacy 隔离、桌面/移动浏览器验收。

以上五项是能力域，不是额外增加的产品阶段。若沿用现有四个执行 Plan，应映射为：Plan 01 覆盖输入/Visual Copy、规范化和切分内核；Plan 02 覆盖审阅工作台与人工修订；Plan 03 覆盖 Context 与导出；Plan 04 覆盖迁移、端到端验收以及所有跨域门禁复核。

每个阶段必须先有失败测试或可复现证据，再做最小实现；最终必须运行：

```text
npm test
npm run typecheck
npm run build
```

涉及 UI 时必须使用真实浏览器验证 Office 直传、Visual Copy 成功/失败、原始/解析视图切换、bbox 降级、规范化失败修复、Context 资格、Legacy 隔离和导出一致性，并保存截图、日志和逐项验收证据。

## 20. 当前已知限制

- 本 PRD 尚未宣称 V2.1 已实现。
- MinerU、Office 转换器和真实 PDF/图片样本需要在实施阶段配置和验证。
- 视觉副本转换器、最大并发、超时、Context 模型和 tokenizer 版本属于部署配置，但不能改变本文件的产品语义。
- 无授权的真实客户文档和模型额度不能被伪造为验收证据。
