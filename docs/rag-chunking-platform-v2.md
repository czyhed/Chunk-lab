# 电商文档切分工作台 V2 PRD

## 1. 文档状态

- 状态：已确认（2026-08-12）
- 基线：[RAG 文档切分平台 V1](./rag-chunking-platform-v1.md)
- 目标用户：单一 Data Annotator（数据标注工作人员）
- 主要场景：商品说明书、商品参数表、图文安装说明、安全警告、扫描件、双栏和跨页内容

## 2. 背景与问题

V1 将每个原始 Content Block 独立传给 splitter，再把结果汇总。只要各 Block 都小于 `chunkSize`，就会出现：

- 一个 Block 固定生成一个 Chunk；
- 调整 `chunkSize` 但 Chunk 结构不变；
- 多个短 Block 无法聚合为合理 Chunk；
- 没有真实的相邻文本 Chunk，`chunkOverlap` 无法生效；
- Chunk 只能粗略关联单个 Block，无法表达跨 Block、跨页或 Block 内局部来源。

V2 不把“拼接所有文本”作为修复。商品说明书中的标题、双栏阅读顺序、图片与图注、参数表、警告和型号范围都属于切分语义。系统必须先恢复版面阅读顺序并组装结构化内容，再运行切分策略，同时始终保留精确来源。

## 3. 产品目标

V2 的核心目标是提高工作人员确定文档切分方案和人工兜底的效率：

1. 多个短文本 Block 能按结构聚合，切分参数产生可观察、可解释的效果。
2. 工作人员可选择适合文档的策略并调整该策略专属参数。
3. 原文版面与 Chunk 能双向定位、高亮和圈定来源。
4. 工作人员能确认预览后再拆分、合并、排除、校正和调整来源。
5. 系统推荐可能缺少背景的 Context Candidate，只为工作人员选择的 Chunk 生成 Context Enhancement。
6. Chunk 原文、人工校正、生成 Context 和 embedding 输入彼此分离且可追踪。

V2 不包含正式文档库、多人协作、审核发布、向量数据库、检索评测、任意历史版本树、字符级 PDF 重标注或重新 OCR。

## 4. 核心流程

```text
上传文件
  -> 选择解析配置并运行 MinerU
  -> 查看 Parsed Document 和版面质量提示
  -> 选择策略、参数及多模态策略
  -> 点击“应用参数并生成预览”
  -> 查看 Chunk Preview、双向来源和质量指标
  -> 调参后重新生成，或“确认切分并进入人工修订”
  -> 人工修订 Chunk Draft
  -> 查看 Context Candidate 推荐原因并选择需要增强的 Chunk
  -> 批量或单个生成、审核和修改 Context
  -> 导出当前结果
```

调整控件本身不调用切分接口。只有工作人员点击生成按钮后才产生 Chunk Preview。Preview 可以反复替换；只有再次确认后才形成可人工修改的 Chunk Draft。

## 5. 切分前的文档组装

### 5.1 统一解析模型

切分层只消费统一 Parsed Document，不直接依赖 MinerU 原始结构。Content Block 至少包含：

`id、type、content、page、bbox、readingOrder、parentId、sourceBackend、sourceVersion`

系统必须先根据页码、坐标、阅读顺序、标题关系和内容角色建立连续内容流。双栏内容按逻辑阅读顺序连接，不按同一水平位置交叉拼接；页眉、页脚和已排除噪声不进入内容流。

### 5.2 Content Group

系统组装并展示以下内容组：

- 文本流：标题、段落和列表，可在结构边界内跨短 Block 聚合；
- 图片组：图片、图注和必要的邻近说明；
- 表格组：表名、表格、表下注释和跨页关系；
- 提示组：警告级别、提示标题及其正文；
- Product Identity：商品名称、品牌、型号、变体和适用版本。

图片组、表格组和提示组属于 Protected Content Group。普通文本策略不得任意穿透、截断或把它们与无关正文拼接。

### 5.3 跨页与双栏

- 同一逻辑段落或章节允许跨页形成 Chunk；
- 同一章节左栏末尾可以继续至右栏；
- 不允许把左右栏同行的无关内容交错拼接；
- 阅读顺序不确定时保留当前推断，同时添加 Quality Flag；
- 跨页来源必须保留每页独立 Source Segment。

## 6. Chunking Strategy

所有策略共享版面还原、Content Group 和 Product Identity，不再逐 Content Block 独立执行。

| 策略 | 定义 | 参数 | 适用场景 |
| --- | --- | --- | --- |
| Structure-Aware | 按商品身份、标题层级、阅读顺序和内容组形成边界，再对允许切分的文本应用 token 预算 | 最大 Chunk Token、Overlap Token | 默认；复杂商品说明书 |
| SentenceSplitter | 使用 LlamaIndex 保留句子和段落完整性，在连续文本流内聚合 | 最大 Chunk Token、Overlap Token | 自然语言说明 |
| TokenTextSplitter | 使用 LlamaIndex 严格控制文本 token 上限 | 最大 Chunk Token、Overlap Token | 固定 embedding 预算 |
| Semantic Boundary | 使用项目自有的句窗 embedding 距离和百分位阈值选择语义边界，并以最大 token 预算保护超长结果 | Buffer Size、Breakpoint Percentile、最大 Chunk Token | 主题切换明显的长文本 |

页面显示每种策略的准确实现来源。`Semantic Boundary` 不标注为 LlamaIndex `SemanticSplitterNodeParser`。

### 6.1 参数语义

- 大小和 Overlap 统一以 token 计量，同时辅助显示预计字符数；
- tokenizer 由系统固定，并显示名称和版本；
- 工作人员不能修改 tokenizer、递归分隔符或内部正则；
- `chunkOverlap` 必须小于 `chunkSize`；
- Semantic Boundary 显示实际 embedding 模型和语义距离信号。
- Semantic Boundary 优先采用语义边界；超过最大 token 预算时回退到完整句子边界，并显示“语义边界被预算截断”标记。

### 6.2 默认参数

以下数值是可调整的初始值，不构成产品质量承诺：

| 策略 | 默认参数 |
| --- | --- |
| Structure-Aware | 最大 512 tokens，Overlap 64 tokens |
| SentenceSplitter | 最大 512 tokens，Overlap 64 tokens |
| TokenTextSplitter | 最大 512 tokens，Overlap 64 tokens |
| Semantic Boundary | Buffer Size 1，Breakpoint Percentile 90，最大 768 tokens |

少于 80 tokens 的 Chunk 默认显示“过小”Quality Flag。默认值应在八类固定样本上评估后再调整。

### 6.3 Overlap

Overlap 只发生在同一连续文本流的相邻文本 Chunk 之间：

- 尽量以完整句子为重复单位；
- 不跨章节、图片组、表格组或提示组；
- 不复制图片资产或整张表格；
- 重复内容使用同一来源片段，并在 Source Segment 上标记 `isOverlap`；
- UI 必须区分普通来源与 Overlap 来源。

### 6.4 Protected Content Group 超限

- 超大表格按连续行分组，每组重复表头并保留共同 table ID；
- 长提示组按正文拆分，每个子 Chunk 重复警告标题和级别；
- 图片资产不拆，过长说明文字可按完整句子拆分；
- 无法安全拆分时保持完整并添加“超过 token 预算”Quality Flag；
- 任何内容都不得静默截断。

### 6.5 Chunk 类型与关系

默认分别生成 `Text Chunk`、`Image Chunk` 和 `Table Chunk`。图片标题、表名和必要邻近说明进入对应的多模态 Chunk，但整张表格或图片引用不并入普通文本 Chunk。

Chunk 通过以下信息表达关系：

- `parentSectionId`
- `productIdentity`
- `relatedChunkIds`
- `tableId` 或 `imageId`
- 有序 `sourceSegments`

## 7. Preview、Draft 与参数比较

### 7.1 状态分离

- Configuration Draft：尚未应用的控件值；
- Chunk Preview：点击生成后得到、可以丢弃或替换的提议结果；
- Chunk Draft：工作人员确认 Preview 后得到、允许人工修订的结果。

### 7.2 已有 Draft 时调参

系统同时保留当前 Draft 和一个新 Preview：

- 展示 Chunk 数、token 分布和异常数的变化；
- 工作人员可切换查看旧 Draft 与新 Preview；
- 放弃 Preview 后恢复原 Draft；
- 接受 Preview 会清除旧 Draft 的人工修订和 Context，必须展示影响并二次确认；
- 不建设任意历史版本树。

## 8. 工作台信息架构

### 8.1 桌面布局

- 可收起文件侧栏：文档名、解析状态、Chunk 数、Quality Flag；
- 左侧约 55%：原始 PDF 或图片页面及 MinerU bbox 覆盖层；
- 右侧约 45%：策略参数、质量指标、Chunk 列表和固定详情面板；
- Context Enhancement 位于 Chunk 详情内，与正文分区显示。

桌面端是主要标注环境。小屏只要求查看和文本校正，不承诺高效版面圈定。

### 8.2 双向定位

- 悬停 Chunk：临时高亮全部来源区域；
- 点击 Chunk：锁定高亮，并滚动至第一个来源；
- 悬停来源框：临时高亮关联 Chunk；
- 点击来源框：锁定关联 Chunk并显示关联数量；
- `Esc` 清除锁定；
- 多页 Chunk 在页面缩略导航中同时标记；
- 普通来源、Overlap、人工选择和质量异常使用稳定且不同的视觉编码。

### 8.3 来源圈定

V2 提供 Block 级选择：

- 单击选择一个 Block；
- `Shift` 选择阅读顺序中的连续范围；
- `Ctrl` 增减离散 Block；
- 从选区创建 Chunk；
- 将选区加入当前 Chunk；
- 从当前 Chunk 移除选区；
- 离散选择必须显示来源顺序并要求确认。

任意像素框、字符级 PDF 拖选及重新 OCR 后置。

### 8.4 Chunk 列表与详情

列表卡片显示类型、文本摘要、token 数、来源页、质量标记和 Context 状态。点击卡片后在固定详情面板完成：

- 全文编辑；
- automaticText / finalText 差异查看；
- 拆分、合并、排除和恢复；
- Source Segment 检查与调整；
- Context 生成与审核；
- 撤销、重做和恢复自动结果。

修改自动保存到 Temporary Workspace。

## 9. 人工修订规则

- 文本 Chunk 在光标位置拆分，并重新计算两侧 Source Segment 文本范围；
- 只能合并相邻且兼容的同类型 Chunk；
- 表格行组只能与同一表格的相邻行组合并；
- Image Chunk 不与 Text Chunk 合并；
- 排除是可恢复状态，不物理删除；
- 不允许空 Chunk；
- 合并或内容变化后，相关 Context 标记为 stale；
- automaticText 始终保留，人工修改写入 finalText 和 revision diff；
- 人工文本不伪造新的原始坐标，左侧继续展示其依据的原始来源。

## 10. 精确来源模型

每个 Chunk 保存有序 `SourceSegment[]`，至少包含：

```json
{
  "blockId": "block-12",
  "page": 3,
  "bbox": [72, 144, 516, 238],
  "sourceStart": 18,
  "sourceEnd": 96,
  "chunkStart": 0,
  "chunkEnd": 78,
  "isOverlap": false
}
```

一个 Chunk 可以引用多个 Block 和多个页面；同一个 Block 也可以被多个 Chunk 的不同文本范围引用。双向定位、Overlap 显示、人工拆分和导出都以 Source Segment 为依据，不再只保存 `sourceBlockIds`。

## 11. Chunk Preview 质量指标

每次生成 Preview 后至少展示：

- Chunk 总数；
- token 数最小值、平均值、最大值和分布；
- 过大和过小 Chunk 数；
- Overlap 实际重复比例；
- 跨页 Chunk 数；
- Text、Image、Table Chunk 数；
- 缺少 Product Identity 的 Chunk 数；
- Context Candidate 数。

已有 Draft 时显示新旧指标增减。指标只描述结果，不自动宣称某组参数最好。

## 12. Contextual Retrieval

### 12.1 推荐而非全量生成

系统先用稳定规则标记 Context Candidate，不调用 LLM 做全量判断。推荐条件包括：

- 缺少商品名称、型号或适用版本；
- 只有“安装方法”“注意事项”等通用标题；
- 包含“本产品”“该模式”“上述参数”“如下图”等跨段指代；
- 独立参数表或图片摘要缺少所属商品或功能；
- 从章节中间开始，脱离父标题后含义不完整；
- 多型号并列，当前 Chunk 的适用对象不明确。

页面必须显示推荐原因。工作人员可以选择推荐项，也可以选择任意其他 Chunk。

### 12.2 生成范围

支持单个生成、勾选批量生成和生成当前页面全部推荐项。每个 Chunk 独立显示生成状态，单个失败不阻塞其他任务。

模型参考内容按以下优先级提供：

1. 当前 Chunk 和 Source Segment；
2. 同一 Content Group；
3. 父标题和 Product Identity；
4. 前后相邻文本 Chunk；
5. 已审核的图片或表格摘要。

短文档可以提供完整 Parsed Document。长文档提供 Product Identity、目录或文档摘要、父章节、相邻 Chunk 和当前 Chunk，并在界面展示实际采用的上下文范围。不同商品文档不得混入同一次生成。

### 12.3 输出约束

Context 是独立的 2-4 句背景说明：

- 指明商品、型号、章节或功能；
- 补足原文中被省略的指代；
- 不重复大段 Chunk；
- 不新增原文不存在的参数、单位、适用范围或结论；
- 无法确认时返回“上下文不足”，不得猜测。

### 12.4 审核状态

```text
not_generated -> generating -> awaiting_review
                              -> confirmed
                              -> human_modified
                              -> failed
confirmed / human_modified -> stale
```

工作人员可以人工创建或修改 Context。已有人工修改时重新生成必须二次确认，不自动覆盖。

以下变化使 Context stale：

- finalText 改变；
- Source Segment 增删或范围改变；
- 父章节或 Product Identity 改变；
- 图片或表格摘要改变；
- Chunk 合并或拆分。

仅排序、质量标记或展示设置变化不会使 Context stale。只有 `confirmed` 或 `human_modified` 的 Context 才进入 embeddingText。

## 13. 导出模型

每个 Chunk 至少导出：

```text
chunkId, type, automaticText, finalText,
contextText, contextReviewState, embeddingText,
sourceSegments, productIdentity, parentSectionId,
relatedChunkIds, qualityFlags, revisions,
chunkingStrategy, chunkingParameters,
parserVersion, embeddingModel, contextModel
```

当 Context 状态为 `confirmed` 或 `human_modified` 时：

```text
embeddingText = contextText + finalText
```

否则 `embeddingText = finalText`。Context 永远不覆盖 finalText。导出必须与页面当前状态一致。

## 14. 异常与失效规则

- 解析失败按文档独立重试，不阻塞同批其他文档；
- 生成 Preview 失败时保留当前 Draft；
- Semantic Boundary embedding 调用失败时明确显示错误，不降级为伪语义结果；
- Context 单项失败不阻塞其他项，可重试或人工填写；
- 重新解析会使旧 Parsed Document、Preview、Draft、Revision 和 Context 全部失效；
- 接受新 Preview 会替换 Draft、Revision 和 Context，执行前必须确认影响范围；
- Temporary Workspace 过期规则继续沿用 V1。

## 15. 验收样本

至少固定八类真实或脱敏电商样本，并为每类准备人工标注的阅读顺序、Content Group 和期望 Chunk 边界：

1. 单商品普通说明书；
2. 多型号共用说明书；
3. 图文步骤式安装说明；
4. 大型商品参数表；
5. 跨页参数表；
6. 双栏说明书；
7. 扫描件说明书；
8. 同页包含警告、图片和正文的安全说明。

## 16. 功能验收标准

1. 多个短 Block 能聚合；更改 `chunkSize` 能改变 Chunk 结构。
2. 非零 Overlap 产生可识别、可定位的重复 Source Segment。
3. Sentence、Token、Structure-Aware 和 Semantic Boundary 使用各自准确的参数与实现说明。
4. 任意 Chunk 能双向定位全部来源，跨 Block 和跨页关系不丢失。
5. 双栏阅读顺序正确；不确定结果有持续可见的 Quality Flag。
6. 图片、表格和提示组不会被普通文本策略破坏或静默截断。
7. Preview 可反复替换；已有人工成果不会在未确认时丢失。
8. 拆分、合并、排除、恢复、文本校正、来源调整、撤销和重做可用。
9. Context 推荐原因可见；未选择的 Chunk 不调用 Context LLM。
10. Context 不改写 finalText；stale Context 不进入 embeddingText。
11. LLM 或 embedding 单项失败有明确状态且不静默伪造结果。
12. 导出中的文本、来源、配置、修订、质量标记和 Context 与页面一致。

## 17. 非功能要求

- 主要工作台面向桌面浏览器；
- 预览请求必须支持取消或忽略过期响应，避免旧结果覆盖新配置；
- 大量页面和 bbox 使用虚拟化或按页加载，不能一次渲染全部高亮节点；
- Chunk 和 Context 的状态变更自动保存；
- 模型、解析器、tokenizer 和提示词均记录名称与版本；
- API Key 仅保存在服务端，不进入浏览器或导出包。

## 18. 实施顺序与门禁

后续实施按三个可独立验收的阶段进行：

1. 切分内核：跨 Block 聚合、四种策略、Overlap、Source Segment 和固定样本测试；
2. 工作台：原始页面、bbox 覆盖、双向高亮、Preview/Draft 和人工修订；
3. Contextual Retrieval：候选推荐、选择性生成、审核、失效和导出。

阶段划分用于控制交付风险，不缩减最终范围。整份 V2 PRD 的验收标准全部通过才算完成。

本 PRD 确认不授权自动开始实施。代码和界面变更必须等待产品方后续明确指令。

Context 模型、最大并发和单次超时属于部署配置，将在实施 Contextual Retrieval 前根据可用模型与运行环境确定，不改变本 PRD 的产品行为。
