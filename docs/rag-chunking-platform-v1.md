# RAG 文档切分平台 V1 设计

## 1. 目标与边界

V1 面向一个数据标注员，完成：

`多文件上传 -> 手动开始解析 -> MinerU 解析 -> 选择解析配置 -> 选择 LlamaIndex 切分策略 -> 查看每个文档的 Chunk -> 人工校正 -> 下载 Export Package`

V1 不建设账号权限、正式文档库、历史版本、审核发布、向量库、检索评测或多人协作。服务端只提供有过期时间的 Temporary Workspace。

平台支持的首期文件类型为 PDF、PNG、JPG/JPEG、DOCX、PPTX、XLSX、MD。PDF、图片和 Office 文件经 MinerU 解析；Markdown 直接进入统一 Parsed Document，不强行交给 MinerU。

## 2. 领域模型

- **Parse Batch**：用户一次选择并点击“开始解析”的多个 Source Document 集合。
- **Source Document**：上传文件，内容和版面是不可变来源。
- **Parsed Document**：与单个文件对应的统一解析结果，包含结构、内容、页码、坐标和原始块关系。
- **Content Block**：Parsed Document 中有序且带来源位置的最小单元。表格和图片是受保护的原子块。
- **Chunk Draft**：针对单个 Parsed Document 生成的当前 Chunk 集合。
- **Chunking Configuration**：策略、参数和图片/表格处理策略的组合；可先批量应用，再由单文档覆盖。
- **Chunk Revision**：拆分、合并、排除、排序和文本校正。
- **Export Package**：可下载的批次快照，不是正式数据集或向量索引。

Parsed Document 永远不被人工修改覆盖。人工只修改 Chunk Draft，并保持到原始文件、解析块、页码和坐标的追踪关系。

## 3. 解析流程

### 批次状态

每个文档独立进入：

`待解析 -> 解析中 -> 解析成功 / 解析失败 -> 待配置 -> 自动预览 -> 人工校正 -> 可导出`

一个文件失败不阻塞其他文件进入 Chunk 页面。失败文件可单独重试。

### Parse Configuration

基础设置：

- 文本 / OCR / 自动识别
- 解析精度
- 公式识别
- 表格识别
- 图片和图表分析
- 跨页表格合并

高级设置：

- 语言
- 页面范围
- 必要的识别阈值

MinerU 后端类型、模型路径和底层运行时不交给标注员随意切换；结果必须记录实际后端、模型和版本。

### 统一解析结果

切分层只消费 backend-neutral Parsed Document；MinerU 的原始 JSON 仅用于诊断和追踪。每个 Content Block 至少有：

`id、type、text/html、page、bbox、reading_order、parent_id、source_backend、source_version`

## 4. Chunk 策略

首期提供三种 LlamaIndex 策略：

| 策略                       | 适用场景            | 参数                                                    |
| -------------------------- | ------------------- | ------------------------------------------------------- |
| SentenceSplitter           | 默认的段落/句子切分 | chunk size、overlap                                     |
| TokenTextSplitter          | 需要严格 token 上限 | chunk size、overlap                                     |
| SemanticSplitterNodeParser | 语义边界优先        | buffer size、breakpoint percentile、固定 embedding 模型 |

不同策略使用不同参数表单，不共用一套伪装的滑块。Sentence/Token 修改后防抖重新生成；Semantic 显示计算状态并取消过期请求。任何切分重生成都提示会清除当前人工修改。

## 5. 图片与表格

### 图片

批次或文档级选择：

1. 排除图片
2. 仅保留图片引用
3. VLM 摘要 + 图片引用（默认）

图片生成独立 Image Chunk，包含图片地址、标题、附近上下文、页码/坐标和可选 Model Enrichment。VLM 结果缓存，不因普通 Chunk 参数变化而重跑。

原图资产和后续向量记录分离：未来向量库只保存 embedding、元数据和资产引用，不作为原图的事实来源。

### 表格

普通表格保留 HTML/Markdown、标题、脚注和来源位置，生成独立 Table Chunk。过大的表格可按连续行分组，每组重复表头并保留同一 table ID。跨页表格优先使用 MinerU 合并结果，同时显示原始页范围并允许人工重新合并或拆分。

## 6. 工作台

桌面端使用三栏：

- 左栏：文件列表、解析状态、Chunk 数量、Quality Flag
- 中栏：原文页/版面视图，支持页码和坐标定位
- 右栏：解析配置、切分配置、Chunk 列表、编辑器

点击 Chunk 高亮来源；点击来源定位 Chunk。初次配置必须由标注员选择，可一键应用到所有已解析文档，也可单个文档覆盖。

人工校正支持：

- 光标位置拆分
- 合并相邻兼容 Chunk
- 排除/恢复
- 当前文档内排序
- 文本校正、差异对比、撤销、重做、恢复原文

不允许空 Chunk；图片和表格不能与普通文本直接合并。

## 7. 质量标记

系统和标注员可以标记：

- OCR 低质量
- 阅读顺序异常
- 疑似漏页
- 表格结构异常
- 跨页表格待确认
- 图片摘要待确认
- Chunk 过大、过小或重叠异常

Quality Flag 不阻塞继续校正或导出，但必须随 Export Package 保留。

## 8. 临时工作区与重新生成

Temporary Workspace 保存上传文件、解析结果、图片、模型摘要、Chunk Draft 和当前修订，默认 24 小时后清理。页面刷新或短暂断线可恢复，过期后不承诺找回。

重新运行 MinerU 会使当前 Parsed Document、Chunk Draft 和修订失效；改变已确认的切分策略或参数会使当前 Chunk Revision 失效。两种操作都必须在执行前展示影响并要求确认。

## 9. 导出

Export Package 以 ZIP 下载：每个文档一份 JSON，另附批次清单。Chunk JSON 包含：

`chunk_id、type、final_text、document_id、page、bbox、source_block_ids、strategy、parameters、parser/model versions、automatic_text、revisions、quality_flags`

导出内容必须与页面当前结果一致。

## 10. V1 验收基线

固定六类样本：普通原生 PDF、扫描 PDF、双栏文档、普通表格、跨页表格、图片/说明/正文混排文档。

验收必须证明：

1. 多文件可独立解析，单文件失败不阻塞其他文件。
2. 每个 Chunk 都能定位到文档、页码、坐标和原始块。
3. 三种策略的参数表单和结果确实不同。
4. 批量配置与单文档覆盖互不污染。
5. 图片、表格不会被普通文本切分器破坏。
6. 拆分、合并、文本校正、撤销和恢复可用。
7. 改变配置前会明确提示人工修改将失效。
8. 导出 JSON 与页面结果、质量标记和来源关系一致。

MinerU 精准 API 的 V1 容量基线：单批最多 50 个文件，单文件最多 200 MB 且不超过 200 页；服务端限制并行解析数量，其余排队。

## 11. 明确后置项

正式文档资产库、永久版本、多人协作、审核发布、Embedding/Vector DB、检索评测、模型 A/B 对比、自动事实校验和跨策略修订迁移。
